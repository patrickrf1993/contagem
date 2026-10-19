const L = require('./_lib');

module.exports = async (req, res) => {
  if (!L.base(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ erro: 'metodo' });
  const b = L.corpo(req);

  try {
    // saída do sistema ou página fechada: libera o login para outro aparelho
    if (b.acao === 'sair') {
      const tok = b.token || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const p = L.conferirToken(tok);
      if (p && p.u !== L.ADMIN_U) {
        const [sr] = await L.redis([['GET', 'sessao:' + p.u]]);
        const s = L.json(sr, null);
        if (s && s.sid === p.s) await L.redis([['DEL', 'sessao:' + p.u]]);
      }
      return res.status(200).json({ ok: true });
    }

    // o próprio usuário troca a senha (precisa da senha atual)
    if (b.acao === 'senha') {
      const p = L.conferirToken(b.token || String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
      if (!p) return res.status(401).json({ erro: 'sessao' });
      if (p.u === L.ADMIN_U) return res.status(400).json({ erro: 'mestre', msg: 'A senha do administrador geral é a variável ADMIN_SENHA no Vercel.' });
      const kFalha = 'falhas:senha:' + p.u;
      const [r, f] = await L.redis([['HGET', 'usuarios', p.u], ['GET', kFalha]]);
      const rec = L.json(r, null);
      if (!rec || (rec.v || 0) !== (p.v || 0)) return res.status(401).json({ erro: 'sessao' });
      if (!rec.ativo) return res.status(403).json({ erro: 'bloqueado' });
      if (Number(f || 0) >= 10) return res.status(429).json({ erro: 'tentativas', msg: 'Muitas tentativas erradas. Aguarde 15 minutos.' });
      if (!L.senhaConfere(String(b.atual || ''), rec)) {
        await L.redis([['INCR', kFalha], ['EXPIRE', kFalha, '900']]);
        return res.status(400).json({ erro: 'senha', msg: 'A senha atual não confere.' });
      }
      const nova = String(b.nova || '');
      if (nova.length < L.SENHA_MIN) return res.status(400).json({ erro: 'curta', msg: 'A nova senha precisa ter pelo menos ' + L.SENHA_MIN + ' caracteres.' });
      Object.assign(rec, L.hashSenha(nova));
      await L.redis([['HSET', 'usuarios', p.u, JSON.stringify(rec)], ['DEL', kFalha]]
        .concat(L.cmdsLog({ t: Date.now(), u: p.u, nome: rec.nome, acao: 'usuario', alvo: p.u, detalhe: 'Trocou a própria senha' })));
      return res.status(200).json({ ok: true });
    }

    const login = String(b.login || '').trim().toLowerCase();
    const senha = String(b.senha || '');
    if (!login || !senha) return res.status(400).json({ erro: 'dados' });
    // tentativas erradas contam por aparelho (rede) e, com limite maior, por usuário,
    // para que ninguém trave a conta de outra pessoa digitando errado de propósito
    const kFalha = 'falhas:' + login + ':' + L.ip(req), kFalhaU = 'falhas:' + login;
    const [f1, f2, st] = await L.redis([['GET', kFalha], ['GET', kFalhaU], ['GET', 'setores']]);
    if (Number(f1 || 0) >= 10 || Number(f2 || 0) >= 50) return res.status(429).json({ erro: 'tentativas' });
    const setores = L.parseSetores(st);

    let u = null, ok = false, sess = null;
    if (login === L.ADMIN_U) { u = L.mestre(setores); ok = L.iguais(senha, L.ADMIN_S); }
    else {
      const [r, sr] = await L.redis([['HGET', 'usuarios', login], ['GET', 'sessao:' + login]]);
      if (r) { const rec = JSON.parse(r); ok = L.senhaConfere(senha, rec); u = { ...rec, login, admin: false }; }
      sess = L.json(sr, null);
    }
    if (!ok) {
      await L.redis([['INCR', kFalha], ['EXPIRE', kFalha, '900'], ['INCR', kFalhaU], ['EXPIRE', kFalhaU, '900']]);
      return res.status(401).json({ erro: 'senha' });
    }
    if (!u.ativo) return res.status(403).json({ erro: 'bloqueado' });
    L.normalizar(u, setores);

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
    const cmds = [['DEL', kFalha], ['DEL', kFalhaU], ['HSET', 'ultimo', u.login, String(Date.now())]];
    if (!u.admin) cmds.push(L.cmdSessao(login, sid, ap));
    cmds.push(...L.cmdsLog({ t: Date.now(), u: u.login, nome: u.nome, acao: 'entrou', detalhe: ap }));
    await L.redis(cmds);
    return res.status(200).json({ token: L.novoToken(u, sid), perfil: L.perfil(u) });
  } catch (e) {
    return res.status(502).json({ erro: 'banco', detalhe: String(e.message || e) });
  }
};
