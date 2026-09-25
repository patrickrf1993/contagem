const L = require('./_lib');
const num = v => (typeof v === 'number' && isFinite(v) && v >= 0) ? v : null;
const mesmo = (a, b) => (!a && !b) || (a && b && a.total === b.total && (a.m || null) === (b.m || null) && a.q === b.q);
const resumo = r => r ? { total: r.total, q: r.q, m: r.m || null, by: r.by || '' } : null;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.query && req.query.ping !== undefined) {
    return res.status(200).json({ ok: true, banco: L.DB_OK(), admin: !!(L.ADMIN_U && L.ADMIN_S) });
  }
  if (!L.base(req, res)) return;
  try {
    const u = await L.exigirUsuario(req, res, { escrita: req.method === 'POST' }); if (!u) return;
    const b = L.corpo(req);
    const data = String((req.method === 'GET' ? req.query.data : b.data) || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return res.status(400).json({ erro: 'data' });
    const kItens = 'cont:' + data, kVer = 'ver:' + data;
    const pode = k => u.deps.includes(k.split(':')[0]);

    if (req.method === 'GET') {
      const [v] = await L.redis([['GET', kVer]]);
      const ver = Number(v || 0);
      if (req.query.v !== undefined && String(ver) === String(req.query.v)) return res.status(200).json({ v: ver, perfil: L.perfil(u) });
      const [flat, v2] = await L.redis([['HGETALL', kItens], ['GET', kVer]]);
      const itens = {};
      for (let i = 0; i + 1 < (flat || []).length; i += 2) {
        if (!pode(flat[i])) continue;
        try { itens[flat[i]] = JSON.parse(flat[i + 1]); } catch (e) {}
      }
      return res.status(200).json({ v: Number(v2 || 0), itens, perfil: L.perfil(u) });
    }

    if (req.method === 'POST') {
      const entradas = Object.entries(b.itens || {});
      if (!entradas.length || entradas.length > 200) return res.status(400).json({ erro: 'itens' });
      for (const [k] of entradas) {
        if (!/^[A-Z]{2,12}:r\d{1,4}$/.test(k)) return res.status(400).json({ erro: 'chave' });
        if (!pode(k)) return res.status(403).json({ erro: 'setor', setor: k.split(':')[0] });
      }
      const chaves = entradas.map(([k]) => k);
      const [antigos] = await L.redis([['HMGET', kItens, ...chaves]]);
      const agora = Date.now(), cmds = [], ignorados = [];
      const obs = u.foraDeSessao ? 'enviado depois, de um aparelho que estava sem sinal' : undefined;
      entradas.forEach(([k, val], i) => {
        let antes = null; try { antes = antigos && antigos[i] ? JSON.parse(antigos[i]) : null; } catch (e) {}
        const apagar = val === null || !!(val && val.vazio);
        const tc = val && typeof val.tc === 'number' && isFinite(val.tc) ? Math.min(val.tc, agora) : agora;
        // conflito: alguém gravou este item depois do momento em que este valor foi digitado
        if (antes && antes.tc && tc < antes.tc && antes.u !== u.login) {
          ignorados.push(k);
          const tentado = apagar ? null : resumo({ total: num(val.total), q: num(val.q), m: val.m == null ? null : num(val.m) });
          cmds.push(...L.cmdsLog({ t: agora, u: u.login, nome: u.nome, acao: 'descartado', data, k, antes: resumo(antes), depois: tentado,
            detalhe: 'Valor digitado sem sinal às ' + new Date(tc).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }) + ' não foi usado: ' + (antes.by || 'outra pessoa') + ' atualizou o item depois.' }));
          return;
        }
        let depois = null;
        if (!apagar) {
          const total = num(val.total), q = num(val.q), m = val.m == null ? null : num(val.m);
          if (total === null || q === null) return;
          depois = { q, m, total, by: u.nome, u: u.login, t: agora, tc };
        }
        if (mesmo(antes, depois)) return;
        cmds.push(depois ? ['HSET', kItens, k, JSON.stringify(depois)] : ['HDEL', kItens, k]);
        cmds.push(...L.cmdsLog({ t: agora, u: u.login, nome: u.nome, acao: !antes ? 'contou' : (!depois ? 'apagou' : 'alterou'), data, k, antes: resumo(antes), depois: resumo(depois), obs,
          tc: tc < agora - 60000 ? tc : undefined }));
      });
      const soLog = !cmds.some(c => c[0] === 'HSET' || c[0] === 'HDEL');
      if (!cmds.length || soLog) { const out0 = await L.redis(cmds.concat([['GET', kVer]])); return res.status(200).json({ v: Number(out0[out0.length - 1] || 0), ignorados }); }
      cmds.push(['INCR', kVer], ['EXPIRE', kItens, L.CONT_VALIDADE], ['EXPIRE', kVer, L.CONT_VALIDADE]);
      const out = await L.redis(cmds);
      return res.status(200).json({ v: out[out.length - 3], ignorados });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ erro: 'metodo' });
  } catch (e) {
    return res.status(502).json({ erro: 'banco', detalhe: String(e.message || e) });
  }
};
