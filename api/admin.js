const L = require('./_lib');
const semSegredo = (login, u) => ({ login, nome: u.nome, deps: u.deps || [], ativo: !!u.ativo, exporta: !!u.exporta, criado: u.criado || null });

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
      if (acao === 'catalogo') {
        const [c, cv] = await L.redis([['GET', 'catalogo'], ['GET', 'catalogo:v']]);
        let cat = null; try { cat = JSON.parse(c || 'null'); } catch (e) {}
        return res.status(200).json({ v: cv || null, catalogo: cat });
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
      const agora0 = Date.now();
      if (b.acao === 'catalogo') { const agora = agora0;
        // lista de insumos gerada pela macro ExportarInsumos: { DEP: [{c, n, u, f}] }
        const entrada = b.itens && typeof b.itens === 'object' ? b.itens : null;
        if (!entrada) return res.status(400).json({ erro: 'itens', msg: 'Arquivo sem itens.' });
        const itens = {}; let total = 0;
        for (const d of Object.keys(entrada)) {
          if (!L.DEPS.includes(d)) return res.status(400).json({ erro: 'setor', msg: 'Setor desconhecido: ' + d });
          const lista = Array.isArray(entrada[d]) ? entrada[d] : [];
          const vistos = new Set(); itens[d] = [];
          for (const it of lista) {
            const c = String(it && it.c || '').trim();
            if (!/^[A-Za-z0-9._-]{1,30}$/.test(c)) return res.status(400).json({ erro: 'codigo', msg: 'Código inválido em ' + d + ': "' + c + '"' });
            if (vistos.has(c)) return res.status(400).json({ erro: 'duplicado', msg: 'Código repetido em ' + d + ': ' + c });
            vistos.add(c);
            const f = it.f == null || it.f === '' ? null : Number(it.f);
            itens[d].push({ c, n: String(it.n || '').trim().slice(0, 120) || c, u: String(it.u || '').trim().slice(0, 12), f: f != null && isFinite(f) && f > 0 ? f : null });
          }
          total += itens[d].length;
        }
        if (!total || total > 3000) return res.status(400).json({ erro: 'itens', msg: 'A lista precisa ter entre 1 e 3000 itens.' });
        const ver = String(agora);
        const detalhe = 'Atualizou a lista de insumos (' + total + ' itens' + (b.resumo ? ': ' + String(b.resumo).slice(0, 300) : '') + ')';
        await L.redis([['SET', 'catalogo', JSON.stringify({ t: agora, por: u.nome, itens })], ['SET', 'catalogo:v', ver]]
          .concat(L.cmdsLog({ t: agora, u: u.login, nome: u.nome, acao: 'usuario', detalhe })));
        return res.status(200).json({ ok: true, v: ver, total });
      }
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
        const exporta = typeof b.exporta === 'boolean' ? b.exporta : (atual ? !!atual.exporta : false);
        const senha = b.senha != null ? String(b.senha) : '';
        if (novo && senha.length < 4) return res.status(400).json({ erro: 'senha', msg: 'A senha precisa ter pelo menos 4 caracteres.' });
        if (senha && senha.length < 4) return res.status(400).json({ erro: 'senha', msg: 'A senha precisa ter pelo menos 4 caracteres.' });

        const rec = atual ? { ...atual } : { criado: agora, v: 0 };
        rec.nome = nome; rec.deps = deps; rec.ativo = ativo; rec.exporta = exporta;
        if (senha) { Object.assign(rec, L.hashSenha(senha)); }
        if (!novo && (senha || (atual.ativo && !ativo))) rec.v = (rec.v || 0) + 1;   // derruba sessões abertas

        const mud = [];
        if (novo) mud.push('Criou o usuário ' + nome + ' (' + login + ') com setores: ' + L.nomesDeps(deps) + (exporta ? ' e download da contagem' : ''));
        else {
          if (atual.nome !== nome) mud.push('Renomeou ' + atual.nome + ' para ' + nome);
          if (JSON.stringify(atual.deps || []) !== JSON.stringify(deps)) mud.push('Setores de ' + nome + ': ' + L.nomesDeps(deps));
          if (atual.ativo !== ativo) mud.push((ativo ? 'Liberou' : 'Bloqueou') + ' o acesso de ' + nome);
          if (!!atual.exporta !== exporta) mud.push((exporta ? 'Liberou' : 'Retirou') + ' o download da contagem para ' + nome);
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
