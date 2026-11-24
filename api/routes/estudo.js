const express = require('express');
const { autenticar } = require('../middleware/auth');
const { Rejeicao } = require('../lib/sync-comum');
const { consultarRevisoes, gerarCiclo, garantirSemanaAtual, previa } = require('../lib/estudo');
const { linhaCronograma } = require('../lib/linhas-estudo');

const router = express.Router();
router.use(autenticar);

router.get('/agenda', async (req, res) => {
  const revisoes = await consultarRevisoes(req.usuarioId);
  res.json({ revisoes: revisoes.map(({ questao_id, vencimento }) => ({
    questao_id, vencimento: vencimento.toISOString().slice(0, 10),
  })) });
});

router.post(['/previa', '/ciclos'], (req, res, next) => {
  if (typeof req.body?.id !== 'string' || !/^[\w:-]{1,100}$/.test(req.body.id)) {
    return res.status(400).json({ erro: 'Informe um identificador válido.' });
  }
  next();
});

router.post('/previa', async (req, res) => {
  const [hard, medium, easy] = await previa(req.usuarioId, req.body.id, req.body);
  res.json({ hard, medium, easy });
});

router.post('/ciclos', async (req, res) => {
  const cronograma = await gerarCiclo(req.usuarioId, req.body.id, req.body);
  res.json({ cronograma: linhaCronograma(cronograma) });
});

router.post('/ciclos/atual', async (req, res) => {
  await garantirSemanaAtual(req.usuarioId, req.body?.deslocamento_utc_min);
  res.json({ ok: true });
});

router.use((erro, req, res, next) => {
  if (erro instanceof Rejeicao) return res.status(400).json({ erro: erro.message });
  return next(erro);
});

module.exports = router;
