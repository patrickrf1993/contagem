const L = require('./_lib');
const num = v => (typeof v === 'number' && isFinite(v) && v >= 0) ? v : null;
const mesmo = (a, b) => (!a && !b) || (a && b && a.total === b.total && (a.m || null) === (b.m || null) && a.q === b.q && JSON.stringify(a.p || null) === JSON.stringify(b.p || null));
const resumo = r => r ? { total: r.total, q: r.q, m: r.m || null, p: r.p || undefined, by: r.by || '' } : null;
// parcelas somadas (ex.: 10 + 2 volumes); só guarda se baterem com a quantidade
function parcelas(p, q) {
  if (!Array.isArray(p) || p.length < 2 || p.length > 100) return undefined;
  const ok = p.map(num);
  if (ok.some(x => x === null)) return undefined;
  const soma = ok.reduce((a, b) => a + b, 0);
  return Math.abs(soma - q) < 1e-6 * Math.max(1, q) ? ok : undefined;
}
const horaTxt = t => new Date(t).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.query && req.query.ping !== undefined) {
    return res.status(200).json({ ok: true, banco: L.DB_OK(), admin: !!(L.ADMIN_U && L.ADMIN_S) });
  }
  if (!L.base(req, res)) return;
  try {
    const u = await L.exigirUsuario(req, res, { escrita: req.method === 'POST' }); if (!u) return;
    const b = L.corpo(req);
    const acao = String((req.method === 'GET' ? req.query.acao : b.acao) || '');
    const depDe = k => k.split(':')[0];
    const pode = k => u.deps.includes(depDe(k));
    const nomeSetor = id => (u.setores.find(s => s.id === id) || {}).nome || id;

    // comparação entre contagens: as últimas N datas de um setor
    if (req.method === 'GET' && acao === 'historico') {
      const setor = String(req.query.setor || '');
      if (!u.deps.includes(setor)) return res.status(403).json({ erro: 'setor' });
      const n = Math.max(2, Math.min(12, Number(req.query.n) || 6));
      await L.garantirDatas();
      const [datas] = await L.redis([['ZREVRANGEBYSCORE', 'datas:' + setor, '+inf', '-inf', 'LIMIT', '0', String(n)]]);
      const ds = datas || [];
      const hs = await L.redis(ds.map(d => ['HGETALL', 'cont:' + d]));
      const itens = {};
      ds.forEach((d, i) => { const o = L.hash(hs[i]); for (const k in o) { if (depDe(k) !== setor) continue; const v = L.json(o[k], null); if (v && typeof v.total === 'number') (itens[L.nk(k)] = itens[L.nk(k)] || {})[d] = v.total; } });
      return res.status(200).json({ setor, datas: ds, itens });
    }

    const data = String((req.method === 'GET' ? req.query.data : b.data) || '');
    if (!RE_DATA.test(data)) return res.status(400).json({ erro: 'data' });
    const kItens = 'cont:' + data, kVer = 'ver:' + data, kObs = 'obs:' + data, kFech = 'fech:' + data;

    if (req.method === 'GET' && acao === 'ref') {
      return res.status(200).json({ data, ref: await L.referencias(u.deps, data) });
    }

    if (req.method === 'GET') {
      const [v, cv] = await L.redis([['GET', kVer], ['GET', 'catalogo:v']]);
      const ver = Number(v || 0);
      // lista de insumos (só vai quando mudou)
      let catalogo;
      if (String(cv || 'base') !== String(req.query.cv || '')) {
        const cat = await L.lerCatalogo();
        const itens = {}; u.deps.forEach(d => { if (cat.itens[d]) itens[d] = cat.itens[d]; });
        catalogo = { v: cat.v, t: cat.t, por: cat.por, itens };
      }
      const extra = { perfil: L.perfil(u), catalogo, setores: u.setores };
      if (req.query.v !== undefined && String(ver) === String(req.query.v)) return res.status(200).json({ v: ver, ...extra });
      const [flat, v2, fflat, oflat, hflat] = await L.redis([['HGETALL', kItens], ['GET', kVer], ['HGETALL', 'fatores'], ['HGETALL', kObs], ['HGETALL', kFech]]);
      const fatores = {}, itens = {}, obs = {}, fech = {};
      const f0 = L.hash(fflat); for (const k in f0) { if (pode(k)) { const n = Number(f0[k]); if (isFinite(n)) fatores[k] = n; } }
      const i0 = L.hash(flat); for (const k in i0) { if (pode(k)) { const x = L.json(i0[k], null); if (x) itens[k] = x; } }
      const o0 = L.hash(oflat); for (const k in o0) { if (pode(k)) { const x = L.json(o0[k], null); if (x) obs[k] = x; } }
      const h0 = L.hash(hflat); for (const k in h0) { if (u.deps.includes(k)) { const x = L.json(h0[k], null); if (x) fech[k] = x; } }
      return res.status(200).json({ v: Number(v2 || 0), itens, fatores, obs, fech, ...extra });
    }

    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ erro: 'metodo' }); }

    /* ---------- fechar / reabrir a contagem de um setor ---------- */
    if (acao === 'fechar' || acao === 'reabrir') {
      if (!L.gestorOuAdmin(u)) return res.status(403).json({ erro: 'permissao', msg: 'Só o gestor da área ou o administrador fecha a contagem.' });
      const setor = String(b.setor || '');
      if (!u.deps.includes(setor)) return res.status(403).json({ erro: 'setor' });
      const [atual] = await L.redis([['HGET', kFech, setor]]);
      const agora = Date.now();
      if (acao === 'fechar') {
        if (atual) return res.status(200).json({ ok: true, fech: L.json(atual, null) });
        const cat = await L.lerCatalogo();
        const lista = cat.itens[setor] || [];
        const [chaves] = await L.redis([['HKEYS', kItens]]);
        const contados = new Set((chaves || []).map(L.nk));
        const n = lista.filter(it => contados.has(setor + ':c' + it.c)).length;
        const rec = { u: u.login, nome: u.nome, t: agora, contados: n, total: lista.length };
        const [, , nv] = await L.redis([['HSET', kFech, setor, JSON.stringify(rec)], ['EXPIRE', kFech, L.CONT_VALIDADE], ['INCR', kVer], ['EXPIRE', kVer, L.CONT_VALIDADE]]
          .concat(L.cmdsLog({ t: agora, u: u.login, nome: u.nome, acao: 'fechou', data, setor, detalhe: 'Fechou a contagem de ' + nomeSetor(setor) + ' (' + n + ' de ' + lista.length + ' itens)' })));
        return res.status(200).json({ ok: true, fech: rec, v: nv });
      }
      const motivo = String(b.motivo || '').trim().slice(0, 200);
      if (motivo.length < 3) return res.status(400).json({ erro: 'motivo', msg: 'Informe o motivo para reabrir.' });
      if (!atual) return res.status(200).json({ ok: true });
      const [, nv] = await L.redis([['HDEL', kFech, setor], ['INCR', kVer], ['EXPIRE', kVer, L.CONT_VALIDADE]]
        .concat(L.cmdsLog({ t: agora, u: u.login, nome: u.nome, acao: 'reabriu', data, setor, detalhe: 'Reabriu a contagem de ' + nomeSetor(setor) + '. Motivo: ' + motivo })));
      return res.status(200).json({ ok: true, v: nv });
    }

    /* ---------- gravar contagens e observações ---------- */
    const entradas = Object.entries(b.itens && typeof b.itens === 'object' ? b.itens : {});
    const obsE = Object.entries(b.obs && typeof b.obs === 'object' ? b.obs : {});
    if ((!entradas.length && !obsE.length) || entradas.length > 200 || obsE.length > 200) return res.status(400).json({ erro: 'itens' });
    const recusados = [], ignorados = [];
    // chaves que não servem são devolvidas (o aparelho descarta e avisa), em vez de travar o envio
    const triar = lista => lista.filter(([k]) => {
      if (!L.RE_CHAVE.test(k)) { recusados.push({ k, motivo: 'chave' }); return false; }
      if (!pode(k)) { recusados.push({ k, motivo: 'setor' }); return false; }
      return true;
    });
    const cand = triar(entradas), candObs = triar(obsE);
    const q0 = [['HGETALL', kFech]];
    if (cand.length) q0.push(['HMGET', kItens, ...cand.map(e => e[0])]);
    if (candObs.length) q0.push(['HMGET', kObs, ...candObs.map(e => e[0])]);
    const r0 = await L.redis(q0);
    const fech = L.hash(r0[0]);
    const antigos = cand.length ? r0[1] : [], antigosObs = candObs.length ? r0[cand.length ? 2 : 1] : [];
    const agora = Date.now(), cmds = [], gravados = new Set();
    const obs = u.foraDeSessao ? 'enviado depois, de um aparelho que estava sem sinal' : undefined;

    cand.forEach(([k, val], i) => {
      const antes = L.json(antigos && antigos[i], null);
      const apagar = val === null || !!(val && val.vazio);
      const tentado = apagar ? null : resumo({ total: num(val && val.total), q: num(val && val.q), m: val && val.m != null ? num(val.m) : null });
      if (fech[depDe(k)]) {
        recusados.push({ k, motivo: 'fechado' });
        const f = L.json(fech[depDe(k)], {});
        cmds.push(...L.cmdsLog({ t: agora, u: u.login, nome: u.nome, acao: 'descartado', data, k, antes: resumo(antes), depois: tentado,
          detalhe: 'Enviado depois que ' + (f.nome || 'o gestor') + ' fechou a contagem do setor. Não foi usado.' }));
        return;
      }
      const tc = val && typeof val.tc === 'number' && isFinite(val.tc) ? Math.min(val.tc, agora) : agora;
      // conflito: alguém gravou este item depois do momento em que este valor foi digitado
      if (antes && antes.tc && tc < antes.tc && antes.u !== u.login) {
        ignorados.push(k);
        cmds.push(...L.cmdsLog({ t: agora, u: u.login, nome: u.nome, acao: 'descartado', data, k, antes: resumo(antes), depois: tentado,
          detalhe: 'Valor digitado sem sinal às ' + horaTxt(tc) + ' não foi usado: ' + (antes.by || 'outra pessoa') + ' atualizou o item depois.' }));
        return;
      }
      let depois = null;
      if (!apagar) {
        const total = num(val.total), q = num(val.q), m = val.m == null ? null : num(val.m);
        if (total === null || q === null) { recusados.push({ k, motivo: 'valor' }); return; }
        depois = { q, m, total, by: u.nome, u: u.login, t: agora, tc };
        const pp = parcelas(val.p, q); if (pp) depois.p = pp;
      }
      if (mesmo(antes, depois)) return;
      cmds.push(depois ? ['HSET', kItens, k, JSON.stringify(depois)] : ['HDEL', kItens, k]);
      if (depois) gravados.add(depDe(k));
      if (depois && depois.m) cmds.push(['HSET', 'fatores', k, String(depois.m)]);   // lembra a quantidade por volume
      cmds.push(...L.cmdsLog({ t: agora, u: u.login, nome: u.nome, acao: !antes ? 'contou' : (!depois ? 'apagou' : 'alterou'), data, k, antes: resumo(antes), depois: resumo(depois), obs,
        tc: tc < agora - 60000 ? tc : undefined }));
    });

    candObs.forEach(([k, val], i) => {
      if (fech[depDe(k)]) { recusados.push({ k, motivo: 'fechado', obs: true }); return; }
      const antes = L.json(antigosObs && antigosObs[i], null);
      const txt = val == null ? '' : String(val).replace(/\s+/g, ' ').trim().slice(0, 200);
      if ((antes ? antes.txt : '') === txt) return;
      cmds.push(txt ? ['HSET', kObs, k, JSON.stringify({ txt, by: u.nome, u: u.login, t: agora })] : ['HDEL', kObs, k]);
      cmds.push(...L.cmdsLog({ t: agora, u: u.login, nome: u.nome, acao: 'obs', data, k, detalhe: txt ? 'Observação: ' + txt : 'Apagou a observação' + (antes ? ' "' + antes.txt + '"' : '') }));
    });

    const mudou = cmds.some(c => c[0] === 'HSET' || c[0] === 'HDEL');
    if (!mudou) {
      const out0 = await L.redis(cmds.concat([['GET', kVer]]));
      return res.status(200).json({ v: Number(out0[out0.length - 1] || 0), ignorados, recusados });
    }
    const iVer = cmds.length;
    cmds.push(['INCR', kVer], ['EXPIRE', kItens, L.CONT_VALIDADE], ['EXPIRE', kVer, L.CONT_VALIDADE], ['EXPIRE', kObs, L.CONT_VALIDADE], ...L.cmdsDatas(data, [...gravados]));
    const out = await L.redis(cmds);
    return res.status(200).json({ v: out[iVer], ignorados, recusados });
  } catch (e) {
    return res.status(502).json({ erro: 'banco', detalhe: String(e.message || e) });
  }
};
