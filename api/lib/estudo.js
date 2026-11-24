const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const Usuario = require('../models/Usuario');
const Questao = require('../models/Questao');
const Trilha = require('../models/Trilha');
const Tentativa = require('../models/Tentativa');
const Cronograma = require('../models/Cronograma');
const { Rejeicao, bool01, parseMomento } = require('./sync-comum');
const { deslocamento, diaLocal, calcularRevisao, gerarEtapas, redistribuirCicloAnterior,
  pesosDaSemana, SEMANA_MS, VERSAO_PLANEJAMENTO } = require('./planejamento');

const ordem = { respondidaEm: 1, _id: 1 };
const inversa = { respondidaEm: -1, _id: -1 };

function transacaoDoUsuario(usuarioId, executar) {
  return mongoose.connection.transaction(async session => {
    // O primeiro write serializa respostas/ciclos da mesma conta entre aparelhos.
    const lock = await Usuario.updateOne({ _id: usuarioId }, { $inc: { __v: 1 } }, { session, timestamps: false });
    if (!lock.matchedCount) throw new Rejeicao('Conta não encontrada.');
    return executar(session);
  });
}

async function lerResposta(p, session) {
  if (typeof p.questao_id !== 'string' || !p.questao_id) throw new Rejeicao('Informe a questão.');
  const momento = p.respondida_em === undefined ? new Date() : parseMomento(p.respondida_em);
  if (!momento || momento.getTime() > Date.now() + 86400000) throw new Rejeicao('Data de resposta inválida.');
  const dificuldade = p.dificuldade_informada;
  if (dificuldade != null && (!Number.isInteger(dificuldade) || dificuldade < 1 || dificuldade > 5)) {
    throw new Rejeicao('A dificuldade deve estar entre 1 e 5.');
  }
  const questao = await Questao.findById(p.questao_id).select('gabarito alternativas').session(session).lean();
  if (!questao) throw new Rejeicao('Questão não encontrada.');
  let acertou = bool01(p.acertou); // compatibilidade com a fila de versões anteriores
  if (p.alternativa !== undefined) {
    if (typeof p.alternativa !== 'string' || !/^[A-E]$/.test(p.alternativa) ||
        p.alternativa.charCodeAt(0) - 65 >= questao.alternativas.length) {
      throw new Rejeicao('Alternativa inválida para esta questão.');
    }
    acertou = p.alternativa === questao.gabarito;
  }
  if (acertou === undefined) throw new Rejeicao('Informe a alternativa escolhida ou o resultado.');
  return {
    questaoId: p.questao_id, acertou, respondidaEm: momento, dificuldadeInformada: dificuldade,
    diaEstudo: diaLocal(momento, deslocamento(p.deslocamento_utc_min)),
  };
}

function vizinhos(usuarioId, resposta, id, operador) {
  return {
    usuarioId, questaoId: resposta.questaoId,
    $or: [
      { respondidaEm: { [operador]: resposta.respondidaEm } },
      { respondidaEm: resposta.respondidaEm, _id: { [operador]: id } },
    ],
  };
}

async function previa(usuarioId, id, p) {
  const resposta = await lerResposta(p, null);
  const anterior = await Tentativa.findOne(vizinhos(usuarioId, resposta, id, '$lt')).sort(inversa).lean();
  return [1, 3, 5].map(nivel =>
    calcularRevisao(anterior, resposta.acertou, nivel, resposta.diaEstudo).proximaRevisao.toISOString().slice(0, 10));
}

function salvarTentativa(usuarioId, id, p) {
  return transacaoDoUsuario(usuarioId, async session => {
    const existente = await Tentativa.findById(id).session(session).lean();
    if (existente) {
      if (existente.usuarioId !== usuarioId) throw new Rejeicao('Este id já está em uso.');
      return existente;
    }
    const resposta = await lerResposta(p, session);
    const anterior = await Tentativa.findOne(vizinhos(usuarioId, resposta, id, '$lt')).sort(inversa).session(session).lean();
    const estado = calcularRevisao(anterior, resposta.acertou, resposta.dificuldadeInformada, resposta.diaEstudo);
    const nova = new Tentativa({ _id: id, usuarioId, ...resposta, ...estado });
    await nova.save({ session });
    // Uma fila offline pode chegar fora de ordem. Tentativas do cliente antigo
    // são marcos históricos: conservam a data de revisão já comunicada ao aluno.
    const posteriores = await Tentativa.find(vizinhos(usuarioId, resposta, id, '$gt')).sort(ordem).session(session);
    let ultimo = nova;
    for (const item of posteriores) {
      if (!item.diaEstudo) break;
      item.set(calcularRevisao(ultimo, item.acertou, item.dificuldadeInformada, item.diaEstudo));
      await item.save({ session });
      ultimo = item;
    }
    return nova;
  });
}

function consultarRevisoes(usuarioId, session = null) {
  return Tentativa.aggregate([
    { $match: { usuarioId } },
    { $sort: { questaoId: 1, ...inversa } },
    { $group: { _id: '$questaoId', vencimento: { $first: '$proximaRevisao' } } },
    { $match: { vencimento: { $type: 'date' } } },
    { $lookup: { from: Questao.collection.name, localField: '_id', foreignField: '_id', as: 'questao' } },
    { $unwind: '$questao' },
    { $project: { _id: 0, questao_id: '$_id', materiaId: '$questao.materiaId', vencimento: 1 } },
    { $sort: { vencimento: 1, questao_id: 1 } },
  ]).session(session);
}

function respostasDasSemanas(usuarioId, materias, inicio, fim, offset, session) {
  // diaEstudo é a data civil da resposta. Para registros antigos, deriva o dia pelo fuso.
  return Tentativa.aggregate([
    { $match: { usuarioId, respondidaEm: {
      $gte: new Date(inicio.getTime() - 86400000), $lt: new Date(fim.getTime() + 86400000),
    } } },
    { $set: { dia: { $ifNull: ['$diaEstudo', { $dateTrunc: {
      date: { $add: ['$respondidaEm', offset * 60000] }, unit: 'day',
    } }] } } },
    { $match: { dia: { $gte: inicio, $lt: fim } } },
    { $sort: inversa },
    { $group: { _id: {
      questao: '$questaoId',
      semana: { $floor: { $divide: [{ $subtract: ['$dia', inicio] }, SEMANA_MS] } },
    }, acertou: { $first: '$acertou' }, dificuldade: { $first: '$dificuldadeInformada' } } },
    { $lookup: { from: Questao.collection.name, localField: '_id.questao', foreignField: '_id', as: 'q' } },
    { $unwind: '$q' },
    { $match: { 'q.materiaId': { $in: materias } } },
    { $project: { _id: 0, semana: '$_id.semana', materiaId: '$q.materiaId', acertou: 1, dificuldade: 1 } },
    { $sort: { semana: 1 } },
  ]).session(session);
}

async function gravarCiclo(usuarioId, id, trilhaId, inicio, pesos, session) {
  const agora = new Date();
  const revisoes = await consultarRevisoes(usuarioId, session);
  const etapas = gerarEtapas(pesos, revisoes, inicio);
  await Cronograma.updateOne({ usuarioId, ativo: true }, { $set: { ativo: false, atualizadoEm: agora } }, { session });
  return new Cronograma({
    _id: id, usuarioId, trilhaId, ativo: true, dataInicio: inicio, atualizadoEm: agora, etapas, pesos,
    distribuicaoDiaria: true, versaoPlanejamento: VERSAO_PLANEJAMENTO,
  }).save({ session });
}

async function garantirSemanaAtual(usuarioId, offset) {
  offset = deslocamento(offset);
  const hoje = diaLocal(new Date(), offset);
  const filtro = { usuarioId, ativo: true };
  const inicioAtual = await Cronograma.findOne(filtro).select('dataInicio distribuicaoDiaria versaoPlanejamento').lean();
  const precisaMigrar = ciclo => ciclo.distribuicaoDiaria !== false && (ciclo.versaoPlanejamento ?? 0) < VERSAO_PLANEJAMENTO;
  if (!inicioAtual || (hoje - inicioAtual.dataInicio < SEMANA_MS && !precisaMigrar(inicioAtual))) return;
  await transacaoDoUsuario(usuarioId, async session => {
    // Verifica novamente com o lock: outro aparelho pode ter renovado ou trocado a trilha.
    const atual = await Cronograma.findOne(filtro).session(session).lean();
    if (!atual) return;
    if (hoje - atual.dataInicio < SEMANA_MS) {
      if (precisaMigrar(atual)) {
        const revisoes = atual.versaoPlanejamento === 2 ? [] : await consultarRevisoes(usuarioId, session);
        const etapas = redistribuirCicloAnterior(atual, hoje, revisoes);
        const campos = etapas
          ? { etapas, distribuicaoDiaria: true, versaoPlanejamento: VERSAO_PLANEJAMENTO, atualizadoEm: new Date() }
          : { distribuicaoDiaria: false };
        await Cronograma.updateOne({ _id: atual._id }, { $set: campos, $inc: { __v: 1 } }, { session });
      }
      return;
    }
    const semanas = Math.floor((hoje - atual.dataInicio) / SEMANA_MS);
    const inicio = new Date(atual.dataInicio.getTime() + semanas * SEMANA_MS);
    const trilha = await Trilha.findById(atual.trilhaId).session(session).lean();
    if (!trilha?.materias.length) return;
    const materias = trilha.materias.map(m => m._id);
    const respostas = await respostasDasSemanas(usuarioId, materias, atual.dataInicio, inicio, offset, session);
    const pesos = pesosDaSemana(materias, atual.pesos ?? [], respostas);
    await gravarCiclo(usuarioId, randomUUID(), trilha._id, inicio, pesos, session);
  });
}

function gerarCiclo(usuarioId, id, p, sessaoCadastro) {
  if (typeof p.trilha_id !== 'string' || !p.trilha_id) throw new Rejeicao('Informe a trilha.');
  const agora = new Date();
  const inicio = diaLocal(agora, deslocamento(p.deslocamento_utc_min));
  async function criar(session) {
    const existente = await Cronograma.findById(id).session(session).lean();
    if (existente) {
      if (existente.usuarioId !== usuarioId || existente.trilhaId !== p.trilha_id) {
        throw new Rejeicao('Id de ciclo já utilizado.');
      }
      return existente;
    }
    const trilha = await Trilha.findById(p.trilha_id).session(session).lean();
    if (!trilha?.materias.length) throw new Rejeicao('A trilha precisa ter matérias para gerar um ciclo.');
    const pesos = trilha.materias.map(m => ({ materiaId: m._id, peso: 1 }));
    return gravarCiclo(usuarioId, id, trilha._id, inicio, pesos, session);
  }
  return sessaoCadastro ? criar(sessaoCadastro) : transacaoDoUsuario(usuarioId, criar);
}

module.exports = { salvarTentativa, consultarRevisoes, gerarCiclo, garantirSemanaAtual, previa };
