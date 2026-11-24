// Executar apontando TEST_REPLICA_URI para um replica set de testes.
// Usa somente uma base com nome aleatório, sem carregar o .env da API.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const Usuario = require('../models/Usuario');
const Trilha = require('../models/Trilha');
const Questao = require('../models/Questao');
const Cronograma = require('../models/Cronograma');

test('API de estudo persiste, recupera e isola cronogramas e revisões', { skip: !process.env.TEST_REPLICA_URI }, async t => {
  const dbName = 'teste_estudo_' + randomUUID().replaceAll('-', '');
  await mongoose.connect(process.env.TEST_REPLICA_URI, { dbName, serverSelectionTimeoutMS: 5000 });
  const app = express();
  app.use(express.json());
  app.use('/auth', require('../routes/auth'));
  app.use('/sync', require('../routes/sync'));
  app.use('/estudo', require('../routes/estudo'));
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    if (mongoose.connection.name === dbName) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  await new Promise(resolve => server.once('listening', resolve));
  await Promise.all(Object.values(mongoose.models).map(model => model.init()));
  await Usuario.create(['u1', 'u2'].map(id => ({ _id: id, nome: id, email: id + '@example.org', provedorLogin: 'google' })));
  await Trilha.create({ _id: 'ti', nome: 'TI', materias: [{ _id: 'm', nome: 'Dados' }] });
  await Questao.create({ _id: 'q', materiaId: 'm', temaId: 'tema', enunciado: 'Q?',
    alternativas: ['A', 'B'], gabarito: 'B', banca: 'Teste', ano: 2025 });
  process.env.JWT_SECRET = randomUUID();

  async function api(path, body, user = 'u1', status = 200) {
    const token = jwt.sign({ sub: user, v: 0 }, process.env.JWT_SECRET);
    const res = await fetch('http://127.0.0.1:' + server.address().port + path, {
      method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    const value = await res.json();
    assert.equal(res.status, status, JSON.stringify(value));
    return value;
  }
  await Trilha.create({ _id: 'segunda', nome: 'Segunda trilha', materias: [
    { _id: 'r', nome: 'Redes' }, { _id: 's', nome: 'Segurança' },
  ] });
  await Trilha.create({ _id: 'vazia', nome: 'Sem matérias' });
  const cadastro = { email: 'nova@example.org', nome: 'Nova', senha: 'senha-de-teste' };
  for (const trilha_id of [undefined, 'inexistente', 'vazia']) {
    await api('/auth/cadastro', { ...cadastro, trilha_id }, 'u1', 400);
    assert.equal(await Usuario.countDocuments({ email: cadastro.email }), 0);
  }
  const conta = await api('/auth/cadastro', { ...cadastro, trilha_id: 'segunda' }, 'u1', 201);
  const [inicial] = (await api('/sync', undefined, conta.usuario.id)).cronogramas;
  assert.equal(inicial.ativo, 1);
  assert.equal(inicial.trilha_id, 'segunda');
  assert.deepEqual(inicial.pesos.map(p => [p.materia_id, p.peso]), [['r', 1], ['s', 1]]);
  for (const id of ['r', 's']) {
    const blocos = inicial.etapas.filter(e => e.materia_id === id);
    assert.equal(new Set(blocos.map(e => e.data)).size, 7);
    assert.equal(blocos.length, 14);
    assert.ok(blocos.every(e => e.duracao_min === 60));
  }
  // Mesma conta criada com o gerador antigo e reaberta por dois aparelhos.
  const dias = [...new Set(inicial.etapas.map(e => e.data))];
  for (const dia of dias) {
    assert.deepEqual(inicial.etapas.filter(e => e.data === dia).map(e => e.pausa_min), [0, 15, 0, 0]);
  }
  const antigas = dias.flatMap((dia, indice) => {
    const materias = indice === 6 ? ['r', 's'] : [indice % 2 ? 's' : 'r'];
    return materias.map(materiaId => ({ _id: randomUUID(), materiaId, data: new Date(dia),
      duracaoMin: 60 / materias.length, pausaMin: 15, concluida: false }));
  });
  await Cronograma.updateOne({ _id: inicial.id }, { $unset: { versaoPlanejamento: 1 }, $set: { etapas: antigas } });
  const carregar = () => api('/estudo/ciclos/atual', { deslocamento_utc_min: -180 }, conta.usuario.id);
  await Promise.all([carregar(), carregar()]);
  const [migrado] = (await api('/sync', undefined, conta.usuario.id)).cronogramas;
  assert.equal(migrado.id, inicial.id);
  assert.equal(migrado.etapas.length, 28);
  assert.ok(migrado.etapas.every(e => e.duracao_min === 60));
  assert.ok(antigas.every(antiga => migrado.etapas.some(e => e.id === antiga._id)));
  await carregar();
  assert.deepEqual((await api('/sync', undefined, conta.usuario.id)).cronogramas, [migrado]);
  const cicloAnterior = await Cronograma.findById(inicial.id).lean();
  const etapasComTresPausas = cicloAnterior.etapas.map((e, i) => ({ ...e, pausaMin: i % 4 === 3 ? 0 : 15 }));
  await Cronograma.updateOne({ _id: inicial.id }, { $set: { etapas: etapasComTresPausas, versaoPlanejamento: 2 } });
  await carregar();
  const [corrigido] = (await api('/sync', undefined, conta.usuario.id)).cronogramas;
  assert.deepEqual(corrigido.etapas.map(e => [e.id, e.pausa_min]), migrado.etapas.map(e => [e.id, e.pausa_min]));
  const troca = await api('/estudo/ciclos', { id: 'troca', trilha_id: 'ti' }, conta.usuario.id);
  assert.deepEqual(troca.cronograma.pesos.map(p => [p.materia_id, p.peso]), [['m', 1]]);
  const payload = { questao_id: 'q', alternativa: 'B', dificuldade_informada: 3,
    respondida_em: '2025-01-02T01:00:00Z', deslocamento_utc_min: -180,
    acertou: 0, repeticoes: 50, intervalo_dias: 300, proxima_revisao: '2099-01-01' };
  const salvar = async (id, p) => (await api('/sync', { operacoes: [
    { id: 1, entidade: 'tentativa_exercicio', entidade_id: id, operacao: 'insert', payload: p },
  ] })).resultados[0];
  const previa = await api('/estudo/previa', { id: 't1', ...payload });
  const t1 = await salvar('t1', payload);
  assert.equal(t1.tentativa.acertou, 1);
  assert.equal(t1.tentativa.intervalo_dias, 1);
  assert.equal(t1.tentativa.proxima_revisao, previa.medium);
  assert.equal(previa.medium, '2025-01-02');
  const ultima = { ...payload, respondida_em: '2025-01-09T12:00:00Z' };
  await Promise.all([salvar('t3', ultima), salvar('t3', ultima)]);
  await salvar('t2', { ...payload, respondida_em: '2025-01-02T12:00:00Z' });
  const agenda = await api('/estudo/agenda');
  assert.deepEqual(agenda.revisoes, [{ questao_id: 'q', vencimento: '2025-01-24' }]);
  assert.deepEqual((await api('/estudo/agenda', undefined, 'u2')).revisoes, []);
  const ciclo = id => api('/estudo/ciclos', { id, trilha_id: 'ti' });
  const primeiro = await ciclo('c1');
  assert.equal(primeiro.cronograma.etapas.length, 28);
  await api('/estudo/ciclos', { id: 'invalido', trilha_id: 'ausente' }, 'u1', 400);
  const [segundo, reenvio] = await Promise.all([ciclo('c2'), ciclo('c2')]);
  assert.deepEqual(reenvio, segundo);
  const sync = await api('/sync');
  assert.equal(sync.tentativas.length, 3);
  assert.equal(sync.cronogramas.length, 2);
  assert.equal(sync.cronogramas.find(c => c.id === 'c1').ativo, 0);
  assert.deepEqual(sync.cronogramas.find(c => c.ativo), segundo.cronograma);
  assert.equal((await api('/sync', undefined, 'u2')).cronogramas.length, 0);

  // Reproduz uma conta existente com o ciclo encerrado e histórico anterior a diaEstudo.
  const Tentativa = require('../models/Tentativa');
  const hoje = new Date();
  hoje.setUTCHours(0, 0, 0, 0);
  const inicio = new Date(hoje.getTime() - 7 * 86400000);
  await Cronograma.updateOne({ _id: 'c2' }, { $set: { dataInicio: inicio } });
  await Tentativa.create([
    { _id: 'semana-1', usuarioId: 'u1', questaoId: 'q', respondidaEm: inicio, acertou: true, dificuldadeInformada: 5 },
    { _id: 'semana-2', usuarioId: 'u1', questaoId: 'q', respondidaEm: new Date(+inicio + 60000), acertou: false, dificuldadeInformada: 3 },
    { _id: 'semana-aberta', usuarioId: 'u1', questaoId: 'q', respondidaEm: hoje, acertou: true, dificuldadeInformada: 5 },
    { _id: 'outro-aluno', usuarioId: 'u2', questaoId: 'q', respondidaEm: inicio, acertou: true, dificuldadeInformada: 5 },
  ]);
  const renovar = () => api('/estudo/ciclos/atual', { deslocamento_utc_min: 0 });
  await Promise.all([renovar(), renovar()]);
  const ciclos = (await api('/sync')).cronogramas;
  assert.equal(ciclos.length, 3);
  const [aberto] = ciclos.filter(c => c.ativo);
  assert.equal(aberto.data_inicio, hoje.toISOString().slice(0, 10));
  assert.ok(Math.abs(aberto.pesos[0].peso - 1.216) < 1e-9);
  assert.equal(ciclos.find(c => c.id === 'c2').pesos[0].peso, 1);
});
