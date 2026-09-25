const L = require('./_lib');

module.exports = async (req, res) => {
  if (!L.base(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ erro: 'metodo' });
  let b = L.corpo(req);
  if (typeof req.body === 'string') { try { b = JSON.parse(req.body); } catch (e) { b = {}; } }

  try {
    // saída do sistema ou página fechada: libera o login para outro aparelho
    if (b.acao === 'sair') {
      const tok = b.token || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const p = L.conferirToken(tok);
      if (p && p.u !== L.ADMIN_U) {
        const [sr] = await L.redis([['GET', 'sessao:' + p.u]]);
        let s = null; try { s = sr ? JSON.parse(sr) : null; } catch (e) {}
        if (s && s.sid === p.s) await L.redis([['DEL', 'sessao:' + p.u]]);
      }
      return res.status(200).json({ ok: true });
    }

    const login = String(b.login || '').trim().toLowerCase();
    const senha = String(b.senha || '');
    if (!login || !senha) return res.status(400).json({ erro: 'dados' });
    const kFalha = 'falhas:' + login;
    const [falhas] = await L.redis([['GET', kFalha]]);
    if (Number(falhas || 0) >= 10) return res.status(429).json({ erro: 'tentativas' });

    let u = null, ok = false, sess = null;
    if (login === L.ADMIN_U) { u = await L.lerUsuario(login); ok = L.iguais(senha, L.ADMIN_S); }
    else {
      const [r, sr] = await L.redis([['HGET', 'usuarios', login], ['GET', 'sessao:' + login]]);
      if (r) { const rec = JSON.parse(r); ok = L.senhaConfere(senha, rec); u = { ...rec, login, admin: false }; }
      try { sess = sr ? JSON.parse(sr) : null; } catch (e) {}
    }
    if (!ok) {
      await L.redis([['INCR', kFalha], ['EXPIRE', kFalha, '900']]);
      return res.status(401).json({ erro: 'senha' });
    }
    if (!u.ativo) return res.status(403).json({ erro: 'bloqueado' });

    const ap = L.aparelho(req);
    if (!u.admin && !L.sessaoLivre(sess)) {
      // mesmo aparelho reabrindo (mesmo token guardado) pode continuar
      const antigo = L.conferirToken(b.tokenAnterior || '');
      if (!(antigo && antigo.u === login && antigo.s === sess.sid)) {
        await L.redis([['DEL', kFalha]].concat(L.cmdsLog({ t: Date.now(), u: login, nome: u.nome, acao: 'recusado', detalhe: 'Tentou entrar em ' + ap + ' com a conta já aberta em ' + (sess.ap || 'outro aparelho') })));
        return res.status(409).json({ erro: 'em_uso', ap: sess.ap || '', desde: sess.t, espera: L.SESSAO_TTL });
      }
    }
    const sid = L.novoSid();
    const cmds = [['DEL', kFalha]];
    if (!u.admin) cmds.push(L.cmdSessao(login, sid, ap));
    cmds.push(...L.cmdsLog({ t: Date.now(), u: u.login, nome: u.nome, acao: 'entrou', detalhe: ap }));
    await L.redis(cmds);
    return res.status(200).json({ token: L.novoToken(u, sid), perfil: L.perfil(u) });
  } catch (e) {
    return res.status(502).json({ erro: 'banco', detalhe: String(e.message || e) });
  }
};
