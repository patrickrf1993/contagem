const L = require('./_lib');
const papelDe = r => (r && r.papel === 'gestor') ? 'gestor' : 'func';
const respDe = r => (r && r.resp) || L.ADMIN_U;
const semSegredo = (login, r) => ({ login, nome: r.nome, deps: r.deps || [], ativo: !!r.ativo, exporta: !!r.exporta, criado: r.criado || null, papel: papelDe(r), resp: respDe(r) });
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;

async function todos() {
  const [flat] = await L.redis([['HGETALL', 'usuarios']]);
  const o = L.hash(flat), out = [];
  for (const login in o) { const r = L.json(o[login], null); if (r) out.push({ login, r }); }
  return out;
}
// o que um gestor enxerga: só os funcionários da área dele
const meusDe = (u, lista) => lista.filter(x => u.admin || (papelDe(x.r) === 'func' && respDe(x.r) === u.login));
function eventoVisivel(u, e, meus) {
  if (u.admin) return true;
  const s = L.setorDoEvento(e);
  if (s) return u.deps.includes(s);
  return e.u === u.login || meus.has(e.u) || (e.alvo && meus.has(e.alvo));
}

module.exports = async (req, res) => {
  if (!L.base(req, res)) return;
  try {
    const u = await L.exigirUsuario(req, res); if (!u) return;
    if (!L.gestorOuAdmin(u)) return res.status(403).json({ erro: 'admin' });
    const nomeSetor = id => (u.setores.find(s => s.id === id) || {}).nome || id;
    // perfil atual de quem está usando: a tela de gestão atualiza setores e permissões sem precisar relogar
    const eu = { perfil: L.perfil(u), setores: u.setores };

    if (req.method === 'GET') {
      const acao = String(req.query.acao || '');

      if (acao === 'usuarios') {
        const lista0 = await todos();
        const nomes = {}; lista0.forEach(x => { nomes[x.login] = x.r.nome; }); nomes[L.ADMIN_U] = L.mestre(u.setores).nome;
        const lista = meusDe(u, lista0).map(x => ({ ...semSegredo(x.login, x.r), respNome: nomes[respDe(x.r)] || respDe(x.r) }));
        if (lista.length) {
          const out = await L.redis(lista.map(x => ['GET', 'sessao:' + x.login]).concat([['HMGET', 'ultimo', ...lista.map(x => x.login)]]));
          const ult = out[out.length - 1] || [];
          lista.forEach((x, i) => {
            const s = L.json(out[i], null);
            x.online = (s && s.sid !== L.SID_ENCERRADA) ? { ap: s.ap || '', t: s.t } : null;
            x.ultimo = ult[i] ? Number(ult[i]) : null;
          });
        }
        lista.sort((a, b) => (a.papel === b.papel ? 0 : a.papel === 'gestor' ? -1 : 1) || a.nome.localeCompare(b.nome, 'pt-BR'));
        const gestores = u.admin ? lista0.filter(x => papelDe(x.r) === 'gestor').map(x => ({ login: x.login, nome: x.r.nome, deps: x.r.deps || [], exporta: !!x.r.exporta })) : [];
        return res.status(200).json({ mestre: L.perfil(u), adminLogin: L.ADMIN_U, usuarios: lista, gestores, eu });
      }

      if (acao === 'catalogo') {
        const cat = await L.lerCatalogo();
        const itens = {}; (u.admin ? Object.keys(cat.itens) : u.deps).forEach(d => { if (cat.itens[d]) itens[d] = cat.itens[d]; });
        return res.status(200).json({ v: cat.v, catalogo: { t: cat.t, por: cat.por, itens }, salvo: cat.salvo, eu });
      }

      if (acao === 'relatorio') {
        let dias;
        if (RE_DATA.test(String(req.query.dia || ''))) dias = [String(req.query.dia)];
        else dias = L.ultimosDias(Math.max(1, Math.min(L.LOG_DIAS, Number(req.query.dias) || 7)));
        const out = await L.redis(dias.map(d => ['LRANGE', 'log:' + d, '0', '-1']));
        const meus = u.admin ? null : new Set(meusDe(u, await todos()).map(x => x.login));
        let eventos = [];
        out.forEach(arr => (arr || []).forEach(s => { const e = L.json(s, null); if (e && eventoVisivel(u, e, meus)) eventos.push(e); }));
        eventos.sort((a, b) => b.t - a.t);
        const cortado = eventos.length > 15000; if (cortado) eventos = eventos.slice(0, 15000);
        return res.status(200).json({ dias, eventos, cortado, maxDias: L.LOG_DIAS, eu });
      }

      if (acao === 'painel') {
        const data = RE_DATA.test(String(req.query.data || '')) ? String(req.query.data) : L.diaSP(Date.now());
        const vis = u.deps;
        const [flat, fflat, lg, oflat] = await L.redis([['HGETALL', 'cont:' + data], ['HGETALL', 'fech:' + data], ['LRANGE', 'log:' + data, '0', '-1'], ['HGETALL', 'obs:' + data]]);
        const [cat, ref, us] = await Promise.all([L.lerCatalogo(), L.referencias(vis, data), todos()]);
        const itens = {}; const i0 = L.hash(flat);
        for (const k in i0) { const v = L.json(i0[k], null); if (v) itens[L.nk(k)] = v; }
        const fech = L.hash(fflat), obs = L.hash(oflat);
        const meus = meusDe(u, us);
        const meusSet = new Set(meus.map(x => x.login));
        const info = {}; (cat.itens ? Object.keys(cat.itens) : []).forEach(d => (cat.itens[d] || []).forEach(it => { info[d + ':c' + it.c] = it; }));
        const setores = vis.map(id => {
          const lista = cat.itens[id] || [];
          const contados = lista.filter(it => itens[id + ':c' + it.c]).length;
          const s = u.setores.find(x => x.id === id) || { id, nome: id };
          return { id, nome: s.nome, dep: s.dep || '', total: lista.length, contados, fech: L.json(fech[id], null),
            gestores: us.filter(x => papelDe(x.r) === 'gestor' && (x.r.deps || []).includes(id)).map(x => x.r.nome),
            obs: Object.keys(obs).filter(k => k.startsWith(id + ':')).length };
        });
        const horas = {}, divergencias = [];
        for (const k in itens) {
          const dep = k.split(':')[0]; if (!vis.includes(dep)) continue;
          const v = itens[k];
          if (v.t) { const h = L.horaSP(v.t); horas[h] = (horas[h] || 0) + 1; }
          const r = ref[dep] && ref[dep].itens[k];
          if (typeof r === 'number' && r > 0 && typeof v.total === 'number') {
            const varr = (v.total - r) / r;
            if (Math.abs(varr) > 0.3) { const it = info[k] || {}; divergencias.push({ k, setor: dep, nome: it.n || k, und: it.u || '', antes: r, antesData: ref[dep].data, hoje: v.total, por: v.by || '', var: varr }); }
          }
        }
        divergencias.sort((a, b) => Math.abs(b.var) - Math.abs(a.var));
        // quem está com o app aberto agora
        const alvo = u.admin ? us : meus;
        const ses = alvo.length ? await L.redis(alvo.map(x => ['GET', 'sessao:' + x.login])) : [];
        const online = [];
        alvo.forEach((x, i) => { const s = L.json(ses[i], null); if (s && s.sid !== L.SID_ENCERRADA) online.push({ nome: x.r.nome, deps: (x.r.deps || []).filter(d => vis.includes(d)) }); });
        const eventos = (lg || []).map(s => L.json(s, null)).filter(e => e && eventoVisivel(u, e, meusSet)).sort((a, b) => b.t - a.t).slice(0, 20);
        const nomes = {}; for (const k in info) nomes[k] = info[k].n;
        eventos.forEach(e => { if (e.k) e.itemNome = nomes[L.nk(e.k)] || ''; });
        return res.status(200).json({ data, setores, horas, divergencias: divergencias.slice(0, 30), nDivergencias: divergencias.length, online, eventos,
          refDatas: Object.fromEntries(Object.entries(ref).map(([d, r]) => [d, r.data])), eu });
      }

      if (acao === 'backup') {
        if (!u.admin) return res.status(403).json({ erro: 'admin' });
        const dias = Math.max(1, Math.min(400, Number(req.query.dias) || 60));
        await L.garantirDatas();
        const ids = u.setores.map(s => s.id);
        const zs = await L.redis(ids.map(id => ['ZREVRANGEBYSCORE', 'datas:' + id, '+inf', '-inf', 'LIMIT', '0', String(dias)]));
        const datas = [...new Set(zs.flat().filter(Boolean))].sort().reverse().slice(0, dias);
        const [us, st, cat, cv, fat] = await L.redis([['HGETALL', 'usuarios'], ['GET', 'setores'], ['GET', 'catalogo'], ['GET', 'catalogo:v'], ['HGETALL', 'fatores']]);
        const contagens = {};
        for (let i = 0; i < datas.length; i += 30) {
          const parte = datas.slice(i, i + 30);
          const r = await L.redis(parte.flatMap(d => [['HGETALL', 'cont:' + d], ['HGETALL', 'obs:' + d], ['HGETALL', 'fech:' + d]]));
          parte.forEach((d, j) => { contagens[d] = { itens: L.hash(r[j * 3]), obs: L.hash(r[j * 3 + 1]), fech: L.hash(r[j * 3 + 2]) }; });
        }
        await L.redis(L.cmdsLog({ t: Date.now(), u: u.login, nome: u.nome, acao: 'usuario', detalhe: 'Baixou a cópia de segurança (' + datas.length + ' dias de contagem)' }));
        return res.status(200).json({ versao: 1, gerado: new Date().toISOString(), por: u.nome, setores: L.json(st, null), usuarios: L.hash(us),
          catalogo: L.json(cat, null), catalogoV: cv || null, fatores: L.hash(fat), contagens });
      }
      return res.status(400).json({ erro: 'acao' });
    }

    if (req.method !== 'POST') return res.status(405).json({ erro: 'metodo' });
    const b = L.corpo(req);
    const agora = Date.now();
    const ativos = L.idsAtivos(u.setores);

    /* ---------- setores (só o administrador geral) ---------- */
    if (b.acao === 'setores') {
      if (!u.admin) return res.status(403).json({ erro: 'admin' });
      const entrada = Array.isArray(b.lista) ? b.lista : null;
      if (!entrada || !entrada.length) return res.status(400).json({ erro: 'lista', msg: 'Arquivo sem setores.' });
      if (entrada.length > 40) return res.status(400).json({ erro: 'lista', msg: 'No máximo 40 setores.' });
      const novos = new Map();
      for (const s of entrada) {
        const id = String(s && s.id || '').trim().toUpperCase();
        if (!L.RE_SETOR.test(id)) return res.status(400).json({ erro: 'codigo', msg: 'Código de setor inválido: "' + id + '". Use de 2 a 12 letras ou números, começando por letra, sem espaço.' });
        if (novos.has(id)) return res.status(400).json({ erro: 'duplicado', msg: 'Setor repetido: ' + id });
        const nome = String(s.nome || '').trim().slice(0, 40);
        if (!nome) return res.status(400).json({ erro: 'nome', msg: 'Setor ' + id + ' sem nome.' });
        novos.set(id, { id, nome, aba: String(s.aba || '').trim().slice(0, 40) || ('STK ' + id), dep: String(s.dep || '').trim().slice(0, 12), ativo: true });
      }
      const atual = u.setores;
      const final = [...novos.values()].concat(atual.filter(s => !novos.has(s.id)).map(s => ({ ...s, ativo: false })));
      const add = [...novos.keys()].filter(id => !atual.some(s => s.id === id));
      const off = atual.filter(s => s.ativo !== false && !novos.has(s.id)).map(s => s.nome);
      const on = atual.filter(s => s.ativo === false && novos.has(s.id)).map(s => s.nome);
      const ren = atual.filter(s => novos.has(s.id) && (novos.get(s.id).nome !== s.nome || novos.get(s.id).aba !== s.aba || novos.get(s.id).dep !== (s.dep || ''))).map(s => s.id);
      const partes = [];
      if (add.length) partes.push('novos: ' + add.map(id => novos.get(id).nome).join(', '));
      if (off.length) partes.push('desativados: ' + off.join(', '));
      if (on.length) partes.push('reativados: ' + on.join(', '));
      if (ren.length) partes.push('alterados: ' + ren.map(id => novos.get(id).nome).join(', '));
      await L.redis([['SET', 'setores', JSON.stringify({ t: agora, por: u.nome, lista: final })]]
        .concat(L.cmdsLog({ t: agora, u: u.login, nome: u.nome, acao: 'setores', detalhe: 'Atualizou os setores (' + novos.size + ' ativos' + (partes.length ? '; ' + partes.join('; ') : '') + ')' })));
      return res.status(200).json({ ok: true, lista: final });
    }

    /* ---------- lista de insumos (administrador: todos; gestor: só os setores dele) ---------- */
    if (b.acao === 'catalogo') {
      // lista gerada pela macro ExportarInsumos: { SETOR: [{c, n, u, f}] }; só os setores que vieram no arquivo mudam
      const entrada = b.itens && typeof b.itens === 'object' ? b.itens : null;
      if (!entrada || !Object.keys(entrada).length) return res.status(400).json({ erro: 'itens', msg: 'Arquivo sem itens.' });
      const itens = {};
      for (const d of Object.keys(entrada)) {
        if (!ativos.includes(d)) return res.status(400).json({ erro: 'setor', msg: 'Setor desconhecido ou desativado: ' + d });
        if (!u.deps.includes(d)) return res.status(403).json({ erro: 'setor', msg: 'O setor ' + nomeSetor(d) + ' não é da sua área.' });
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
      }
      const cat = await L.lerCatalogo();
      const final = { ...cat.itens, ...itens };
      const totalArq = Object.values(itens).reduce((a, l) => a + l.length, 0);
      const total = Object.values(final).reduce((a, l) => a + l.length, 0);
      if (!totalArq) return res.status(400).json({ erro: 'itens', msg: 'O arquivo não tem itens.' });
      if (total > 6000) return res.status(400).json({ erro: 'itens', msg: 'A lista passou de 6000 itens.' });
      const ver = String(agora);
      const detalhe = 'Atualizou a lista de insumos de ' + L.nomesDeps(Object.keys(itens), u.setores) + ' (' + totalArq + ' itens' + (b.resumo ? ': ' + String(b.resumo).slice(0, 300) : '') + ')';
      await L.redis([['SET', 'catalogo', JSON.stringify({ t: agora, por: u.nome, itens: final })], ['SET', 'catalogo:v', ver]]
        .concat(L.cmdsLog({ t: agora, u: u.login, nome: u.nome, acao: 'catalogo', setores: Object.keys(itens), detalhe })));
      return res.status(200).json({ ok: true, v: ver, total: totalArq });
    }

    /* ---------- usuários ---------- */
    const login = String(b.login || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,30}$/.test(login)) return res.status(400).json({ erro: 'login', msg: 'Use de 3 a 30 letras minúsculas, números, ponto, hífen ou sublinhado, sem espaço.' });
    if (login === L.ADMIN_U) return res.status(400).json({ erro: 'login', msg: 'Esse usuário é o administrador principal.' });
    const lista = await todos();
    const achado = lista.find(x => x.login === login);
    const atual = achado ? achado.r : null;
    // gestor só mexe nos funcionários da área dele
    if (!u.admin && atual && !(papelDe(atual) === 'func' && respDe(atual) === u.login))
      return res.status(403).json({ erro: 'permissao', msg: 'Esse usuário não é da sua área.' });
    const subordinados = lista.filter(x => papelDe(x.r) === 'func' && respDe(x.r) === login);
    const log = d => L.cmdsLog({ t: agora, u: u.login, nome: u.nome, acao: 'usuario', alvo: login, detalhe: d });

    if (b.acao === 'excluir') {
      if (!atual) return res.status(404).json({ erro: 'naoexiste' });
      const cmds = [['HDEL', 'usuarios', login], ['DEL', 'sessao:' + login], ['HDEL', 'ultimo', login]];
      // funcionários de um gestor excluído passam para o administrador geral
      subordinados.forEach(x => cmds.push(['HSET', 'usuarios', x.login, JSON.stringify({ ...x.r, resp: L.ADMIN_U })]));
      cmds.push(...log('Excluiu o usuário ' + atual.nome + ' (' + login + ')' + (subordinados.length ? '; ' + subordinados.length + ' funcionário(s) passaram para o administrador geral' : '')));
      await L.redis(cmds);
      return res.status(200).json({ ok: true });
    }

    if (b.acao === 'encerrar') {
      if (!atual) return res.status(404).json({ erro: 'naoexiste' });
      // deixa uma marca: o aparelho é desconectado, mas ainda consegue entregar contagens guardadas
      await L.redis([['SET', 'sessao:' + login, JSON.stringify({ sid: L.SID_ENCERRADA, t: agora, ap: '' }), 'EX', String(30 * 86400)]]
        .concat(log('Encerrou a sessão de ' + atual.nome)));
      return res.status(200).json({ ok: true, usuario: semSegredo(login, atual) });
    }

    if (b.acao === 'salvar') {
      const novo = !atual;
      if (novo && b.criar !== true) return res.status(404).json({ erro: 'naoexiste' });
      if (!novo && b.criar === true) return res.status(409).json({ erro: 'existe', msg: 'Já existe um usuário com esse login.' });
      const nome = String(b.nome != null ? b.nome : (atual && atual.nome) || '').trim().slice(0, 60);
      if (!nome) return res.status(400).json({ erro: 'nome', msg: 'Informe o nome.' });

      let papel = 'func', resp = u.login;
      if (u.admin) {
        papel = b.papel === 'gestor' || b.papel === 'func' ? b.papel : (atual ? papelDe(atual) : 'func');
        resp = papel === 'gestor' ? L.ADMIN_U : String(b.resp != null ? b.resp : respDe(atual)).trim().toLowerCase() || L.ADMIN_U;
        if (resp !== L.ADMIN_U) {
          const g = lista.find(x => x.login === resp && papelDe(x.r) === 'gestor');
          if (!g || resp === login) return res.status(400).json({ erro: 'resp', msg: 'Escolha um gestor de área válido.' });
        }
      }
      const gestorResp = resp !== L.ADMIN_U ? (lista.find(x => x.login === resp) || {}).r : null;
      // setores: o gestor só libera os dele; um funcionário de gestor fica dentro dos setores do gestor
      const limite = !u.admin ? u.deps : (papel === 'func' && gestorResp ? (gestorResp.deps || []) : ativos);
      let deps = Array.isArray(b.deps) ? b.deps : (atual ? atual.deps || [] : []);
      deps = [...new Set(deps.filter(d => ativos.includes(d) && limite.includes(d)))];
      if (atual) deps = deps.concat((atual.deps || []).filter(d => !ativos.includes(d)));   // guarda setores desativados, caso voltem
      const ativo = typeof b.ativo === 'boolean' ? b.ativo : (atual ? atual.ativo : true);
      const exporta = typeof b.exporta === 'boolean' ? b.exporta : (atual ? !!atual.exporta : false);
      if (exporta && !u.admin && !u.exporta) return res.status(403).json({ erro: 'exporta', msg: 'Você não tem permissão de download para repassar.' });
      const senha = b.senha != null ? String(b.senha) : '';
      if ((novo || senha) && senha.length < L.SENHA_MIN) return res.status(400).json({ erro: 'senha', msg: 'A senha precisa ter pelo menos ' + L.SENHA_MIN + ' caracteres.' });

      const rec = atual ? { ...atual } : { criado: agora, v: 0 };
      rec.nome = nome; rec.deps = deps; rec.ativo = ativo; rec.exporta = exporta; rec.papel = papel; rec.resp = resp;
      if (senha) { Object.assign(rec, L.hashSenha(senha)); }
      if (!novo && (senha || (atual.ativo && !ativo))) rec.v = (rec.v || 0) + 1;   // derruba sessões abertas

      const nomeResp = r => r === L.ADMIN_U ? 'administrador geral' : ((lista.find(x => x.login === r) || {}).r || {}).nome || r;
      const mud = [];
      if (novo) mud.push('Criou ' + (papel === 'gestor' ? 'o gestor de área ' : 'o usuário ') + nome + ' (' + login + ') com setores: ' + L.nomesDeps(deps, u.setores) + (exporta ? ' e download da contagem' : '') + (papel === 'func' && resp !== L.ADMIN_U ? ', na área de ' + nomeResp(resp) : ''));
      else {
        if (atual.nome !== nome) mud.push('Renomeou ' + atual.nome + ' para ' + nome);
        if (papelDe(atual) !== papel) mud.push(papel === 'gestor' ? 'Tornou ' + nome + ' gestor de área' : 'Tornou ' + nome + ' funcionário (deixou de ser gestor)');
        else if (respDe(atual) !== resp) mud.push('Passou ' + nome + ' para a área de ' + nomeResp(resp));
        if (JSON.stringify(atual.deps || []) !== JSON.stringify(deps)) mud.push('Setores de ' + nome + ': ' + L.nomesDeps(deps, u.setores));
        if (atual.ativo !== ativo) mud.push((ativo ? 'Liberou' : 'Bloqueou') + ' o acesso de ' + nome);
        if (!!atual.exporta !== exporta) mud.push((exporta ? 'Liberou' : 'Retirou') + ' o download da contagem para ' + nome);
        if (senha) mud.push('Trocou a senha de ' + nome);
      }
      const cmds = [['HSET', 'usuarios', login, JSON.stringify(rec)]];
      if (!novo && rec.v !== (atual.v || 0)) cmds.push(['DEL', 'sessao:' + login]);
      // efeitos sobre os funcionários de um gestor
      if (!novo && papelDe(atual) === 'gestor' && subordinados.length) {
        let n = 0;
        subordinados.forEach(x => {
          const r2 = { ...x.r };
          if (papel !== 'gestor') r2.resp = L.ADMIN_U;
          else { r2.deps = (r2.deps || []).filter(d => deps.includes(d)); if (!exporta) r2.exporta = false; }
          if (JSON.stringify(r2) !== JSON.stringify(x.r)) { cmds.push(['HSET', 'usuarios', x.login, JSON.stringify(r2)]); n++; }
        });
        if (n) mud.push(papel !== 'gestor' ? n + ' funcionário(s) de ' + nome + ' passaram para o administrador geral' : 'Ajustou os acessos de ' + n + ' funcionário(s) da área de ' + nome);
      }
      mud.forEach(d => cmds.push(...log(d)));
      await L.redis(cmds);
      return res.status(200).json({ ok: true, usuario: { ...semSegredo(login, rec), respNome: nomeResp(resp) } });
    }
    return res.status(400).json({ erro: 'acao' });
  } catch (e) {
    return res.status(502).json({ erro: 'banco', detalhe: String(e.message || e) });
  }
};
