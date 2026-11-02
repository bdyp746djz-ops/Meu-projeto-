// Rafa Busca Peças — Worker para Cloudflare (API + arquivos estáticos).
// Etapa 1: login, localizações, estoque, vendas, fotos (R2), painel.
// Bindings esperados (wrangler.toml): DB (D1), FOTOS (R2), ASSETS (estáticos),
// e o secret SESSION_SECRET.

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- HTTP ----------
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
const bad = (msg, status = 400) => json({ erro: msg }, status);
const uid = () => crypto.randomUUID();
const now = () => Date.now();
// texto para busca sem acento/maiúscula (ex.: "Fusível" -> "fusivel")
const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const buscaDe = p => norm([p.nome, p.marca, p.modelo, p.ano, p.pn, p.veiculo, p.codigo, p.obs].filter(Boolean).join(' '));

function cookies(req) {
  const h = req.headers.get('cookie') || '';
  return Object.fromEntries(
    h.split(';').map(c => c.trim().split('=')).filter(a => a[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])
  );
}
function cookie(name, val, maxAgeSec) {
  return `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

// ---------- cripto: senha (PBKDF2) e sessão (HMAC) ----------
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };

async function hashSenha(senha, saltB64) {
  const salt = saltB64 ? unb64u(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(senha), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return { hash: b64u(bits), salt: b64u(salt) };
}
async function verificaSenha(senha, hashB64, saltB64) {
  const { hash } = await hashSenha(senha, saltB64);
  if (hash.length !== hashB64.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ hashB64.charCodeAt(i);
  return diff === 0;
}
async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function assinaSessao(userId, secret, dias = 30) {
  const payload = b64u(enc.encode(JSON.stringify({ u: userId, e: now() + dias * 864e5 })));
  const sig = b64u(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload)));
  return `${payload}.${sig}`;
}
async function leSessao(token, secret) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  let ok = false;
  try { ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64u(sig), enc.encode(payload)); } catch { return null; }
  if (!ok) return null;
  try { const d = JSON.parse(dec.decode(unb64u(payload))); return d.e < now() ? null : d.u; } catch { return null; }
}

// ---------- roteador ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try { return await api(request, env, url); }
      catch (e) { return bad('erro interno: ' + (e && e.message || e), 500); }
    }
    const res = await env.ASSETS.fetch(request); // SPA + estáticos
    // não cachear o HTML do app: o navegador sempre pega a versão mais nova
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('text/html')) {
      const h = new Headers(res.headers);
      h.set('cache-control', 'no-store, must-revalidate');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
    }
    return res;
  },
};

async function api(request, env, url) {
  const p = url.pathname.replace(/\/+$/, '');
  const m = request.method;
  const secret = env.SESSION_SECRET;
  if (!secret) return bad('SESSION_SECRET não configurado no ambiente', 500);

  // públicas
  if (p === '/api/health') return json({ ok: true });
  if (p === '/api/setup' && m === 'POST') return setup(request, env);
  if (p === '/api/login' && m === 'POST') return login(request, env, secret);
  // retorno do Mercado Livre (vem de fora, protegido pelo state) — público
  if (p === '/api/ml/callback' && m === 'GET') return mlCallback(env, url);
  // foto pública: o Mercado Livre precisa baixar a imagem para montar o anúncio
  { const mf = p.match(/^\/api\/foto\/(.+)$/); if (mf && m === 'GET') return serveFoto(decodeURIComponent(mf[1]), env); }

  // autenticação
  const userId = await leSessao(cookies(request).sess, secret);
  if (!userId) return bad('não autenticado', 401);
  const user = await env.DB.prepare('SELECT id,nome,login,papel FROM usuarios WHERE id=?').bind(userId).first();
  if (!user) return bad('sessão inválida', 401);

  if (p === '/api/logout' && m === 'POST') return json({ ok: true }, 200, { 'set-cookie': cookie('sess', '', 0) });
  if (p === '/api/me' && m === 'GET') return json({ user });

  // localizações
  if (p === '/api/locais' && m === 'GET') return listaLocais(env);
  if (p === '/api/locais' && m === 'POST') return criaLocais(request, env);
  let mt = p.match(/^\/api\/locais\/([\w-]+)$/);
  if (mt && m === 'PATCH') return atualizaLocal(mt[1], request, env);
  if (mt && m === 'DELETE') return excluiLocal(mt[1], env);

  // peças
  if (p === '/api/sugestoes' && m === 'GET') return sugestoes(url, env);
  if (p === '/api/mover' && m === 'POST') return mover(request, env, user);
  if (p === '/api/relatorios/produtividade' && m === 'GET') return produtividade(url, env);
  if (p === '/api/pecas/massa' && m === 'POST') return editaMassa(request, env);
  mt = p.match(/^\/api\/peca-codigo\/(\d+)$/);
  if (mt && m === 'GET') return pecaPorCodigo(mt[1], env);
  if (p === '/api/pecas' && m === 'GET') return listaPecas(url, env);
  if (p === '/api/pecas' && m === 'POST') return criaPeca(request, env, user);
  mt = p.match(/^\/api\/pecas\/([\w-]+)$/);
  if (mt && m === 'GET') return getPeca(mt[1], env);
  if (mt && m === 'PATCH') return atualizaPeca(mt[1], request, env);
  if (mt && m === 'DELETE') return excluiPeca(mt[1], env);
  mt = p.match(/^\/api\/pecas\/([\w-]+)\/foto$/);
  if (mt && m === 'POST') return subirFoto(mt[1], request, env);

  // fotos (R2): servidas publicamente na seção pública acima

  // vendas
  if (p === '/api/vendas' && m === 'GET') return listaVendas(url, env);
  if (p === '/api/vendas' && m === 'POST') return criaVenda(request, env);
  mt = p.match(/^\/api\/vendas\/([\w-]+)\/cancelar$/);
  if (mt && m === 'POST') return cancelaVenda(mt[1], env);

  if (p === '/api/painel' && m === 'GET') return painel(env);

  // integrações / Mercado Livre
  if (p === '/api/config' && m === 'GET') return getConfig(env, url);
  if (p === '/api/ml/credenciais' && m === 'POST') return mlSalvaCred(request, env, user);
  if (p === '/api/ml/connect' && m === 'GET') return mlConnect(env, url, user);
  if (p === '/api/ml/exchange' && m === 'POST') return mlExchange(request, env, url, user);
  if (p === '/api/ml/desconectar' && m === 'POST') return mlDesconecta(env, user);
  mt = p.match(/^\/api\/ml\/rascunho\/([\w-]+)$/);
  if (mt && m === 'GET') return mlRascunho(mt[1], env, url, user);
  if (p === '/api/ml/publicar' && m === 'POST') return mlPublicar(request, env, url, user);

  return bad('rota não encontrada', 404);
}

// ---------- config (chave/valor) ----------
async function ensureConfig(env) {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS config (chave TEXT PRIMARY KEY, valor TEXT, atualizado_em INTEGER)').run();
}
async function getCfg(env, chave) {
  await ensureConfig(env);
  const r = await env.DB.prepare('SELECT valor FROM config WHERE chave=?').bind(chave).first();
  return r ? r.valor : null;
}
async function setCfg(env, chave, valor) {
  await ensureConfig(env);
  await env.DB.prepare('INSERT INTO config (chave,valor,atualizado_em) VALUES (?,?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor, atualizado_em=excluded.atualizado_em')
    .bind(chave, valor == null ? '' : String(valor), now()).run();
}

// ---------- Mercado Livre (OAuth) ----------
const ML_AUTH = 'https://auth.mercadolivre.com.br/authorization';
const ML_API = 'https://api.mercadolibre.com';

async function getConfig(env, url) {
  const appId = await getCfg(env, 'ml_app_id');
  const token = await getCfg(env, 'ml_access_token');
  const nick = await getCfg(env, 'ml_nickname');
  const erro = await getCfg(env, 'ml_ultimo_erro');
  return json({ ml: { appIdSet: !!appId, conectado: !!token, nickname: nick || null, ultimoErro: erro || null, redirectUri: url.origin + '/api/ml/callback' } });
}
async function mlSalvaCred(request, env, user) {
  if (user.papel !== 'admin') return bad('somente o administrador', 403);
  const { appId, secret } = await request.json();
  if (appId) await setCfg(env, 'ml_app_id', String(appId).trim());
  if (secret) await setCfg(env, 'ml_secret', String(secret).trim());
  const a = await getCfg(env, 'ml_app_id'), s = await getCfg(env, 'ml_secret');
  if (!a || !s) return bad('informe o App ID e o Secret');
  return json({ ok: true });
}
async function pkce() {
  const verifier = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64u(await crypto.subtle.digest('SHA-256', enc.encode(verifier)));
  return { verifier, challenge };
}
async function mlConnect(env, url, user) {
  if (user.papel !== 'admin') return bad('somente o administrador', 403);
  const appId = await getCfg(env, 'ml_app_id');
  if (!appId) return bad('configure o App ID e o Secret primeiro');
  const { verifier, challenge } = await pkce();
  const state = b64u(crypto.getRandomValues(new Uint8Array(16)));
  await setCfg(env, 'ml_pkce_verifier', verifier);
  await setCfg(env, 'ml_oauth_state', state);
  const redirect = url.origin + '/api/ml/callback';
  const auth = `${ML_AUTH}?response_type=code&client_id=${encodeURIComponent(appId)}&redirect_uri=${encodeURIComponent(redirect)}&code_challenge=${challenge}&code_challenge_method=S256&state=${state}`;
  return json({ url: auth });
}
async function mlGuardaToken(env, d) {
  await setCfg(env, 'ml_access_token', d.access_token);
  if (d.refresh_token) await setCfg(env, 'ml_refresh_token', d.refresh_token);
  await setCfg(env, 'ml_token_exp', String(now() + (Number(d.expires_in || 21600) * 1000)));
}
// troca o "code" pelo token de acesso; usada pelo callback e pelo app (XHR)
async function mlTrocaCodigo(env, origin, code, state) {
  if (!code) return { ok: false, erro: 'não veio o código de autorização' };
  if (!state || state !== (await getCfg(env, 'ml_oauth_state'))) return { ok: false, erro: 'verificação de segurança (state) não bateu — conecte de novo sem clicar várias vezes' };
  const appId = await getCfg(env, 'ml_app_id');
  const secret = await getCfg(env, 'ml_secret');
  const verifier = await getCfg(env, 'ml_pkce_verifier');
  const redirect = origin + '/api/ml/callback';
  const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: appId, client_secret: secret, code, redirect_uri: redirect, code_verifier: verifier });
  let r, d;
  try {
    r = await fetch(ML_API + '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
    d = await r.json().catch(() => ({}));
  } catch (e) { return { ok: false, erro: 'falha de rede ao falar com o Mercado Livre: ' + (e && e.message || e) }; }
  if (!r.ok || !d.access_token) {
    const det = d.error ? (d.error + (d.error_description ? ' — ' + d.error_description : '')) : (d.message || ('HTTP ' + (r ? r.status : '?')));
    return { ok: false, erro: 'troca do código falhou: ' + det };
  }
  await mlGuardaToken(env, d);
  let nickname = null;
  try {
    const me = await fetch(ML_API + '/users/me', { headers: { Authorization: 'Bearer ' + d.access_token } });
    const mu = await me.json();
    if (mu && mu.nickname) { nickname = mu.nickname; await setCfg(env, 'ml_nickname', mu.nickname); }
    if (mu && mu.id) await setCfg(env, 'ml_user_id', String(mu.id));
  } catch { /* nickname é opcional */ }
  await setCfg(env, 'ml_oauth_state', '');
  await setCfg(env, 'ml_pkce_verifier', '');
  return { ok: true, nickname };
}
// fallback: se o worker receber o callback direto (navegação)
async function mlCallback(env, url) {
  const erroMl = url.searchParams.get('error');
  let erro = '';
  if (erroMl) erro = 'Mercado Livre recusou: ' + erroMl;
  else { const r = await mlTrocaCodigo(env, url.origin, url.searchParams.get('code'), url.searchParams.get('state')); if (!r.ok) erro = r.erro; }
  await setCfg(env, 'ml_ultimo_erro', erro);
  return new Response(null, { status: 302, headers: { Location: url.origin + '/#integracoes?ml=' + (erro ? 'erro' : 'ok') } });
}
// caminho principal: o app manda o code por XHR (a Cloudflare entrega o SPA no callback)
async function mlExchange(request, env, url, user) {
  if (user.papel !== 'admin') return bad('somente o administrador', 403);
  const { code, state } = await request.json().catch(() => ({}));
  const r = await mlTrocaCodigo(env, url.origin, code, state);
  await setCfg(env, 'ml_ultimo_erro', r.ok ? '' : r.erro);
  if (!r.ok) return bad(r.erro);
  return json({ ok: true, nickname: r.nickname || null });
}
// token de acesso válido (renova com refresh_token quando perto de expirar)
async function mlToken(env) {
  let token = await getCfg(env, 'ml_access_token');
  const exp = Number(await getCfg(env, 'ml_token_exp') || 0);
  if (token && now() < exp - 120000) return token;
  const refresh = await getCfg(env, 'ml_refresh_token');
  const appId = await getCfg(env, 'ml_app_id');
  const secret = await getCfg(env, 'ml_secret');
  if (!refresh || !appId || !secret) return token || null;
  const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: appId, client_secret: secret, refresh_token: refresh });
  const r = await fetch(ML_API + '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
  const d = await r.json().catch(() => ({}));
  if (r.ok && d.access_token) { await mlGuardaToken(env, d); return d.access_token; }
  return token || null;
}
// monta título (≤60) e descrição a partir da peça
function anuncioDe(p) {
  const veic = [p.marca, p.modelo, p.ano].filter(Boolean).join(' ');
  let titulo = [p.nome, p.pn, veic].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (titulo.length > 60) titulo = titulo.slice(0, 60).replace(/\s\S*$/, '');
  const desc = `${p.nome}${veic ? ' ' + veic : ''}\n\n` +
    `✅ Condição: ${p.cond || 'Usada, em bom estado'}\n` +
    (p.pn ? `🔢 Código original: ${p.pn}\n` : '') +
    `🚗 ${p.veiculo ? 'Retirada de ' + p.veiculo + '. ' : ''}Confira a compatibilidade pelo código antes de comprar.\n` +
    `📦 Enviamos para todo o Brasil.\n🛡️ Garantia de 90 dias.\n\nCódigo interno: ${String(p.codigo).padStart(6, '0')}`;
  return { titulo, desc };
}
// prevê a categoria no catálogo do ML a partir do título
async function mlCategoria(token, titulo) {
  try {
    const r = await fetch(ML_API + '/sites/MLB/domain_discovery/search?limit=1&q=' + encodeURIComponent(titulo), { headers: { Authorization: 'Bearer ' + token } });
    const d = await r.json().catch(() => ([]));
    if (Array.isArray(d) && d[0] && d[0].category_id) return d[0].category_id;
  } catch { /* sem categoria prevista */ }
  return null;
}
// rascunho (pré-visualização) — não publica nada
async function mlRascunho(pecaId, env, url, user) {
  const token = await mlToken(env);
  if (!token) return bad('conecte o Mercado Livre primeiro (aba Integrações)');
  const row = await env.DB.prepare('SELECT * FROM pecas WHERE id=?').bind(pecaId).first();
  if (!row) return bad('peça não encontrada', 404);
  const p = parsePeca(row);
  const { titulo, desc } = anuncioDe(p);
  const fotos = (p.fotos || []).map(k => url.origin + '/api/foto/' + k);
  const categoria = await mlCategoria(token, titulo);
  let catNome = null;
  if (categoria) { try { const c = await (await fetch(ML_API + '/categories/' + categoria)).json(); catNome = c && c.name; } catch { /* nome é opcional */ } }
  return json({ rascunho: { titulo, desc, preco: p.preco, qtd: Math.max(1, Number(p.qtd) || 1), fotos, categoria, catNome } });
}
// publica o anúncio no Mercado Livre
async function mlPublicar(request, env, url, user) {
  if (user.papel !== 'admin') return bad('somente o administrador', 403);
  const b = await request.json().catch(() => ({}));
  const token = await mlToken(env);
  if (!token) return bad('conecte o Mercado Livre primeiro (aba Integrações)');
  const row = await env.DB.prepare('SELECT * FROM pecas WHERE id=?').bind(b.pecaId).first();
  if (!row) return bad('peça não encontrada', 404);
  const p = parsePeca(row);
  const base = anuncioDe(p);
  const titulo = (b.titulo || base.titulo).slice(0, 60);
  const preco = Number(b.preco || p.preco);
  if (!preco || preco <= 0) return bad('defina um preço para a peça antes de publicar');
  const fotos = (p.fotos || []).map(k => ({ source: url.origin + '/api/foto/' + k }));
  if (!fotos.length) return bad('a peça precisa de pelo menos uma foto para anunciar');
  const categoria = b.categoria || await mlCategoria(token, titulo);
  if (!categoria) return bad('não consegui identificar a categoria no Mercado Livre — ajuste o título e tente de novo');
  const atributos = [];
  if (p.marca) atributos.push({ id: 'BRAND', value_name: String(p.marca) });
  if (p.pn) atributos.push({ id: 'PART_NUMBER', value_name: String(p.pn) });
  const item = {
    title: titulo, category_id: categoria, price: preco, currency_id: 'BRL',
    available_quantity: Math.max(1, Number(p.qtd) || 1), buying_mode: 'buy_it_now',
    condition: 'used', listing_type_id: b.tipo || 'gold_special', pictures: fotos, attributes: atributos,
  };
  let r, d;
  try {
    r = await fetch(ML_API + '/items', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(item) });
    d = await r.json().catch(() => ({}));
  } catch (e) { return bad('falha de rede ao publicar: ' + (e && e.message || e)); }
  if (!r.ok || !d.id) {
    let det = d.message || ('HTTP ' + (r ? r.status : '?'));
    if (Array.isArray(d.cause) && d.cause.length) det += ' — ' + d.cause.map(c => c.message || c.code).filter(Boolean).join('; ');
    return bad('o Mercado Livre recusou: ' + det);
  }
  try {
    await fetch(ML_API + '/items/' + d.id + '/description', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ plain_text: b.desc || base.desc }) });
  } catch { /* descrição é secundária */ }
  try { await env.DB.prepare('UPDATE pecas SET ml=1, ml_id=?, ml_link=? WHERE id=?').bind(String(d.id), d.permalink || '', p.id).run(); } catch { /* marcação é secundária */ }
  return json({ ok: true, id: d.id, permalink: d.permalink || null, status: d.status || null });
}
async function mlDesconecta(env, user) {
  if (user.papel !== 'admin') return bad('somente o administrador', 403);
  for (const k of ['ml_access_token', 'ml_refresh_token', 'ml_token_exp', 'ml_nickname', 'ml_user_id']) await setCfg(env, k, '');
  return json({ ok: true });
}

// ---------- autenticação ----------
async function setup(request, env) {
  const n = await env.DB.prepare('SELECT COUNT(*) c FROM usuarios').first();
  if (n.c > 0) return bad('sistema já configurado', 403);
  const { nome, login: lg, senha } = await request.json();
  if (!lg || !senha) return bad('login e senha são obrigatórios');
  const { hash, salt } = await hashSenha(senha);
  const id = uid();
  await env.DB.prepare('INSERT INTO usuarios (id,nome,login,senha_hash,salt,papel,criado_em) VALUES (?,?,?,?,?,?,?)')
    .bind(id, nome || 'Administrador', lg, hash, salt, 'admin', now()).run();
  return json({ ok: true });
}
async function login(request, env, secret) {
  const { login: lg, senha } = await request.json();
  const u = await env.DB.prepare('SELECT * FROM usuarios WHERE login=?').bind(lg).first();
  if (!u || !(await verificaSenha(senha, u.senha_hash, u.salt))) return bad('login ou senha incorretos', 401);
  const token = await assinaSessao(u.id, secret);
  return json({ ok: true, user: { id: u.id, nome: u.nome, login: u.login, papel: u.papel } },
    200, { 'set-cookie': cookie('sess', token, 30 * 86400) });
}

// ---------- localizações ----------
async function listaLocais(env) {
  // inclui a capacidade e a ocupação (nº de peças com estoque guardadas direto no local)
  const r = await env.DB.prepare(
    `SELECT l.id, l.nome, l.pai, l.capacidade,
       (SELECT COUNT(*) FROM pecas p WHERE p.local_id = l.id AND p.qtd > 0) AS ocupacao
     FROM locais l`
  ).all();
  return json({ locais: r.results });
}
const capVal = v => (v === '' || v == null) ? null : (parseInt(v) || null);
async function criaLocais(request, env) {
  const { nome, pai, quantidade, capacidade } = await request.json();
  if (!nome) return bad('nome é obrigatório');
  const q = Math.min(50, Math.max(1, parseInt(quantidade) || 1));
  const cap = capVal(capacidade);
  const base = String(nome).match(/^(.*?)(\d+|[A-Za-z])$/);
  const criados = [];
  for (let i = 0; i < q; i++) {
    let nm = nome;
    if (i > 0 && base) nm = /\d/.test(base[2]) ? base[1] + (parseInt(base[2]) + i) : base[1] + String.fromCharCode(base[2].charCodeAt(0) + i);
    else if (i > 0) nm = `${nome}-${i + 1}`;
    const id = uid();
    await env.DB.prepare('INSERT INTO locais (id,nome,pai,capacidade,criado_em) VALUES (?,?,?,?,?)').bind(id, nm, pai || null, cap, now()).run();
    criados.push({ id, nome: nm, pai: pai || null, capacidade: cap });
  }
  return json({ criados });
}
async function atualizaLocal(id, request, env) {
  const b = await request.json();
  const sets = [], binds = [];
  if (b.nome != null && b.nome !== '') { sets.push('nome=?'); binds.push(b.nome); }
  if ('capacidade' in b) { sets.push('capacidade=?'); binds.push(capVal(b.capacidade)); }
  if (!sets.length) return json({ ok: true });
  binds.push(id);
  await env.DB.prepare(`UPDATE locais SET ${sets.join(',')} WHERE id=?`).bind(...binds).run();
  return json({ ok: true });
}
async function excluiLocal(id, env) {
  const filhos = await env.DB.prepare('SELECT COUNT(*) c FROM locais WHERE pai=?').bind(id).first();
  const pecas = await env.DB.prepare('SELECT COUNT(*) c FROM pecas WHERE local_id=?').bind(id).first();
  if (filhos.c > 0 || pecas.c > 0) return bad('este local ainda tem conteúdo; mova ou exclua antes', 409);
  await env.DB.prepare('DELETE FROM locais WHERE id=?').bind(id).run();
  return json({ ok: true });
}

// ---------- peças ----------
function parsePeca(row) {
  if (row && typeof row.fotos === 'string') { try { row.fotos = JSON.parse(row.fotos); } catch { row.fotos = []; } }
  return row;
}
async function proxCodigo(env) {
  const r = await env.DB.prepare('SELECT MAX(codigo) m FROM pecas').first();
  return (r.m || 0) + 1;
}
async function listaPecas(url, env) {
  const q = (url.searchParams.get('q') || '').trim();
  const local = url.searchParams.get('local') || '';
  const status = url.searchParams.get('status') || '';
  const cond = [], binds = [];
  // cada palavra da busca precisa aparecer (ex.: "caixa fusivel" acha "Caixa de Fusível")
  for (const w of norm(q).split(/\s+/).filter(Boolean)) { cond.push('busca LIKE ?'); binds.push('%' + w + '%'); }
  if (local) {
    const sub = await env.DB.prepare(
      'WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT l.id FROM locais l JOIN sub ON l.pai=sub.id) SELECT id FROM sub'
    ).bind(local).all();
    const ids = sub.results.map(r => r.id);
    if (!ids.length) return json({ pecas: [] });
    cond.push(`local_id IN (${ids.map(() => '?').join(',')})`);
    binds.push(...ids);
  }
  if (status === 'disp') cond.push('qtd>0');
  else if (status === 'zerado') cond.push('qtd<=0');
  else if (status === 'semanuncio') cond.push('qtd>0 AND ml=0 AND olx=0');
  else if (status === 'semlocal') cond.push('(local_id IS NULL OR local_id NOT IN (SELECT id FROM locais))');
  else if (status === 'parado') { cond.push('qtd>0 AND criado_em < ?'); binds.push(now() - 90 * 864e5); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const r = await env.DB.prepare(`SELECT * FROM pecas ${where} ORDER BY criado_em DESC LIMIT 500`).bind(...binds).all();
  return json({ pecas: r.results.map(parsePeca) });
}
async function getPeca(id, env) {
  const r = await env.DB.prepare('SELECT * FROM pecas WHERE id=?').bind(id).first();
  if (!r) return bad('peça não encontrada', 404);
  return json({ peca: parsePeca(r) });
}
async function pecaPorCodigo(codigo, env) {
  const r = await env.DB.prepare('SELECT * FROM pecas WHERE codigo=?').bind(parseInt(codigo)).first();
  if (!r) return bad('peça não encontrada', 404);
  return json({ peca: parsePeca(r) });
}
// sugestões "enquanto digita": peças parecidas no catálogo próprio (Etapa 2 soma anúncios do ML)
async function sugestoes(url, env) {
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length < 2) return json({ sugestoes: [] });
  const cond = [], binds = [];
  for (const w of norm(q).split(/\s+/).filter(Boolean)) { cond.push('busca LIKE ?'); binds.push('%' + w + '%'); }
  if (!cond.length) return json({ sugestoes: [] });
  const r = await env.DB.prepare(
    `SELECT nome, marca, modelo, ano, pn, cond, preco, MAX(criado_em) AS ult, COUNT(*) AS n
     FROM pecas WHERE ${cond.join(' AND ')}
     GROUP BY COALESCE(NULLIF(pn, ''), lower(nome))
     ORDER BY n DESC, ult DESC LIMIT 8`
  ).bind(...binds).all();
  return json({ sugestoes: r.results });
}
const CAMPOS = ['nome', 'marca', 'modelo', 'ano', 'pn', 'cond', 'veiculo', 'preco', 'qtd', 'local_id', 'obs', 'ml', 'ml_id', 'ml_link', 'olx', 'olx_link'];
async function criaPeca(request, env, user) {
  const b = await request.json();
  if (!b.nome) return bad('nome é obrigatório');
  const id = uid();
  const codigo = b.codigo ? parseInt(b.codigo) : await proxCodigo(env); // permite manter código do iBR na importação
  await env.DB.prepare(
    `INSERT INTO pecas (id,codigo,nome,marca,modelo,ano,pn,cond,veiculo,preco,qtd,local_id,obs,busca,fotos,ml,ml_link,olx,olx_link,criado_em,criado_por)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, codigo, b.nome, b.marca || null, b.modelo || null, b.ano || null, b.pn || null, b.cond || null,
    b.veiculo || null, Number(b.preco) || 0, parseInt(b.qtd) || 0, b.local_id || null, b.obs || null,
    buscaDe({ ...b, codigo }), JSON.stringify(b.fotos || []), b.ml ? 1 : 0, b.ml_link || null, b.olx ? 1 : 0, b.olx_link || null, now(), (user && user.id) || null).run();
  return getPeca(id, env);
}
// edição em massa: muda preço, local ou marcação de anúncio de várias peças de uma vez
async function editaMassa(request, env) {
  const { ids, set } = await request.json();
  if (!Array.isArray(ids) || !ids.length || !set) return bad('informe as peças e o que alterar');
  const sets = [], binds = [];
  if ('preco' in set) { sets.push('preco=?'); binds.push(Number(set.preco) || 0); }
  if ('local_id' in set) { sets.push('local_id=?'); binds.push(set.local_id || null); }
  if ('ml' in set) { sets.push('ml=?'); binds.push(set.ml ? 1 : 0); }
  if ('olx' in set) { sets.push('olx=?'); binds.push(set.olx ? 1 : 0); }
  if (!sets.length) return bad('nada para alterar');
  sets.push('atualizado_em=?'); binds.push(now());
  const placeholders = ids.map(() => '?').join(',');
  await env.DB.prepare(`UPDATE pecas SET ${sets.join(',')} WHERE id IN (${placeholders})`).bind(...binds, ...ids).run();
  return json({ ok: true, alteradas: ids.length });
}
// mover peças para um local, registrando o histórico (quem moveu, de onde, para onde)
async function mover(request, env, user) {
  const { ids, local_id } = await request.json();
  if (!Array.isArray(ids) || !ids.length) return bad('informe as peças');
  let n = 0;
  for (const id of ids) {
    const p = await env.DB.prepare('SELECT id,codigo,nome,local_id FROM pecas WHERE id=?').bind(id).first();
    if (!p) continue;
    await env.DB.prepare('UPDATE pecas SET local_id=?, atualizado_em=? WHERE id=?').bind(local_id || null, now(), id).run();
    await env.DB.prepare(
      'INSERT INTO movimentacoes (id,peca_id,codigo,nome,de_local,para_local,usuario_id,usuario_nome,data) VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind(uid(), p.id, p.codigo, p.nome, p.local_id || null, local_id || null, (user && user.id) || null, (user && user.nome) || null, now()).run();
    n++;
  }
  return json({ ok: true, movidas: n });
}
// produtividade: peças cadastradas por funcionário no período
async function produtividade(url, env) {
  const periodo = url.searchParams.get('periodo') || 'hoje';
  let ini = 0; const d = new Date();
  if (periodo === 'hoje') { d.setHours(0, 0, 0, 0); ini = d.getTime(); }
  else if (periodo === 'mes') ini = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const r = await env.DB.prepare(
    `SELECT COALESCE(u.nome, 'Sem registro') AS nome, COUNT(*) AS cadastros
     FROM pecas p LEFT JOIN usuarios u ON u.id = p.criado_por
     WHERE p.criado_em >= ? GROUP BY p.criado_por ORDER BY cadastros DESC`
  ).bind(ini).all();
  return json({ periodo, porFuncionario: r.results });
}
async function atualizaPeca(id, request, env) {
  const atual = await env.DB.prepare('SELECT id FROM pecas WHERE id=?').bind(id).first();
  if (!atual) return bad('peça não encontrada', 404);
  const b = await request.json();
  const sets = [], binds = [];
  for (const c of CAMPOS) {
    if (c in b) {
      sets.push(`${c}=?`);
      if (c === 'preco') binds.push(Number(b[c]) || 0);
      else if (c === 'qtd') binds.push(parseInt(b[c]) || 0);
      else if (c === 'ml' || c === 'olx') binds.push(b[c] ? 1 : 0);
      else binds.push(b[c] ?? null);
    }
  }
  if (Array.isArray(b.fotos)) { sets.push('fotos=?'); binds.push(JSON.stringify(b.fotos)); }
  if (!sets.length) return getPeca(id, env);
  sets.push('atualizado_em=?'); binds.push(now());
  binds.push(id);
  await env.DB.prepare(`UPDATE pecas SET ${sets.join(',')} WHERE id=?`).bind(...binds).run();
  // recalcula o texto de busca a partir do registro já atualizado
  const row = await env.DB.prepare('SELECT nome,marca,modelo,ano,pn,veiculo,codigo,obs FROM pecas WHERE id=?').bind(id).first();
  await env.DB.prepare('UPDATE pecas SET busca=? WHERE id=?').bind(buscaDe(row), id).run();
  return getPeca(id, env);
}
async function excluiPeca(id, env) {
  await env.DB.prepare('DELETE FROM pecas WHERE id=?').bind(id).run();
  return json({ ok: true });
}

// ---------- fotos (R2) ----------
async function subirFoto(pecaId, request, env) {
  const peca = await env.DB.prepare('SELECT fotos FROM pecas WHERE id=?').bind(pecaId).first();
  if (!peca) return bad('peça não encontrada', 404);
  const ct = request.headers.get('content-type') || 'image/jpeg';
  if (!ct.startsWith('image/')) return bad('envie uma imagem');
  const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg';
  const key = `pecas/${pecaId}/${uid()}.${ext}`;
  await env.FOTOS.put(key, request.body, { httpMetadata: { contentType: ct } });
  const fotos = JSON.parse(peca.fotos || '[]');
  fotos.push(key);
  await env.DB.prepare('UPDATE pecas SET fotos=?, atualizado_em=? WHERE id=?').bind(JSON.stringify(fotos), now(), pecaId).run();
  return json({ key, url: `/api/foto/${key}`, fotos });
}
async function serveFoto(key, env) {
  const obj = await env.FOTOS.get(key);
  if (!obj) return bad('foto não encontrada', 404);
  return new Response(obj.body, {
    headers: { 'content-type': obj.httpMetadata?.contentType || 'image/jpeg', 'cache-control': 'public, max-age=31536000' },
  });
}

// ---------- vendas ----------
async function listaVendas(url, env) {
  const periodo = url.searchParams.get('periodo') || 'mes';
  let ini = 0;
  const d = new Date();
  if (periodo === 'hoje') { d.setHours(0, 0, 0, 0); ini = d.getTime(); }
  else if (periodo === '7d') ini = now() - 7 * 864e5;
  else if (periodo === 'mes') ini = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const r = await env.DB.prepare('SELECT * FROM vendas WHERE data>=? ORDER BY data DESC LIMIT 1000').bind(ini).all();
  return json({ vendas: r.results });
}
async function criaVenda(request, env) {
  const b = await request.json();
  const peca = await env.DB.prepare('SELECT * FROM pecas WHERE id=?').bind(b.peca_id).first();
  if (!peca) return bad('peça não encontrada', 404);
  const qtd = Math.max(1, parseInt(b.qtd) || 1);
  if (qtd > peca.qtd) return bad('quantidade maior que o estoque', 409);
  const unit = Number(b.unit) || peca.preco || 0;
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO vendas (id,peca_id,nome,codigo,qtd,unit,total,canal,cliente,pagamento,local_path,data)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, peca.id, peca.nome, peca.codigo, qtd, unit, qtd * unit, b.canal || 'Balcão',
    b.cliente || null, b.pagamento || null, b.local_path || null, now()).run();
  await env.DB.prepare('UPDATE pecas SET qtd=qtd-?, atualizado_em=? WHERE id=?').bind(qtd, now(), peca.id).run();
  return json({ ok: true, id });
}
async function cancelaVenda(id, env) {
  const v = await env.DB.prepare('SELECT * FROM vendas WHERE id=?').bind(id).first();
  if (!v) return bad('venda não encontrada', 404);
  if (v.cancelada) return json({ ok: true });
  await env.DB.prepare('UPDATE vendas SET cancelada=1 WHERE id=?').bind(id).run();
  await env.DB.prepare('UPDATE pecas SET qtd=qtd+?, atualizado_em=? WHERE id=?').bind(v.qtd, now(), v.peca_id).run();
  return json({ ok: true });
}

// ---------- painel ----------
async function painel(env) {
  const inicioMes = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); })();
  const est = await env.DB.prepare('SELECT COUNT(*) cadastros, COALESCE(SUM(qtd),0) pecas, COALESCE(SUM(qtd*preco),0) valor FROM pecas').first();
  const vend = await env.DB.prepare('SELECT COUNT(*) n, COALESCE(SUM(total),0) total FROM vendas WHERE cancelada=0 AND data>=?').bind(inicioMes).first();
  const semAnuncio = await env.DB.prepare('SELECT COUNT(*) c FROM pecas WHERE qtd>0 AND ml=0 AND olx=0').first();
  const semLocal = await env.DB.prepare('SELECT COUNT(*) c FROM pecas WHERE local_id IS NULL OR local_id NOT IN (SELECT id FROM locais)').first();
  const parado = await env.DB.prepare('SELECT COUNT(*) c FROM pecas WHERE qtd>0 AND criado_em < ?').bind(now() - 90 * 864e5).first();
  const canais = await env.DB.prepare('SELECT canal, SUM(total) total FROM vendas WHERE cancelada=0 AND data>=? GROUP BY canal').bind(inicioMes).all();
  const ultimas = await env.DB.prepare('SELECT id,nome,codigo,total,canal,data,cancelada FROM vendas ORDER BY data DESC LIMIT 8').all();
  return json({
    estoque: { cadastros: est.cadastros, pecas: est.pecas, valor: est.valor },
    vendasMes: { n: vend.n, total: vend.total },
    semAnuncio: semAnuncio.c, semLocal: semLocal.c, parado: parado.c,
    porCanal: canais.results, ultimas: ultimas.results,
  });
}
