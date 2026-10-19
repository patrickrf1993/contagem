// Funções compartilhadas pelas rotas da API (arquivos com "_" não viram rota no Vercel).
const crypto = require('crypto');
const BASE = require('./_catalogo');

const DB_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const DB_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN_U = String(process.env.ADMIN_USUARIO || '').trim().toLowerCase();
const ADMIN_S = String(process.env.ADMIN_SENHA || '');
const ADMIN_NOME = String(process.env.ADMIN_NOME || 'Administrador');

const LOG_DIAS = 30;                      // relatório guarda os últimos 30 dias
const CONT_VALIDADE = String(400 * 86400);
const SESSAO_DIAS = 30;
const SESSAO_TTL = 120;          // segundos sem sinal para liberar o login em outro aparelho
const SESSAO_RENOVA = 30000;     // renova o sinal no máximo a cada 30 s
const SID_ENCERRADA = 'encerrada'; // marca deixada quando o administrador encerra a sessão
const SENHA_MIN = 6;             // senhas novas (as antigas continuam valendo)
const RE_SETOR = /^[A-Z][A-Z0-9]{1,11}$/;
const RE_CHAVE = /^[A-Z][A-Z0-9]{1,11}:(r\d{1,4}|c[A-Za-z0-9._-]{1,30})$/;

const configOk = () => !!(DB_URL && DB_TOKEN && ADMIN_U && ADMIN_S);

async function redis(cmds) {
  if (!cmds.length) return [];
  const r = await fetch(DB_URL.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + DB_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds)
  });
  if (!r.ok) throw new Error('banco respondeu ' + r.status);
  const out = await r.json();
  return out.map(x => { if (x.error) throw new Error(x.error); return x.result; });
}
const json = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch (e) { return d; } };
const hash = flat => { const o = {}; for (let i = 0; i + 1 < (flat || []).length; i += 2) o[flat[i]] = flat[i + 1]; return o; };
const nk = k => BASE.LEG[k] || k;   // chaves antigas (por linha) viram chaves por código

/* ---------- setores ---------- */
// guardados no banco em "setores"; enquanto ninguém enviar uma lista, valem os 5 originais
function parseSetores(raw) {
  const j = json(raw, null);
  if (j && Array.isArray(j.lista) && j.lista.length) return j.lista;
  return BASE.SETORES.map(s => ({ ...s, ativo: true }));
}
async function lerSetores() { const [r] = await redis([['GET', 'setores']]); return parseSetores(r); }
const idsAtivos = l => l.filter(s => s.ativo !== false).map(s => s.id);
const nomesDeps = (d, lista) => {
  const m = {}; (lista || BASE.SETORES).forEach(s => { m[s.id] = s.nome; });
  return (d || []).map(x => m[x] || x).join(', ') || 'nenhum';
};

/* ---------- lista de insumos ---------- */
async function lerCatalogo() {
  const [c, cv] = await redis([['GET', 'catalogo'], ['GET', 'catalogo:v']]);
  const cat = json(c, null);
  const salvo = !!(cat && cat.itens);
  return { v: String(cv || 'base'), t: salvo ? cat.t : null, por: salvo ? cat.por : null, salvo,
    itens: { ...BASE.ITENS, ...(salvo ? cat.itens : {}) } };
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
const ip = req => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || String((req.socket && req.socket.remoteAddress) || '');
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
// papéis: administrador geral (variáveis do Vercel), gestor de área e funcionário
function mestre(setores) { return { login: ADMIN_U, nome: ADMIN_NOME, admin: true, ativo: true, exporta: true, deps: idsAtivos(setores), v: 0 }; }
function normalizar(u, setores) {
  const at = idsAtivos(setores);
  u.setores = setores;
  u.papel = u.admin ? 'admin' : (u.papel === 'gestor' ? 'gestor' : 'func');
  u.deps = u.admin ? at : (u.deps || []).filter(d => at.includes(d));
  return u;
}
const perfil = u => ({ login: u.login, nome: u.nome, admin: !!u.admin, papel: u.papel || (u.admin ? 'admin' : 'func'), deps: u.deps || [], exporta: !!(u.admin || u.exporta) });
const gestorOuAdmin = u => !!(u.admin || u.papel === 'gestor');

// opcoes.escrita: aceita gravações de um aparelho que ficou sem sinal e perdeu a vez,
// para que as contagens guardadas nele não se percam.
async function exigirUsuario(req, res, opcoes) {
  const escrita = !!(opcoes && opcoes.escrita);
  const p = conferirToken(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  if (!p) { res.status(401).json({ erro: 'sessao' }); return null; }
  const login = String(p.u || '').toLowerCase();
  let u, sess = null, setores;
  if (login === ADMIN_U) { const [st] = await redis([['GET', 'setores']]); setores = parseSetores(st); u = mestre(setores); }
  else {
    const [r, sr, st] = await redis([['HGET', 'usuarios', login], ['GET', 'sessao:' + login], ['GET', 'setores']]);
    setores = parseSetores(st);
    u = r ? { ...JSON.parse(r), login, admin: false } : null;
    sess = json(sr, null);
  }
  if (!u) { res.status(401).json({ erro: 'sessao' }); return null; }
  if (!u.ativo) { res.status(403).json({ erro: 'bloqueado' }); return null; }
  if ((u.v || 0) !== (p.v || 0)) { res.status(401).json({ erro: 'sessao' }); return null; }
  normalizar(u, setores);
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

/* ---------- datas com contagem (para comparar com a anterior) ---------- */
const diaSP = t => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
const horaSP = t => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hourCycle: 'h23' }).format(new Date(t));
const scoreData = d => String(Number(String(d).replace(/-/g, '')));
const cmdsDatas = (data, deps) => [...new Set(deps)].map(d => ['ZADD', 'datas:' + d, scoreData(data), data]);
// na primeira vez, monta o índice de datas a partir das contagens que já existem
async function garantirDatas() {
  const [ok] = await redis([['GET', 'datas:ok']]);
  if (ok) return;
  let cursor = '0'; const keys = []; let voltas = 0;
  do {
    const [r] = await redis([['SCAN', cursor, 'MATCH', 'cont:*', 'COUNT', '500']]);
    cursor = String(r[0]); keys.push(...(r[1] || []));
  } while (cursor !== '0' && ++voltas < 50);
  const datas = keys.map(k => k.slice(5)).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
  const cmds = [];
  for (let i = 0; i < datas.length; i += 100) {
    const parte = datas.slice(i, i + 100);
    const hk = await redis(parte.map(d => ['HKEYS', 'cont:' + d]));
    parte.forEach((d, j) => { const deps = (hk[j] || []).map(f => f.split(':')[0]); cmds.push(...cmdsDatas(d, deps)); });
  }
  for (let i = 0; i < cmds.length; i += 500) await redis(cmds.slice(i, i + 500));
  await redis([['SET', 'datas:ok', '1']]);
}
// para cada setor: a contagem mais recente antes de "data", com o total de cada item
async function referencias(deps, data) {
  if (!deps.length) return {};
  await garantirDatas();
  const r = await redis(deps.map(d => ['ZREVRANGEBYSCORE', 'datas:' + d, '(' + scoreData(data), '-inf', 'LIMIT', '0', '1']));
  const porData = {}, out = {};
  deps.forEach((d, i) => { const dt = (r[i] || [])[0]; if (dt) { (porData[dt] = porData[dt] || []).push(d); out[d] = { data: dt, itens: {} }; } });
  const ds = Object.keys(porData);
  const hs = await redis(ds.map(dt => ['HGETALL', 'cont:' + dt]));
  ds.forEach((dt, i) => {
    const o = hash(hs[i]);
    for (const k in o) {
      const dep = k.split(':')[0];
      if (!out[dep] || out[dep].data !== dt) continue;
      const v = json(o[k], null); if (v && typeof v.total === 'number') out[dep].itens[nk(k)] = v.total;
    }
  });
  return out;
}

/* ---------- relatório ---------- */
function cmdsLog(ev) {
  const k = 'log:' + diaSP(ev.t);
  return [['RPUSH', k, JSON.stringify(ev)], ['EXPIRE', k, String((LOG_DIAS + 1) * 86400)]];
}
function ultimosDias(n) {
  const out = [], agora = Date.now();
  for (let i = 0; i < n + 1 && out.length < n; i++) { const d = diaSP(agora - i * 86400000); if (!out.includes(d)) out.push(d); }
  return out;
}
const setorDoEvento = e => e.setor || (e.k ? String(e.k).split(':')[0] : '');

function base(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!configOk()) { res.status(500).json({ erro: 'configuracao', banco: !!(DB_URL && DB_TOKEN), admin: !!(ADMIN_U && ADMIN_S) }); return false; }
  return true;
}
const corpo = req => {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return json(req.body, {});
  return {};
};

module.exports = {
  BASE, LOG_DIAS, CONT_VALIDADE, ADMIN_U, ADMIN_S, SENHA_MIN, RE_SETOR, RE_CHAVE, configOk, redis, json, hash, nk,
  parseSetores, lerSetores, idsAtivos, nomesDeps, lerCatalogo,
  SID_ENCERRADA, sessaoLivre, novoToken, novoSid, aparelho, ip, cmdSessao, SESSAO_TTL, conferirToken, hashSenha, senhaConfere, iguais,
  mestre, normalizar, perfil, gestorOuAdmin, exigirUsuario,
  diaSP, horaSP, scoreData, cmdsDatas, garantirDatas, referencias,
  cmdsLog, ultimosDias, setorDoEvento, base, corpo, DB_OK: () => !!(DB_URL && DB_TOKEN)
};
