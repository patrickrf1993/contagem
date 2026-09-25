const L = require('./_lib');
const semSegredo = (login, u) => ({ login, nome: u.nome, deps: u.deps || [], ativo: !!u.ativo, criado: u.criado || null });

module.exports = async (req, res) => {
  if (!L.base(req, res)) return;
  try {
    const u = await L.exigirUsuario(req, res); if (!u) return;
    if (!u.admin) return res.status(403).json({ erro: 'admin' });

    if (req.method === 'GET') {
      const acao = String(req.query.acao || '');
      if (acao === 'usuarios') {
        const [flat] = await L.redis([['HGETALL', 'usuarios']]);
        const lista = [];
        for (let i = 0; i + 1 < (flat || []).length; i += 2) { try { lista.push(semSegredo(flat[i], JSON.parse(flat[i + 1]))); } catch (e) {} }
        if (lista.length) {
          const ss = await L.redis(lista.map(x => ['GET', 'sessao:' + x.login]));
          ss.forEach((sr, i) => { try { const s = sr ? JSON.parse(sr) : null; lista[i].online = (s && s.sid !== L.SID_ENCERRADA) ? { ap: s.ap || '', t: s.t } : null; } catch (e) {} });
        }
        lista.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
        return res.status(200).json({ mestre: L.perfil(u), usuarios: lista });
      }
      if (acao === 'relatorio') {
        const dias = L.ultimosDias(L.LOG_DIAS);
        const out = await L.redis(dias.map(d => ['LRANGE', 'log:' + d, '0', '-1']));
        const eventos = [];
        out.forEach(arr => (arr || []).forEach(s => { try { eventos.push(JSON.parse(s)); } catch (e) {} }));
        eventos.sort((a, b) => b.t - a.t);
        return res.status(200).json({ dias, eventos });
      }
      return res.status(400).json({ erro: 'acao' });
    }

    if (req.method === 'POST') {
      const b = L.corpo(req);
      const login = String(b.login || '').trim().toLowerCase();
      if (!/^[a-z0-9._-]{3,30}$/.test(login)) return res.status(400).json({ erro: 'login', msg: 'Use de 3 a 30 letras minúsculas, números, ponto, hífen ou sublinhado, sem espaço.' });
      if (login === L.ADMIN_U) return res.status(400).json({ erro: 'login', msg: 'Esse usuário é o administrador principal.' });
      const [r] = await L.redis([['HGET', 'usuarios', login]]);
      const atual = r ? JSON.parse(r) : null;
      const agora = Date.now();

      if (b.acao === 'excluir') {
        if (!atual) return res.status(404).json({ erro: 'naoexiste' });
        await L.redis([['HDEL', 'usuarios', login]].concat(L.cmdsLog({ t: agora, u: u.login, nome: u.nome, acao: 'usuario', detalhe: 'Excluiu o usuário ' + atual.nome + ' (' + login + ')' })));
        return res.status(200).json({ ok: true });
      }

      if (b.acao === 'encerrar') {
        if (!atual) return res.status(404).json({ erro: 'naoexiste' });
        // deixa uma marca: o aparelho é desconectado, mas ainda consegue entregar contagens guardadas
        await L.redis([['SET', 'sessao:' + login, JSON.stringify({ sid: L.SID_ENCERRADA, t: agora, ap: '' }), 'EX', String(30 * 86400)]]
          .concat(L.cmdsLog({ t: agora, u: u.login, nome: u.nome, acao: 'usuario', detalhe: 'Encerrou a sessão de ' + atual.nome })));
        return res.status(200).json({ ok: true, usuario: semSegredo(login, atual) });
      }

      if (b.acao === 'salvar') {
        const novo = !atual;
        if (novo && b.criar !== true) return res.status(404).json({ erro: 'naoexiste' });
        if (!novo && b.criar === true) return res.status(409).json({ erro: 'existe', msg: 'Já existe um usuário com esse login.' });
        const nome = String(b.nome != null ? b.nome : (atual && atual.nome) || '').trim().slice(0, 60);
        if (!nome) return res.status(400).json({ erro: 'nome', msg: 'Informe o nome.' });
        const deps = Array.isArray(b.deps) ? b.deps.filter(d => L.DEPS.includes(d)) : (atual ? atual.deps : []);
        const ativo = typeof b.ativo === 'boolean' ? b.ativo : (atual ? atual.ativo : true);
        const senha = b.senha != null ? String(b.senha) : '';
        if (novo && senha.length < 4) return res.status(400).json({ erro: 'senha', msg: 'A senha precisa ter pelo menos 4 caracteres.' });
        if (senha && senha.length < 4) return res.status(400).json({ erro: 'senha', msg: 'A senha precisa ter pelo menos 4 caracteres.' });

        const rec = atual ? { ...atual } : { criado: agora, v: 0 };
        rec.nome = nome; rec.deps = deps; rec.ativo = ativo;
        if (senha) { Object.assign(rec, L.hashSenha(senha)); }
        if (!novo && (senha || (atual.ativo && !ativo))) rec.v = (rec.v || 0) + 1;   // derruba sessões abertas

        const mud = [];
        if (novo) mud.push('Criou o usuário ' + nome + ' (' + login + ') com setores: ' + L.nomesDeps(deps));
        else {
          if (atual.nome !== nome) mud.push('Renomeou ' + atual.nome + ' para ' + nome);
          if (JSON.stringify(atual.deps || []) !== JSON.stringify(deps)) mud.push('Setores de ' + nome + ': ' + L.nomesDeps(deps));
          if (atual.ativo !== ativo) mud.push((ativo ? 'Liberou' : 'Bloqueou') + ' o acesso de ' + nome);
          if (senha) mud.push('Trocou a senha de ' + nome);
        }
        const cmds = [['HSET', 'usuarios', login, JSON.stringify(rec)]];
        if (!novo && rec.v !== (atual.v || 0)) cmds.push(['DEL', 'sessao:' + login]);
        mud.forEach(d => cmds.push(...L.cmdsLog({ t: agora, u: u.login, nome: u.nome, acao: 'usuario', detalhe: d })));
        await L.redis(cmds);
        return res.status(200).json({ ok: true, usuario: semSegredo(login, rec) });
      }
      return res.status(400).json({ erro: 'acao' });
    }
    return res.status(405).json({ erro: 'metodo' });
  } catch (e) {
    return res.status(502).json({ erro: 'banco', detalhe: String(e.message || e) });
  }
};
