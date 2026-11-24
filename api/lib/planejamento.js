const { randomUUID } = require('node:crypto');
const { Rejeicao } = require('./sync-comum');

function deslocamento(valor = -180) {
  if (!Number.isInteger(valor) || Math.abs(valor) > 840) {
    throw new Rejeicao('Informe um deslocamento UTC válido em minutos.');
  }
  return valor;
}

// Dias civis ficam no Mongo como meia-noite UTC, assim como no GET /sync.
function diaLocal(instante, offset) {
  const data = new Date(instante.getTime() + deslocamento(offset) * 60000);
  data.setUTCHours(0, 0, 0, 0);
  return data;
}

function somarDias(dia, dias) {
  const data = new Date(dia);
  data.setUTCDate(data.getUTCDate() + dias);
  return data;
}

// Variação invertida do fator de facilidade do SM-2. Um erro aumenta o sinal de dificuldade.
function sinalDificuldade(acertou, dificuldade) {
  const nivel = dificuldade ?? 3;
  const nota = (acertou ? 3 : 0) + (nivel <= 2 ? 0 : nivel === 3 ? 1 : 2);
  const distancia = 5 - nota;
  return distancia * (0.08 + distancia * 0.02) - 0.1;
}

// SM-2 adaptado ao cronograma diário: https://super-memory.com/english/ol/sm2.htm
function calcularRevisao(anterior, acertou, dificuldade, dia) {
  const facilidade = anterior?.fatorFacilidade ?? 2.5;
  if (acertou && anterior?.proximaRevisao > dia) {
    return {
      repeticoes: anterior.repeticoes, intervaloDias: anterior.intervaloDias,
      fatorFacilidade: facilidade, proximaRevisao: anterior.proximaRevisao,
    };
  }
  const fator = facilidade - sinalDificuldade(acertou, dificuldade);
  const repeticoes = acertou ? (anterior?.repeticoes ?? 0) + 1 : 0;
  let intervaloDias = 1;
  if (repeticoes === 2) intervaloDias = 6;
  if (repeticoes > 2) {
    intervaloDias = Math.min(365, Math.ceil(Math.max(1, anterior.intervaloDias) * facilidade));
  }
  return {
    repeticoes, intervaloDias, fatorFacilidade: Number(Math.max(1.3, fator).toFixed(2)),
    proximaRevisao: somarDias(dia, intervaloDias),
  };
}

const DIAS_DO_CICLO = 7;
const SEMANA_MS = DIAS_DO_CICLO * 86400000;
const BLOCOS_POR_DIA = 4;
const MINUTOS_POR_BLOCO = 60;
const PAUSA_MIN = 15;
const VERSAO_PLANEJAMENTO = 3;

function pausaAposBloco(indice) {
  return (indice + 1) * MINUTOS_POR_BLOCO === 120 ? PAUSA_MIN : 0;
}

// Recebe a última resposta de cada questão por semana, em ordem de semana.
function pesosDaSemana(materias, anteriores, respostas) {
  const pesos = new Map(anteriores.map(p => [p.materiaId, p.peso]));
  const sinais = new Map();
  let semana;
  function fecharSemana() {
    for (const [id, { soma, n }] of sinais) {
      const anterior = pesos.get(id) ?? 1;
      const alvo = 1 + 2 * soma / n;
      pesos.set(id, anterior + n / (n + 4) * (alvo - anterior));
    }
    sinais.clear();
  }
  for (const resposta of respostas) {
    if (resposta.semana !== semana) {
      fecharSemana();
      semana = resposta.semana;
    }
    const sinal = sinais.get(resposta.materiaId) ?? { soma: 0, n: 0 };
    sinal.soma += sinalDificuldade(resposta.acertou, resposta.dificuldade);
    sinal.n++;
    sinais.set(resposta.materiaId, sinal);
  }
  fecharSemana();
  return materias.map(materiaId => ({ materiaId, peso: pesos.get(materiaId) ?? 1 }));
}

// Sainte-Laguë: n blocos já atribuídos reduzem a prioridade da matéria para peso / (2n + 1).
function cotasDeBlocos(pesos, dias, inicio) {
  if (!pesos.length || pesos.some(m => !Number.isFinite(m.peso) || m.peso <= 0) ||
      new Set(pesos.map(m => m.materiaId)).size !== pesos.length) {
    throw new Rejeicao('Cada matéria do ciclo precisa ter um único peso positivo.');
  }
  const limite = dias * (pesos.length === 1 ? BLOCOS_POR_DIA : 2);
  // Alterna quem recebe o bloco indivisível em semanas com pesos iguais.
  const primeiro = Math.floor(inicio.getTime() / SEMANA_MS) % pesos.length;
  const cotas = [...pesos.slice(primeiro), ...pesos.slice(0, primeiro)]
    .map(({ materiaId, peso }) => ({ materiaId, peso, saldo: 0 }));
  for (let i = 0; i < dias * BLOCOS_POR_DIA; i++) {
    let melhor;
    for (const cota of cotas) {
      if (cota.saldo === limite) continue;
      if (!melhor || cota.peso / (2 * cota.saldo + 1) > melhor.peso / (2 * melhor.saldo + 1)) {
        melhor = cota;
      }
    }
    melhor.saldo++;
  }
  return cotas;
}

function diasDoCiclo(inicio) {
  return Array.from({ length: DIAS_DO_CICLO }, (_, i) => somarDias(inicio, i));
}

function distribuirDias(pesos, dias, revisoes, inicio) {
  const cotas = cotasDeBlocos(pesos, dias.length, inicio);
  const contagens = new Map();
  for (const { materiaId, vencimento } of revisoes) {
    const dia = Math.max(+(dias[0] ?? inicio), +vencimento);
    const porMateria = contagens.get(dia) ?? new Map();
    porMateria.set(materiaId, (porMateria.get(materiaId) ?? 0) + 1);
    contagens.set(dia, porMateria);
  }
  const etapas = [];
  for (const [i, data] of dias.entries()) {
    const contagem = contagens.get(data.getTime());
    const restantes = dias.length - i;
    const materias = cotas.map(cota => ({
      cota, blocos: Math.floor(cota.saldo / restantes), resto: cota.saldo % restantes,
      revisoes: contagem?.get(cota.materiaId) ?? 0,
    }));
    const faltam = BLOCOS_POR_DIA - materias.reduce((total, m) => total + m.blocos, 0);
    materias.sort((a, b) => b.resto - a.resto || b.revisoes - a.revisoes);
    for (const materia of materias.slice(0, faltam)) materia.blocos++;

    let anterior;
    for (let bloco = 0; bloco < BLOCOS_POR_DIA; bloco++) {
      const disponiveis = materias.filter(m => m.blocos > 0)
        .sort((a, b) => b.blocos - a.blocos || b.revisoes - a.revisoes);
      const atual = disponiveis.find(m => m !== anterior) ?? disponiveis[0];
      etapas.push({ _id: randomUUID(), materiaId: atual.cota.materiaId, data, duracaoMin: MINUTOS_POR_BLOCO,
        pausaMin: pausaAposBloco(bloco), concluida: false });
      atual.cota.saldo--;
      atual.blocos--;
      anterior = atual;
    }
  }
  return etapas;
}

function gerarEtapas(pesos, revisoes, inicio) {
  return distribuirDias(pesos, diasDoCiclo(inicio), revisoes, inicio);
}

function redistribuirCicloAnterior({ dataInicio, pesos, etapas, distribuicaoDiaria, versaoPlanejamento }, hoje, revisoes) {
  // O gerador anterior criava pesos sem timestamp de edição e etapas com UUID e pausa de 15 min.
  if (!pesos?.length || !etapas?.length) return null;
  if (!distribuicaoDiaria && pesos.some(p => p.atualizadoEm)) return null;
  const materias = new Set(pesos.map(p => p.materiaId));
  const dias = diasDoCiclo(dataInicio);
  const anteriores = new Map(dias.map(d => [+d, []]));
  for (const etapa of etapas) {
    const lista = anteriores.get(+etapa.data);
    if (!lista) return null;
    if (!distribuicaoDiaria && (!materias.has(etapa.materiaId) || etapa.pausaMin !== 15 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(etapa._id))) return null;
    lista.push(etapa);
  }
  const livres = [];
  const resultado = [];
  for (const dia of dias) {
    const lista = anteriores.get(+dia);
    if (versaoPlanejamento === 2) {
      const pausasAntigas = lista.length === BLOCOS_POR_DIA && lista.every((e, i) =>
        e.duracaoMin === MINUTOS_POR_BLOCO && e.pausaMin === (i < BLOCOS_POR_DIA - 1 ? PAUSA_MIN : 0));
      if (dia >= hoje && pausasAntigas && lista.some(e => !e.concluida)) {
        resultado.push(...lista.map((e, i) => ({ ...e, pausaMin: pausaAposBloco(i) })));
      } else {
        resultado.push(...lista);
      }
      continue;
    }
    const cargaAnterior = lista.reduce((soma, e) => soma + e.duracaoMin, 0);
    if (!distribuicaoDiaria && cargaAnterior !== 60) return null;
    if (dia < hoje || cargaAnterior !== 60 || lista.some(e => e.concluida || e.atualizadoEm)) {
      resultado.push(...lista);
    } else {
      livres.push(dia);
    }
  }
  if (!livres.length) return resultado;
  for (const etapa of distribuirDias(pesos, livres, revisoes, dataInicio)) {
    const lista = anteriores.get(+etapa.data);
    const indice = lista.findIndex(e => e.materiaId === etapa.materiaId);
    if (indice !== -1) etapa._id = lista.splice(indice, 1)[0]._id;
    resultado.push(etapa);
  }
  return resultado.sort((a, b) => a.data - b.data);
}

module.exports = { deslocamento, diaLocal, calcularRevisao, gerarEtapas, redistribuirCicloAnterior, pesosDaSemana, SEMANA_MS, VERSAO_PLANEJAMENTO };
