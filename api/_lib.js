// Funções compartilhadas pelas rotas da API (arquivos com "_" não viram rota no Vercel).
const crypto = require('crypto');

const DB_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const DB_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN_U = String(process.env.ADMIN_USUARIO || '').trim().toLowerCase();
const ADMIN_S = String(process.env.ADMIN_SENHA || '');
const ADMIN_NOME = String(process.env.ADMIN_NOME || 'Administrador');

const DEPS = ['ALMOX', 'ETE', 'TMP', 'MAQUINA', 'EMBALAGEM'];
const DEP_NOME = { ALMOX: 'Almoxarifado', ETE: 'ETE', TMP: 'TMP', MAQUINA: 'Máquina', EMBALAGEM: 'Embalagem' };
const nomesDeps = d => (d || []).map(x => DEP_NOME[x] || x).join(', ') || 'nenhum';
const LOG_DIAS = 5;                       // relatório guarda os últimos 5 dias
const CONT_VALIDADE = String(400 * 86400);
const SESSAO_DIAS = 30;
const SESSAO_TTL = 120;          // segundos sem sinal para liberar o login em outro aparelho
const SESSAO_RENOVA = 30000;     // renova o sinal no máximo a cada 30 s
const SID_ENCERRADA = 'encerrada'; // marca deixada quando o administrador encerra a sessão

const configOk = () => !!(DB_URL && DB_TOKEN && ADMIN_U && ADMIN_S);

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

/* ---------- sessão assinada ---------- */
const chave = () => crypto.createHash('sha256').update('sessao|' + ADMIN_S + '|' + DB_TOKEN).digest();
function assinar(p) {
  const b = Buffer.from(JSON.stringify(p)).toString('base64url');
  return b + '.' + crypto.createHmac('sha256', chave()).update(b).digest('base64url');
}
function conferirToken(tok) {
  const [b, s] = String(tok || '').split('.');
  if (!b || !s) return null;
  const e = crypto.createHmac('sha256', chave()).update(b).digest('base64url');
  if (s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null;
  try { const p = JSON.parse(Buffer.from(b, 'base64url').toString()); return p.exp > Date.now() ? p : null; }
  catch (e) { return null; }
}
const novoToken = (u, sid) => assinar({ u: u.login, v: u.v || 0, s: sid, exp: Date.now() + SESSAO_DIAS * 86400000 });
const novoSid = () => crypto.randomBytes(12).toString('hex');
function aparelho(req) {
  const ua = String(req.headers['user-agent'] || '');
  const so = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'aparelho';
  const nav = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return so + (nav ? ' · ' + nav : '');
}
const cmdSessao = (login, sid, ap) => ['SET', 'sessao:' + login, JSON.stringify({ sid, t: Date.now(), ap }), 'EX', String(SESSAO_TTL)];

/* ---------- senhas ---------- */
function hashSenha(senha, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  return { salt, h: crypto.scryptSync(String(senha), salt, 32).toString('hex') };
}
function senhaConfere(senha, rec) {
  if (!rec || !rec.salt || !rec.h) return false;
  const { h } = hashSenha(senha, rec.salt);
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(rec.h, 'hex'));
}
function iguais(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

/* ---------- usuários ---------- */
function mestre() { return { login: ADMIN_U, nome: ADMIN_NOME, admin: true, ativo: true, deps: DEPS.slice(), v: 0 }; }
async function lerUsuario(login) {
  login = String(login || '').toLowerCase();
  if (login === ADMIN_U) return mestre();
  const [r] = await redis([['HGET', 'usuarios', login]]);
  if (!r) return null;
  const u = JSON.parse(r);
  return { ...u, login, admin: false };
}
const perfil = u => ({ login: u.login, nome: u.nome, admin: !!u.admin, deps: u.deps || [] });

// opcoes.escrita: aceita gravações de um aparelho que ficou sem sinal e perdeu a vez,
// para que as contagens guardadas nele não se percam.
async function exigirUsuario(req, res, opcoes) {
  const escrita = !!(opcoes && opcoes.escrita);
  const p = conferirToken(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  if (!p) { res.status(401).json({ erro: 'sessao' }); return null; }
  const login = String(p.u || '').toLowerCase();
  let u, sess = null;
  if (login === ADMIN_U) u = mestre();
  else {
    const [r, sr] = await redis([['HGET', 'usuarios', login], ['GET', 'sessao:' + login]]);
    u = r ? { ...JSON.parse(r), login, admin: false } : null;
    try { sess = sr ? JSON.parse(sr) : null; } catch (e) { sess = null; }
  }
  if (!u) { res.status(401).json({ erro: 'sessao' }); return null; }
  if (!u.ativo) { res.status(403).json({ erro: 'bloqueado' }); return null; }
  if ((u.v || 0) !== (p.v || 0)) { res.status(401).json({ erro: 'sessao' }); return null; }
  u.sid = p.s; u.foraDeSessao = false;
  if (!u.admin) {
    if (sess && sess.sid !== p.s) {
      if (!escrita) { res.status(401).json({ erro: sess.sid === SID_ENCERRADA ? 'encerrada' : 'outra_sessao', ap: sess.ap || '' }); return null; }
      u.foraDeSessao = true;
    } else if (!sess || Date.now() - sess.t > SESSAO_RENOVA) {
      await redis([cmdSessao(login, p.s, aparelho(req))]);
    }
  }
  return u;
}
const sessaoLivre = s => !s || s.sid === SID_ENCERRADA;

/* ---------- relatório ---------- */
const diaSP = t => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
function cmdsLog(ev) {
  const k = 'log:' + diaSP(ev.t);
  return [['RPUSH', k, JSON.stringify(ev)], ['EXPIRE', k, String((LOG_DIAS + 1) * 86400)]];
}
function ultimosDias(n) {
  const out = [], agora = Date.now();
  for (let i = 0; i < n; i++) out.push(diaSP(agora - i * 86400000));
  return [...new Set(out)];
}

function base(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!configOk()) { res.status(500).json({ erro: 'configuracao', banco: !!(DB_URL && DB_TOKEN), admin: !!(ADMIN_U && ADMIN_S) }); return false; }
  return true;
}
const corpo = req => (req.body && typeof req.body === 'object') ? req.body : {};

module.exports = {
  DEPS, nomesDeps, LOG_DIAS, CONT_VALIDADE, ADMIN_U, ADMIN_S, configOk, redis,
  SID_ENCERRADA, sessaoLivre, novoToken, novoSid, aparelho, cmdSessao, SESSAO_TTL, conferirToken, hashSenha, senhaConfere, iguais, lerUsuario, perfil, exigirUsuario,
  cmdsLog, ultimosDias, base, corpo, DB_OK: () => !!(DB_URL && DB_TOKEN)
};
