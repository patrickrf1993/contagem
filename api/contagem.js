// Função do Vercel: guarda e devolve as contagens do dia no Upstash Redis.
// Variáveis de ambiente necessárias (Settings > Environment Variables):
//   CODIGO_ACESSO               código que a equipe digita na página
//   KV_REST_API_URL / KV_REST_API_TOKEN   (criadas ao conectar o Upstash)
//   ou UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN

const DB_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const DB_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const CODIGO = process.env.CODIGO_ACESSO;
const VALIDADE = String(400 * 24 * 3600); // guarda cada dia por ~400 dias

async function redis(cmds) {
  const r = await fetch(DB_URL.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + DB_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds)
  });
  if (!r.ok) throw new Error('banco respondeu ' + r.status);
  const out = await r.json();
  return out.map(x => { if (x.error) throw new Error(x.error); return x.result; });
}

const num = v => (typeof v === 'number' && isFinite(v) && v >= 0) ? v : null;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.query && req.query.ping !== undefined) {
    return res.status(200).json({ ok: true, banco: !!(DB_URL && DB_TOKEN), codigo: !!CODIGO });
  }
  if (!DB_URL || !DB_TOKEN || !CODIGO) return res.status(500).json({ erro: 'configuracao' });
  if ((req.headers['x-codigo'] || '') !== CODIGO) return res.status(401).json({ erro: 'codigo' });

  const body = (req.method === 'POST' && req.body && typeof req.body === 'object') ? req.body : {};
  const data = String((req.method === 'GET' ? req.query.data : body.data) || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return res.status(400).json({ erro: 'data' });
  const kItens = 'cont:' + data, kVer = 'ver:' + data;

  try {
    if (req.method === 'GET') {
      const [v] = await redis([['GET', kVer]]);
      const ver = Number(v || 0);
      if (req.query.v !== undefined && String(ver) === String(req.query.v)) return res.status(200).json({ v: ver });
      const [flat, v2] = await redis([['HGETALL', kItens], ['GET', kVer]]);
      const itens = {};
      for (let i = 0; i + 1 < (flat || []).length; i += 2) {
        try { itens[flat[i]] = JSON.parse(flat[i + 1]); } catch (e) {}
      }
      return res.status(200).json({ v: Number(v2 || 0), itens });
    }

    if (req.method === 'POST') {
      const entradas = Object.entries(body.itens || {});
      if (!entradas.length || entradas.length > 200) return res.status(400).json({ erro: 'itens' });
      const cmds = [];
      for (const [k, val] of entradas) {
        if (!/^[A-Z]{2,12}:r\d{1,4}$/.test(k)) return res.status(400).json({ erro: 'chave' });
        if (val === null) { cmds.push(['HDEL', kItens, k]); continue; }
        const total = num(val.total), q = num(val.q), m = val.m == null ? null : num(val.m);
        if (total === null || q === null) return res.status(400).json({ erro: 'valor' });
        const reg = { q, m, total, by: String(val.by || '').slice(0, 60), t: Date.now() };
        cmds.push(['HSET', kItens, k, JSON.stringify(reg)]);
      }
      cmds.push(['INCR', kVer], ['EXPIRE', kItens, VALIDADE], ['EXPIRE', kVer, VALIDADE]);
      const out = await redis(cmds);
      return res.status(200).json({ v: out[out.length - 3] });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ erro: 'metodo' });
  } catch (e) {
    return res.status(502).json({ erro: 'banco', detalhe: String(e.message || e) });
  }
};
