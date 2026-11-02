// Rafa Busca Peças — Worker para Cloudflare (API + arquivos estáticos).
// Etapa 1: login, localizações, estoque, vendas, fotos (R2), painel.
// Bindings esperados (wrangler.toml): DB (D1), FOTOS (R2), ASSETS (estáticos),
// e o secret SESSION_SECRET.

import { sugerirPreco } from './preco.js';

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
// horário de Brasília (UTC-3): início do dia / do mês para relatórios
const BR = 3 * 3600e3;
const inicioDiaBR = () => { const d = new Date(Date.now() - BR); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + BR; };
const inicioMesBR = (off = 0) => { const d = new Date(Date.now() - BR); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + off, 1) + BR; };
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
  // a cada 2 min: confere os vídeos que o Google está gerando (mesmo com o app fechado)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(veoAtualiza(env).catch(e => console.log('veo', e && e.message)));
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
  // vídeo público (com Range, o iPhone exige) e o gerador de vídeo do PC (entra com a chave dele, sem cookie)
  { const mv = p.match(/^\/api\/video\/(videos\/[\w\-\/.]+)$/); if (mv && (m === 'GET' || m === 'HEAD')) return serveVideo(mv[1], request, env); }
  if (p.startsWith('/api/agente/') && !['/api/agente/instalador', '/api/agente/status', '/api/agente/chave'].includes(p)) return agenteApi(p, m, request, env, url);

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
  if (p === '/api/pecas/etiquetas' && m === 'POST') return marcaEtiquetas(request, env);
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
  // vídeos com IA (gerados no PC)
  if (p === '/api/videos' && m === 'POST') {
    const b = await request.json().catch(() => ({}));
    return b.motor === 'veo' ? veoNovo(env, b, user) : novoVideo(env, b);
  }
  if (p === '/api/videos' && m === 'GET') return listaVideos(url, env);
  mt = p.match(/^\/api\/videos\/([\w-]+)\/repetir$/);
  if (mt && m === 'POST') return repeteVideo(mt[1], env);
  // vídeo com IA do Google (Veo, pela API do Gemini)
  if (p === '/api/veo' && m === 'GET') return json(veoResumo(await veoCfg(env)));
  if (p === '/api/veo' && m === 'POST') return veoSalva(request, env, user);
  if (p === '/api/gemini/foto' && m === 'POST') return gmFoto(request, env, user, url);
  if (p === '/api/agente/status' && m === 'GET') return json(await agenteResumo(env));
  if (p === '/api/ia/comandos' && m === 'GET') return json(await comandosIA(env));
  if (p === '/api/ia/foto' && m === 'POST') return criaFotoIA(request, env);
  mt = p.match(/^\/api\/pecas\/([\w-]+)\/fotos-originais$/);
  if (mt && m === 'POST') return fotosOriginais(mt[1], request, env, url);
  if (p === '/api/ia/comandos' && m === 'POST') return salvaComandosIA(request, env, user);
  if (p === '/api/agente/instalador' && m === 'GET') return agenteInstalador(env, url, user);
  if (p === '/api/agente/chave' && m === 'POST') return agenteNovaChave(env, user);
  if (p === '/api/ml/expedicao' && m === 'GET') return mlExpedicao(env);
  // perguntas dos compradores
  if (p === '/api/ml/perguntas/contagem' && m === 'GET') return mlPergContagem(env);
  if (p === '/api/ml/perguntas' && m === 'GET') return mlPerguntas(url, env);
  mt = p.match(/^\/api\/ml\/perguntas\/(\d+)\/(responder|sugerir)$/);
  if (mt && m === 'POST') return mt[2] === 'responder' ? mlResponde(mt[1], request, env) : mlSugereResposta(mt[1], env);
  // importar anúncios da conta do ML para o sistema (com fotos e ficha técnica)
  if (p === '/api/ml/importar' && m === 'GET') return mlImportLista(url, env, user);
  mt = p.match(/^\/api\/ml\/importar\/(MLB\d+)$/i);
  if (mt && m === 'POST') return mlImportaItem(mt[1].toUpperCase(), request, env, user);
  mt = p.match(/^\/api\/ml\/dce\/(\d+)$/);
  if (mt && (m === 'GET' || m === 'POST')) return mlDce(mt[1], m, env, user);
  mt = p.match(/^\/api\/ml\/dce\/(\d+)\/doc\/([\w-]+)$/);
  if (mt && m === 'GET') return mlDceDoc(mt[1], mt[2], url, env);
  mt = p.match(/^\/api\/ml\/etiqueta-envio\/(\d+)$/);
  if (mt && m === 'GET') return mlEtiquetaEnvio(mt[1], env);

  // integrações / Mercado Livre
  if (p === '/api/config' && m === 'GET') return getConfig(env, url);
  if (p === '/api/ml/credenciais' && m === 'POST') return mlSalvaCred(request, env, user);
  if (p === '/api/ml/connect' && m === 'GET') return mlConnect(env, url, user);
  if (p === '/api/ml/exchange' && m === 'POST') return mlExchange(request, env, url, user);
  if (p === '/api/ml/desconectar' && m === 'POST') return mlDesconecta(env, user);
  mt = p.match(/^\/api\/ml\/rascunho\/([\w-]+)$/);
  if (mt && m === 'GET') return mlRascunho(mt[1], env, url, user);
  if (p === '/api/ml/publicar' && m === 'POST') return mlPublicar(request, env, url, user);
  if (p === '/api/ml/categorias' && m === 'GET') return mlBuscaCategorias(url, env);
  if (p === '/api/ml/atributos' && m === 'GET') return mlAtributos(url, env);
  mt = p.match(/^\/api\/ml\/preco\/([\w-]+)$/);
  if (mt && m === 'GET') return mlPreco(mt[1], env);
  mt = p.match(/^\/api\/ml\/item\/([\w-]+)$/);
  if (mt && m === 'GET') return mlItem(mt[1], env);
  if (mt && m === 'POST') return mlItemAcao(mt[1], request, env, user);

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
// categorias que o Mercado Livre prevê para um texto (até `limite`), com o caminho completo
async function mlCaminho(cat) {
  try {
    const c = await (await fetch(ML_API + '/categories/' + encodeURIComponent(cat))).json();
    return (c.path_from_root || []).map(x => x.name).join(' › ') || c.name || null;
  } catch { return null; }
}
async function mlCategorias(token, texto, limite = 5, info = {}) {
  let lista = [];
  try {
    const r = await fetch(ML_API + '/sites/MLB/domain_discovery/search?limit=' + limite + '&q=' + encodeURIComponent(texto), { headers: token ? { Authorization: 'Bearer ' + token } : {} });
    const d = await r.json().catch(() => []);
    if (Array.isArray(d)) lista = d.filter(x => x && x.category_id);
    else info.erro = (d && (d.message || d.error)) || ('HTTP ' + r.status);
  } catch (e) { info.erro = e.message; }
  const vistos = new Set(); lista = lista.filter(x => !vistos.has(x.category_id) && vistos.add(x.category_id));
  return Promise.all(lista.map(async x => ({
    id: x.category_id, nome: x.category_name || '', dominio: x.domain_name || '',
    caminho: (await mlCaminho(x.category_id)) || x.category_name || x.category_id,
    previstos: Object.fromEntries((x.attributes || []).filter(a => a && a.id).map(a => [a.id, { id: a.value_id || null, nome: a.value_name || '' }])),
  })));
}
// memória: embalagem usada antes para o mesmo nome de peça
const mlEmbChave = nome => 'mlemb:' + norm(nome).replace(/\s+/g, ' ').trim().slice(0, 80);
// memória: categoria usada antes para o mesmo nome de peça
const mlMemChave = nome => 'mlcat:' + norm(nome).replace(/\s+/g, ' ').trim().slice(0, 80);
// rascunho (pré-visualização) — não publica nada
async function mlRascunho(pecaId, env, url, user) {
  const token = await mlToken(env);
  if (!token) return bad('conecte o Mercado Livre primeiro (Anúncios ML → Conexão)');
  const row = await env.DB.prepare('SELECT * FROM pecas WHERE id=?').bind(pecaId).first();
  if (!row) return bad('peça não encontrada', 404);
  const p = parsePeca(row);
  const { titulo, desc } = anuncioDe(p);
  const fotos = (p.fotos || []).map(k => url.origin + '/api/foto/' + k);
  const categorias = await mlCategorias(token, titulo, 5);
  let mem = null; try { mem = JSON.parse((await getCfg(env, mlMemChave(p.nome))) || 'null'); } catch { /* sem memória */ }
  if (mem && mem.id) {
    const i = categorias.findIndex(c => c.id === mem.id);
    const c = i >= 0 ? categorias.splice(i, 1)[0] : { id: mem.id, nome: '', dominio: '', caminho: mem.caminho || mem.id, previstos: {} };
    c.memoria = true; categorias.unshift(c);
  }
  let embalagem = { peso_g: p.peso_g, alt_cm: p.alt_cm, larg_cm: p.larg_cm, comp_cm: p.comp_cm, origem: 'peca' };
  if (!(p.peso_g && p.alt_cm && p.larg_cm && p.comp_cm)) {
    try { const m = JSON.parse((await getCfg(env, mlEmbChave(p.nome))) || 'null'); if (m) embalagem = { ...m, origem: 'memoria' }; } catch { /* sem memória */ }
  }
  if (p.ml_cat) {
    const i = categorias.findIndex(c => c.id === p.ml_cat);
    const c = i >= 0 ? categorias.splice(i, 1)[0] : { id: p.ml_cat, nome: '', dominio: '', caminho: p.ml_cat_nome || p.ml_cat, previstos: {} };
    c.cadastro = true; categorias.unshift(c);
  }
  return json({ rascunho: { titulo, desc, preco: p.preco, qtd: Math.max(1, Number(p.qtd) || 1), fotos, categorias, categoria: categorias[0] ? categorias[0].id : null, embalagem } });
}
// buscar categorias por um texto livre
async function mlBuscaCategorias(url, env) {
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length < 2) return json({ categorias: [] });
  if (/^MLB\d+$/i.test(q)) {  // código da categoria digitado direto
    const cat = q.toUpperCase(), caminho = await mlCaminho(cat);
    return json({ categorias: caminho ? [{ id: cat, nome: '', dominio: '', caminho, previstos: {} }] : [] });
  }
  const info = {};
  const categorias = await mlCategorias(await mlToken(env), q, 6, info);
  return json({ categorias, erro: categorias.length ? null : info.erro || null });
}
// ficha técnica (atributos) de uma categoria, simplificada para o formulário
async function mlAtributos(url, env) {
  const cat = url.searchParams.get('cat');
  if (!cat) return bad('informe a categoria');
  let d;
  try { d = await (await fetch(ML_API + '/categories/' + encodeURIComponent(cat) + '/attributes')).json(); }
  catch { return bad('não consegui ler a ficha técnica dessa categoria'); }
  if (!Array.isArray(d)) return bad('o Mercado Livre não devolveu a ficha técnica (' + ((d && (d.message || d.error)) || 'sem detalhe') + ')');
  const atributos = d.filter(a => a && a.id && !(a.tags && (a.tags.hidden || a.tags.read_only || a.tags.fixed))).map(a => {
    const t = a.tags || {};
    return {
      id: a.id, nome: a.name || a.id, tipo: a.value_type || 'string',
      obrig: !!(t.required || t.catalog_required), cond: !!t.conditional_required, relev: a.relevance || 2,
      valores: (a.values || []).slice(0, 400).map(v => ({ id: v.id, nome: v.name })),
      unidades: (a.allowed_units || []).map(u => u.name || u.id), unidade: a.default_unit || null,
      dica: a.hint || a.tooltip || '', max: a.value_max_length || null,
    };
  });
  return json({ atributos });
}
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
  const categoria = b.categoria || ((await mlCategorias(token, titulo, 1))[0] || {}).id;
  if (!categoria) return bad('não consegui identificar a categoria no Mercado Livre — ajuste o título e tente de novo');
  const atributos = [];
  if (Array.isArray(b.atributos)) {
    // ficha técnica preenchida na tela (value_id quando bate com a lista do ML, senão texto)
    for (const a of b.atributos) {
      if (!a || !a.id || atributos.find(x => x.id === a.id) || /^SELLER_PACKAGE_/.test(a.id)) continue;
      if (a.value_id) atributos.push({ id: String(a.id), value_id: String(a.value_id) });
      else if (a.value_name != null && String(a.value_name).trim()) atributos.push({ id: String(a.id), value_name: String(a.value_name).trim().slice(0, 255) });
    }
  } else {
    if (p.marca) atributos.push({ id: 'BRAND', value_name: String(p.marca) });
    if (p.pn) atributos.push({ id: 'PART_NUMBER', value_name: String(p.pn) });
  }
  const e0 = b.embalagem || {};
  const emb = { peso_g: numOuNull(e0.peso_g) ?? numOuNull(p.peso_g), alt_cm: numOuNull(e0.alt_cm) ?? numOuNull(p.alt_cm), larg_cm: numOuNull(e0.larg_cm) ?? numOuNull(p.larg_cm), comp_cm: numOuNull(e0.comp_cm) ?? numOuNull(p.comp_cm) };
  if (emb.peso_g != null) emb.peso_g = Math.round(emb.peso_g);
  const pac = [['SELLER_PACKAGE_HEIGHT', emb.alt_cm, 'cm'], ['SELLER_PACKAGE_WIDTH', emb.larg_cm, 'cm'], ['SELLER_PACKAGE_LENGTH', emb.comp_cm, 'cm'], ['SELLER_PACKAGE_WEIGHT', emb.peso_g, 'g']];
  for (const [aid, v, u] of pac) if (v != null && Number(v) > 0 && !atributos.find(a => a.id === aid)) atributos.push({ id: aid, value_name: Number(v) + ' ' + u });
  const yt = String(p.video || '').match(/(?:youtu\.be\/|v=|shorts\/|embed\/)([\w-]{11})/);
  const item = {
    title: titulo, category_id: categoria, price: preco, currency_id: 'BRL',
    available_quantity: Math.max(1, Number(p.qtd) || 1), buying_mode: 'buy_it_now',
    condition: condML(p.cond), listing_type_id: b.tipo || 'gold_special', pictures: fotos, attributes: atributos,
    sale_terms: [{ id: 'WARRANTY_TYPE', value_name: 'Garantia do vendedor' }, { id: 'WARRANTY_TIME', value_name: '90 dias' }],
  };
  if (yt) item.video_id = yt[1];
  // contas no modelo novo do ML ("User Products") exigem family_name no lugar do title
  const posta = async corpo => {
    const r = await fetch(ML_API + '/items', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(corpo) });
    const d = await r.json().catch(() => ({}));
    let det = d.message || ('HTTP ' + r.status);
    if (Array.isArray(d.cause) && d.cause.length) det += ' — ' + d.cause.map(c => c.message || c.code).filter(Boolean).join('; ');
    return { ok: r.ok && !!d.id, d, det };
  };
  const comFamilia = () => { const c = { ...item, family_name: titulo }; delete c.title; return c; };
  let res;
  try {
    const up = (await getCfg(env, 'ml_up')) === '1';
    res = await posta(up ? comFamilia() : item);
    if (!res.ok && !up && /family_name/i.test(res.det)) {            // 1ª vez: o ML avisou que é o modelo novo
      res = await posta(comFamilia());
      if (!res.ok && /\btitle\b/i.test(res.det)) res = await posta({ ...item, family_name: titulo }); // pede os dois
      if (res.ok) await setCfg(env, 'ml_up', '1');
    } else if (!res.ok && up && /\btitle\b/i.test(res.det)) res = await posta({ ...item, family_name: titulo });
  } catch (e) { return bad('falha de rede ao publicar: ' + (e && e.message || e)); }
  if (!res.ok) return bad('o Mercado Livre recusou: ' + res.det);
  const d = res.d;
  try {
    await fetch(ML_API + '/items/' + d.id + '/description', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ plain_text: b.desc || base.desc }) });
  } catch { /* descrição é secundária */ }
  try { await garanteColsPecas(env); await env.DB.prepare('UPDATE pecas SET ml=1, ml_id=?, ml_link=?, ml_status=?, ml_em=?, ml_cat=?, ml_cat_nome=COALESCE(?,ml_cat_nome) WHERE id=?').bind(String(d.id), d.permalink || '', d.status || 'active', now(), categoria, b.caminho ? String(b.caminho).slice(0, 300) : null, p.id).run(); } catch { /* marcação é secundária */ }
  try { await setCfg(env, mlMemChave(p.nome), JSON.stringify({ id: categoria, caminho: String(b.caminho || '').slice(0, 300) })); } catch { /* memória é secundária */ }
  if (emb.peso_g && emb.alt_cm && emb.larg_cm && emb.comp_cm) {   // guarda a embalagem na peça e para as próximas iguais
    try { await env.DB.prepare('UPDATE pecas SET peso_g=?, alt_cm=?, larg_cm=?, comp_cm=? WHERE id=?').bind(emb.peso_g, emb.alt_cm, emb.larg_cm, emb.comp_cm, p.id).run(); } catch { /* secundário */ }
    try { await setCfg(env, mlEmbChave(p.nome), JSON.stringify(emb)); } catch { /* secundário */ }
  }
  return json({ ok: true, id: d.id, permalink: d.permalink || null, status: d.status || null, sub: d.sub_status || [], avisos: mlAvisos(d) });
}
// avisos que o ML devolve junto com o anúncio (ex.: motivo de ficar pausado)
const mlAvisos = d => (Array.isArray(d && d.warnings) ? d.warnings : []).map(w => (w && (w.message || w.code)) || '').filter(Boolean).slice(0, 5);
// condição do anúncio a partir da condição da peça
const condML = c => /^nov/.test(norm(c)) ? 'new' : 'used';
// chamada genérica à API do ML (lança erro com o motivo que o ML devolver)
async function mlReq(token, metodo, caminho, corpo) {
  const r = await fetch(ML_API + caminho, { method: metodo, headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: corpo ? JSON.stringify(corpo) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    let det = d.message || ('HTTP ' + r.status);
    if (Array.isArray(d.cause) && d.cause.length) det += ' — ' + d.cause.map(c => c.message || c.code).filter(Boolean).join('; ');
    throw new Error(det);
  }
  return d;
}
const ML_ITEM_CAMPOS = 'id,status,sub_status,permalink,price,available_quantity,sold_quantity,listing_type_id,health,date_created,warnings,tags';
// situação do anúncio vinculado à peça
async function mlItem(pecaId, env) {
  await garanteColsPecas(env);
  const p = await env.DB.prepare('SELECT id,ml_id,ml_status FROM pecas WHERE id=?').bind(pecaId).first();
  if (!p) return bad('peça não encontrada', 404);
  if (!p.ml_id) return json({ item: null });
  const token = await mlToken(env);
  if (!token) return bad('conecte o Mercado Livre primeiro');
  try {
    const d = await mlReq(token, 'GET', '/items/' + encodeURIComponent(p.ml_id) + '?attributes=' + ML_ITEM_CAMPOS);
    const st = (p.ml_status === 'paused_venda' && d.status === 'paused') ? 'paused_venda' : d.status;
    if (st && st !== p.ml_status) await env.DB.prepare('UPDATE pecas SET ml_status=?, ml_link=COALESCE(?,ml_link) WHERE id=?').bind(st, d.permalink || null, p.id).run();
    return json({ item: { id: d.id, status: st, sub: d.sub_status || [], link: d.permalink || null, preco: d.price, qtd: d.available_quantity, vendidos: d.sold_quantity || 0, tipo: d.listing_type_id, saude: d.health ?? null, criado: d.date_created || null, avisos: mlAvisos(d) } });
  } catch (e) { return bad('não consegui ler o anúncio no Mercado Livre: ' + e.message); }
}
// pausar / retomar / sincronizar preço e estoque / finalizar / desvincular
async function mlItemAcao(pecaId, request, env, user) {
  if (user.papel !== 'admin') return bad('somente o administrador', 403);
  await garanteColsPecas(env);
  const { acao } = await request.json().catch(() => ({}));
  const p = await env.DB.prepare('SELECT id,ml_id,qtd,preco,fotos FROM pecas WHERE id=?').bind(pecaId).first();
  if (!p) return bad('peça não encontrada', 404);
  if (acao === 'desvincular') {
    await env.DB.prepare('UPDATE pecas SET ml=0, ml_id=NULL, ml_link=NULL, ml_status=NULL, atualizado_em=? WHERE id=?').bind(now(), p.id).run();
    return json({ ok: true, status: null });
  }
  if (!p.ml_id) return bad('esta peça não tem anúncio vinculado');
  const token = await mlToken(env);
  if (!token) return bad('conecte o Mercado Livre primeiro');
  const q = Number(p.qtd) || 0;
  let corpo;
  if (acao === 'pausar') corpo = { status: 'paused' };
  else if (acao === 'retomar') { if (q <= 0) return bad('a peça está sem estoque: ajuste a quantidade antes de reativar'); corpo = { status: 'active' }; }
  else if (acao === 'sincronizar') corpo = q > 0 ? { price: Number(p.preco) || 0, available_quantity: q } : null;
  else if (acao === 'fotos') {
    let ks = []; try { ks = JSON.parse(p.fotos || '[]'); } catch { /* sem fotos */ }
    if (!ks.length) return bad('a peça não tem fotos');
    const origem = new URL(request.url).origin;
    corpo = { pictures: ks.slice(0, 12).map(k => ({ source: origem + '/api/foto/' + k })) };
  }
  else if (acao === 'finalizar') {
    // PROTEÇÃO: o sistema nunca finaliza anúncio que já teve venda (perderia o histórico/reputação do anúncio)
    let it;
    try { it = await mlReq(token, 'GET', '/items/' + encodeURIComponent(p.ml_id) + '?attributes=id,status,sold_quantity'); }
    catch (e) { return bad('não consegui conferir as vendas do anúncio — nada foi feito (' + e.message + ')'); }
    if (it.sold_quantity == null) return bad('não consegui confirmar que o anúncio não tem vendas — por segurança, nada foi feito', 409);
    if (Number(it.sold_quantity) > 0) return bad('🔒 este anúncio tem ' + it.sold_quantity + ' venda(s): o sistema não finaliza anúncio com vendas. Se precisar tirar do ar, use Pausar.', 409);
    corpo = { status: 'closed' };
  }
  else return bad('ação inválida');
  try {
    // o ML aceita melhor estoque e status em pedidos separados
    if (acao === 'retomar') await mlReq(token, 'PUT', '/items/' + encodeURIComponent(p.ml_id), { available_quantity: q });
    const d = corpo ? await mlReq(token, 'PUT', '/items/' + encodeURIComponent(p.ml_id), corpo) : await mlSemEstoque(token, p.ml_id);
    const st = d.status || corpo.status || 'active';
    await env.DB.prepare('UPDATE pecas SET ml_status=?, ml=?, atualizado_em=? WHERE id=?').bind(st, st === 'closed' ? 0 : 1, now(), p.id).run();
    return json({ ok: true, status: st });
  } catch (e) { return bad('o Mercado Livre recusou: ' + e.message); }
}
// sem estoque: zera a quantidade (o ML deixa "pausado por falta de estoque" e reativa sozinho
// quando o estoque volta, sem perder vendas nem posição); só pausa se o ML não aceitar zero.
// Nunca finaliza.
async function mlSemEstoque(token, mlId) {
  try { return await mlReq(token, 'PUT', '/items/' + encodeURIComponent(mlId), { available_quantity: 0 }); }
  catch { return await mlReq(token, 'PUT', '/items/' + encodeURIComponent(mlId), { status: 'paused' }); }
}
// depois de venda/cancelamento: sem estoque → pausa o anúncio; com estoque → atualiza a quantidade (e reativa se foi pausado pela venda)
async function mlAposEstoque(env, pecaId) {
  try {
    await garanteColsPecas(env);
    const p = await env.DB.prepare('SELECT id,ml_id,ml_status,qtd FROM pecas WHERE id=?').bind(pecaId).first();
    if (!p || !p.ml_id || p.ml_status === 'closed') return null;
    const token = await mlToken(env);
    if (!token) return null;
    const q = Number(p.qtd) || 0;
    if (q <= 0) {
      await mlSemEstoque(token, p.ml_id);
      await env.DB.prepare("UPDATE pecas SET ml_status='paused_venda' WHERE id=?").bind(p.id).run();
      return 'pausado';
    }
    let d = await mlReq(token, 'PUT', '/items/' + encodeURIComponent(p.ml_id), { available_quantity: q });
    const reativa = p.ml_status === 'paused_venda';
    if (reativa && d.status !== 'active') d = await mlReq(token, 'PUT', '/items/' + encodeURIComponent(p.ml_id), { status: 'active' });
    await env.DB.prepare('UPDATE pecas SET ml_status=? WHERE id=?').bind(d.status || (reativa ? 'active' : p.ml_status) || 'active', p.id).run();
    return reativa ? 'reativado' : 'atualizado';
  } catch (e) { return 'erro: ' + e.message; }
}
// ---------- preço de mercado: anúncios usados parecidos no ML ----------
const ML_COND_USADO = '2230581';
async function mlBuscaAnuncios(token, params) {
  const r = await fetch(ML_API + '/sites/MLB/search?' + new URLSearchParams({ limit: '50', ...params }), { headers: { Authorization: 'Bearer ' + token } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.message || ('HTTP ' + r.status)); e.status = r.status; throw e; }
  return Array.isArray(d.results) ? d.results : [];
}
const mlAttr = (it, id) => ((it.attributes || []).find(a => a && a.id === id) || {}).value_name || '';
// palavras que importam no título (pra conferir se um anúncio é da mesma peça)
const PARADAS = new Set(['para', 'com', 'sem', 'dos', 'das', 'del', 'the', 'por', 'original', 'usado', 'usada', 'novo', 'nova', 'peca', 'pecas', 'lado', 'kit']);
const palavrasDe = t => norm(t).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length >= 3 && !PARADAS.has(w));
function parecido(titulo, pal, pn) {
  const t = norm(titulo).replace(/[^a-z0-9 ]/g, ' ');
  if (pn && t.replace(/\s/g, '').includes(pn)) return true;
  if (!pal.length || !t.includes(pal[0])) return false;   // a 1ª palavra é o tipo da peça (farol, solenoide...)
  return pal.filter(w => t.includes(w)).length >= Math.min(2, pal.length);
}
async function mlPreco(pecaId, env) {
  const token = await mlToken(env);
  if (!token) return bad('conecte o Mercado Livre primeiro (Anúncios ML → Conexão)');
  await garanteColsPecas(env);
  const row = await env.DB.prepare('SELECT * FROM pecas WHERE id=?').bind(pecaId).first();
  if (!row) return bad('peça não encontrada', 404);
  const p = parsePeca(row);
  const eu = String((await getCfg(env, 'ml_user_id')) || '-');
  const q = [p.nome, p.marca, p.modelo].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const pal = palavrasDe(p.nome + ' ' + (p.marca || '') + ' ' + (p.modelo || ''));
  const pnLimpo = norm(p.pn || '').replace(/[^a-z0-9]/g, '');
  const tentativas = [], buscas = [];
  let anuncios = [], fonte = null;
  const deOutro = sid => String(sid ?? '') !== eu;
  // 1) busca de anúncios (a melhor; o ML pode bloquear para alguns apps)
  try {
    const achados = new Map();
    const junta = l => { for (const it of l) if (it && it.id && !achados.has(it.id) && deOutro((it.seller && it.seller.id) ?? it.seller_id)) achados.set(it.id, it); };
    if (p.pn) { buscas.push('código ' + p.pn); junta(await mlBuscaAnuncios(token, { q: p.pn, ITEM_CONDITION: ML_COND_USADO })); }
    if (achados.size < 5) {
      let cat = p.ml_cat || null;
      if (!cat) try { cat = ((await mlCategorias(token, q, 1))[0] || {}).id || null; } catch { /* sem categoria */ }
      buscas.push('nome "' + q + '"');
      junta(await mlBuscaAnuncios(token, { q, ITEM_CONDITION: ML_COND_USADO, ...(cat ? { category: cat } : {}) }));
    }
    anuncios = [...achados.values()].filter(it => !it.condition || it.condition === 'used').map(it => ({
      id: it.id, titulo: it.title || '', preco: it.price, link: it.permalink || null,
      pn: mlAttr(it, 'PART_NUMBER') || mlAttr(it, 'OEM') || mlAttr(it, 'ORIGINAL_PART_NUMBER'),
      foto: it.thumbnail ? String(it.thumbnail).replace(/^http:/, 'https:') : null, frete: !!(it.shipping && it.shipping.free_shipping),
    }));
    fonte = 'busca'; tentativas.push('busca: ok');
  } catch (e) { tentativas.push('busca: ' + (e.status || '') + ' ' + e.message); }
  // 2) catálogo do ML: produtos parecidos e os anúncios que concorrem neles
  if (!fonte) {
    try {
      const prods = ((await mlReq(token, 'GET', '/products/search?status=active&site_id=MLB&q=' + encodeURIComponent(p.pn || q))).results || [])
        .filter(x => x && x.id && parecido(x.name || '', pal, pnLimpo)).slice(0, 3);
      for (const pr of prods) {
        const its = (await mlReq(token, 'GET', '/products/' + encodeURIComponent(pr.id) + '/items').catch(() => ({}))).results || [];
        for (const it of its) if (it && deOutro(it.seller_id) && (!it.condition || it.condition === 'used'))
          anuncios.push({ id: it.item_id || it.id, titulo: pr.name || '', preco: it.price, link: 'https://www.mercadolivre.com.br/p/' + pr.id, pn: '', foto: null, frete: !!(it.shipping && it.shipping.free_shipping) });
      }
      buscas.push('catálogo "' + (p.pn || q) + '"'); tentativas.push('catálogo: ' + prods.length + ' produto(s)');
      if (anuncios.length) fonte = 'catalogo';
    } catch (e) { tentativas.push('catálogo: ' + e.message); }
  }
  // 3) mais vendidos da categoria, só os de título parecido
  if (!fonte) {
    try {
      let cat = p.ml_cat || null;
      if (!cat) cat = ((await mlCategorias(token, q, 1))[0] || {}).id || null;
      if (!cat) throw new Error('sem categoria');
      const ids = ((await mlReq(token, 'GET', '/highlights/MLB/category/' + encodeURIComponent(cat))).content || []).filter(x => x && x.type === 'ITEM' && x.id).map(x => x.id).slice(0, 20);
      if (ids.length) {
        const lista = await mlReq(token, 'GET', '/items?ids=' + ids.join(',') + '&attributes=id,title,price,condition,permalink,thumbnail,seller_id,shipping');
        for (const r of (Array.isArray(lista) ? lista : [])) { const it = r && r.body; if (!it || r.code !== 200 || !deOutro(it.seller_id)) continue;
          if (it.condition && it.condition !== 'used') continue; if (!parecido(it.title || '', pal, pnLimpo)) continue;
          anuncios.push({ id: it.id, titulo: it.title || '', preco: it.price, link: it.permalink || null, pn: '', foto: it.thumbnail ? String(it.thumbnail).replace(/^http:/, 'https:') : null, frete: !!(it.shipping && it.shipping.free_shipping) }); }
      }
      buscas.push('mais vendidos da categoria ' + cat); tentativas.push('mais vendidos: ' + ids.length + ' anúncio(s)');
      if (anuncios.length) fonte = 'mais_vendidos';
    } catch (e) { tentativas.push('mais vendidos: ' + e.message); }
  }
  if (!fonte) return bad('o Mercado Livre não liberou a pesquisa de preços para este app (' + tentativas.join(' · ') + ')');
  const r = sugerirPreco({ pn: p.pn }, anuncios);
  const conf = fonte === 'busca' ? r.confianca : (r.sugerido ? 'baixa (' + (fonte === 'catalogo' ? 'pelo catálogo' : 'pelos mais vendidos') + ')' : r.confianca);
  const enx = a => ({ id: a.id, titulo: a.titulo, preco: a.preco, link: a.link, foto: a.foto, frete: a.frete, pnBate: !!a.pnBate });
  return json({
    fonte, buscas, tentativas, total: anuncios.length, sugerido: r.sugerido, confianca: conf,
    usados: [...r.usados].sort((a, b) => a.preco - b.preco).slice(0, 15).map(enx),
    descartados: r.descartados.slice(0, 10).map(d => ({ ...enx(d.anuncio), motivo: d.motivo })), nDescartados: r.descartados.length,
  });
}
// ---------- expedição: pedidos pagos do ML que ainda precisam ser enviados ----------
async function mlExpedicao(env) {
  const token = await mlToken(env);
  if (!token) return json({ conectado: false, pedidos: [] });
  const seller = await getCfg(env, 'ml_user_id');
  if (!seller) return json({ conectado: true, pedidos: [], aviso: 'reconecte o Mercado Livre para ler os pedidos' });
  await garanteColsPecas(env); await garanteColsVendas(env);
  let d;
  try { d = await mlReq(token, 'GET', '/orders/search?seller=' + encodeURIComponent(seller) + '&order.status=paid&sort=date_desc&limit=25'); }
  catch (e) { return bad('não consegui ler os pedidos do Mercado Livre: ' + e.message); }
  const ordens = Array.isArray(d.results) ? d.results : [];
  // envios em paralelo (no máx. 25 consultas ao ML)
  const envios = await Promise.all(ordens.map(async o => {
    if (!o.shipping || !o.shipping.id) return null;
    try {
      const s = await mlReq(token, 'GET', '/shipments/' + encodeURIComponent(o.shipping.id));
      return { id: s.id || o.shipping.id, status: s.status || null, sub: s.substatus || null,
        tipo: (s.logistic && s.logistic.type) || s.logistic_type || null,
        prazo: (s.lead_time && s.lead_time.estimated_handling_limit && s.lead_time.estimated_handling_limit.date) || (s.shipping_option && s.shipping_option.estimated_handling_limit && s.shipping_option.estimated_handling_limit.date) || null };
    } catch { return { id: o.shipping.id, status: null }; }
  }));
  const abertas = ordens.map((o, i) => ({ o, envio: envios[i] })).filter(({ envio }) =>
    !(envio && envio.tipo === 'fulfillment') &&                                                   // Full: o ML envia
    !(envio && envio.status && !['pending', 'handling', 'ready_to_ship'].includes(envio.status)));   // já foi enviado/entregue
  // peças vinculadas e baixas já feitas: 2 consultas no total
  const mlIds = [...new Set(abertas.flatMap(({ o }) => (o.order_items || []).map(it => it.item && it.item.id).filter(Boolean).map(String)))];
  const ordIds = abertas.map(({ o }) => String(o.id));
  const porMl = {}, baixas = new Set();
  if (mlIds.length) (await env.DB.prepare(`SELECT id,codigo,nome,local_id,qtd,ml_id FROM pecas WHERE ml_id IN (${mlIds.map(() => '?').join(',')})`).bind(...mlIds).all()).results.forEach(r => { porMl[r.ml_id] = r; });
  if (ordIds.length) (await env.DB.prepare(`SELECT ml_pedido,peca_id FROM vendas WHERE cancelada=0 AND ml_pedido IN (${ordIds.map(() => '?').join(',')})`).bind(...ordIds).all()).results.forEach(r => baixas.add(r.ml_pedido + '|' + r.peca_id));
  const pedidos = abertas.map(({ o, envio }) => ({
    id: o.id, data: o.date_created || null, total: o.total_amount || 0, comprador: (o.buyer && o.buyer.nickname) || '', envio,
    itens: (o.order_items || []).map(it => {
      const mlId = it.item && it.item.id ? String(it.item.id) : null, pc = mlId ? porMl[mlId] || null : null;
      return { mlId, titulo: (it.item && it.item.title) || '', qtd: it.quantity || 1, unit: it.unit_price || 0, peca: pc, baixa: !!(pc && baixas.has(String(o.id) + '|' + pc.id)) };
    }),
  }));
  return json({ conectado: true, pedidos });
}
// ---------- DC-e (Declaração de Conteúdo eletrônica): vendedor sem nota fiscal libera a etiqueta ----------
// documentação do ML: POST /mlb/order/{id}/dce/emission · GET /mlb/order/{id}/dce/info · GET .../dce/info/{dce_id}?doctype=pdf|xml|json
function dceDocs(d) {   // acha os documentos na resposta, seja qual for o formato
  const out = [], vistos = new Set();
  const visita = (o, pai) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(x => visita(x, pai)); return; }
    const id = o.dce_id ?? o.document_id ?? (/(dce|document|fiscal)/i.test(pai || '') ? o.id : undefined) ?? (o.access_key || o.chave ? o.id : undefined);
    if (id != null && !vistos.has(String(id))) {
      vistos.add(String(id));
      out.push({ id: String(id), status: o.status || o.state || null, chave: o.access_key || o.key || o.chave || null, numero: o.number || o.numero || null });
    }
    for (const [k, v] of Object.entries(o)) if (v && typeof v === 'object') visita(v, k);
  };
  visita(d, 'dce');
  return out.slice(0, 10);
}
async function mlDce(orderId, m, env, user) {
  if (user.papel !== 'admin') return bad('somente o administrador', 403);
  const token = await mlToken(env);
  if (!token) return bad('conecte o Mercado Livre primeiro');
  const base = '/mlb/order/' + orderId + '/dce';
  if (m === 'POST') {
    let r;
    try { r = await mlReq(token, 'POST', base + '/emission'); }
    catch (e) {
      if (!/body|json|content|payload/i.test(e.message)) return bad('o Mercado Livre recusou a DC-e: ' + e.message);
      try { r = await mlReq(token, 'POST', base + '/emission', {}); } catch (e2) { return bad('o Mercado Livre recusou a DC-e: ' + e2.message); }
    }
    return json({ ok: true, resposta: r });
  }
  try {
    const d = await mlReq(token, 'GET', base + '/info');
    return json({ info: d, docs: dceDocs(d), status: (d && (d.status || d.state)) || null });
  } catch (e) { return bad('não consegui consultar a DC-e: ' + e.message, /404|not.?found/i.test(e.message) ? 404 : 400); }
}
async function mlDceDoc(orderId, dceId, url, env) {
  const token = await mlToken(env);
  if (!token) return bad('conecte o Mercado Livre primeiro');
  const fmt = url.searchParams.get('tipo') === 'xml' ? 'xml' : 'pdf';
  const r = await fetch(ML_API + '/mlb/order/' + orderId + '/dce/info/' + encodeURIComponent(dceId) + '?doctype=' + fmt, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) { const d = await r.json().catch(() => ({})); return bad('o Mercado Livre não liberou o documento: ' + (d.message || 'HTTP ' + r.status)); }
  return new Response(r.body, { headers: { 'content-type': fmt === 'pdf' ? 'application/pdf' : 'application/xml', 'content-disposition': `inline; filename="dce-${orderId}.${fmt}"`, 'cache-control': 'no-store' } });
}
async function mlEtiquetaEnvio(shipId, env) {
  const token = await mlToken(env);
  if (!token) return bad('conecte o Mercado Livre primeiro');
  const r = await fetch(ML_API + '/shipment_labels?shipment_ids=' + shipId + '&response_type=pdf', { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) { const d = await r.json().catch(() => ({})); return bad('o Mercado Livre não liberou a etiqueta: ' + (d.message || 'HTTP ' + r.status)); }
  return new Response(r.body, { headers: { 'content-type': 'application/pdf', 'content-disposition': 'inline; filename="etiqueta-envio-' + shipId + '.pdf"', 'cache-control': 'no-store' } });
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
// colunas novas dos locais (sigla curta e regras de localização automática), criadas sob demanda
let colsLocaisOk = false;
async function garanteColsLocais(env) {
  if (colsLocaisOk) return;
  for (const c of ['sigla TEXT', 'regras TEXT']) {
    try { await env.DB.prepare('ALTER TABLE locais ADD COLUMN ' + c).run(); } catch { /* já existe */ }
  }
  colsLocaisOk = true;
}
async function listaLocais(env) {
  await garanteColsLocais(env);
  // inclui a capacidade e a ocupação (nº de peças com estoque guardadas direto no local)
  const r = await env.DB.prepare(
    `SELECT l.id, l.nome, l.pai, l.capacidade, l.sigla, l.regras,
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
  await garanteColsLocais(env);
  const b = await request.json();
  const sets = [], binds = [];
  const txt = v => { v = String(v ?? '').trim(); return v ? v.slice(0, 500) : null; };
  if ('sigla' in b) { sets.push('sigla=?'); binds.push(txt(b.sigla) && txt(b.sigla).toUpperCase().slice(0, 12)); }
  if ('regras' in b) { sets.push('regras=?'); binds.push(txt(b.regras)); }
  if ('pai' in b) {
    // mover o local para dentro de outro (ou para a raiz), sem criar ciclo
    const novo = b.pai || null;
    if (novo === id) return bad('um local não pode ficar dentro dele mesmo');
    if (novo) {
      const ex = await env.DB.prepare('SELECT id FROM locais WHERE id=?').bind(novo).first();
      if (!ex) return bad('local de destino não existe');
      const sub = await env.DB.prepare('WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT l.id FROM locais l JOIN sub ON l.pai=sub.id) SELECT id FROM sub').bind(id).all();
      if (sub.results.some(r => r.id === novo)) return bad('não dá pra mover um local para dentro de um local que está dentro dele');
    }
    sets.push('pai=?'); binds.push(novo);
  }
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
// colunas novas (custo, qualidade, embalagem, vídeo, status do anúncio…), criadas sob demanda no banco existente
let colsPecasOk = false;
async function garanteColsPecas(env) {
  if (colsPecasOk) return;
  for (const c of ['custo REAL', 'qualidade TEXT', 'seguranca INTEGER DEFAULT 0', 'rastreavel INTEGER DEFAULT 0', 'peso_g INTEGER',
    'alt_cm REAL', 'larg_cm REAL', 'comp_cm REAL', 'video TEXT', 'etq_em INTEGER', 'ml_status TEXT', 'ml_em INTEGER', 'ml_cat TEXT', 'ml_cat_nome TEXT', 'ml_attrs TEXT']) {
    try { await env.DB.prepare('ALTER TABLE pecas ADD COLUMN ' + c).run(); } catch { /* já existe */ }
  }
  colsPecasOk = true;
}
const numOuNull = v => (v === '' || v == null || isNaN(Number(v))) ? null : Number(v);
function parsePeca(row) {
  if (row && typeof row.fotos === 'string') { try { row.fotos = JSON.parse(row.fotos); } catch { row.fotos = []; } }
  return row;
}
async function proxCodigo(env) {
  const r = await env.DB.prepare('SELECT MAX(codigo) m FROM pecas').first();
  return (r.m || 0) + 1;
}
async function listaPecas(url, env) {
  await garanteColsPecas(env);
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
  // filtros extras
  const sp = url.searchParams;
  if (sp.get('fotos') === 'com') cond.push("fotos IS NOT NULL AND fotos NOT IN ('','[]')");
  else if (sp.get('fotos') === 'sem') cond.push("(fotos IS NULL OR fotos IN ('','[]'))");
  if (sp.get('etq') === 'sim') cond.push('etq_em IS NOT NULL');
  else if (sp.get('etq') === 'nao') cond.push('etq_em IS NULL');
  const pmin = numOuNull(sp.get('pmin')), pmax = numOuNull(sp.get('pmax'));
  if (pmin != null) { cond.push('preco >= ?'); binds.push(pmin); }
  if (pmax != null) { cond.push('preco <= ?'); binds.push(pmax); }
  const qual = sp.get('qual');
  if (qual === 'sem') cond.push("(qualidade IS NULL OR qualidade='')");
  else if (qual) { cond.push('qualidade = ?'); binds.push(qual); }
  if (sp.get('seg') === '1') cond.push('seguranca = 1');
  if (sp.get('rast') === '1') cond.push('rastreavel = 1');
  const semVenda = parseInt(sp.get('semvenda')) || 0;  // anunciada no ML e sem venda há X dias
  if (semVenda > 0) {
    const lim = now() - semVenda * 864e5;
    cond.push('ml = 1 AND qtd > 0 AND COALESCE(ml_em, criado_em) < ? AND id NOT IN (SELECT peca_id FROM vendas WHERE data >= ? AND cancelada = 0 AND peca_id IS NOT NULL)');
    binds.push(lim, lim);
  }
  const ORD = { recentes: 'criado_em DESC', antigas: 'criado_em ASC', preco_desc: 'preco DESC', preco_asc: 'preco ASC', nome: 'nome COLLATE NOCASE ASC', codigo: 'codigo ASC' };
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const r = await env.DB.prepare(`SELECT * FROM pecas ${where} ORDER BY ${ORD[sp.get('ord')] || ORD.recentes} LIMIT ${sp.get('todas') ? 20000 : 500}`).bind(...binds).all();
  return json({ pecas: r.results.map(parsePeca) });
}
// marca quando a etiqueta da peça foi impressa (filtro "etiqueta não impressa")
async function marcaEtiquetas(request, env) {
  await garanteColsPecas(env);
  const { ids } = await request.json().catch(() => ({}));
  if (!Array.isArray(ids) || !ids.length) return bad('ids obrigatórios');
  const t = now();
  for (let i = 0; i < ids.length; i += 90) {
    const parte = ids.slice(i, i + 90).map(String);
    await env.DB.prepare(`UPDATE pecas SET etq_em=? WHERE id IN (${parte.map(() => '?').join(',')})`).bind(t, ...parte).run();
  }
  return json({ ok: true, n: ids.length, em: t });
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
const CAMPOS = ['nome', 'marca', 'modelo', 'ano', 'pn', 'cond', 'veiculo', 'preco', 'qtd', 'local_id', 'obs', 'ml', 'ml_id', 'ml_link', 'olx', 'olx_link',
  'custo', 'qualidade', 'seguranca', 'rastreavel', 'peso_g', 'alt_cm', 'larg_cm', 'comp_cm', 'video', 'ml_cat', 'ml_cat_nome'];
async function criaPeca(request, env, user) {
  await garanteColsPecas(env);
  const b = await request.json();
  if (!b.nome) return bad('nome é obrigatório');
  return getPeca(await inserePeca(env, b, user), env);
}
async function inserePeca(env, b, user, id = uid()) {
  const codigo = b.codigo ? parseInt(b.codigo) : await proxCodigo(env); // permite manter código do iBR na importação
  await env.DB.prepare(
    `INSERT INTO pecas (id,codigo,nome,marca,modelo,ano,pn,cond,veiculo,preco,qtd,local_id,obs,busca,fotos,ml,ml_link,olx,olx_link,criado_em,criado_por,
       custo,qualidade,seguranca,rastreavel,peso_g,alt_cm,larg_cm,comp_cm,video,ml_cat,ml_cat_nome)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, codigo, b.nome, b.marca || null, b.modelo || null, b.ano || null, b.pn || null, b.cond || null,
    b.veiculo || null, Number(b.preco) || 0, parseInt(b.qtd) || 0, b.local_id || null, b.obs || null,
    buscaDe({ ...b, codigo }), JSON.stringify(b.fotos || []), b.ml ? 1 : 0, b.ml_link || null, b.olx ? 1 : 0, b.olx_link || null, now(), (user && user.id) || null,
    numOuNull(b.custo), b.qualidade || null, b.seguranca ? 1 : 0, b.rastreavel ? 1 : 0, numOuNull(b.peso_g), numOuNull(b.alt_cm), numOuNull(b.larg_cm),
    numOuNull(b.comp_cm), b.video || null, b.ml_cat || null, b.ml_cat_nome || null).run();
  return id;
}
// ---------- perguntas dos compradores no Mercado Livre ----------
const erroPerg = e => /403|forbidden|scope|permission|not allowed|unauthorized/i.test(String(e.message))
  ? 'o Mercado Livre não liberou as perguntas para o seu app: no DevCenter do ML, ative a permissão "Comunicações pré e pós-venda" do aplicativo e conecte o ML de novo no sistema'
  : String(e.message);
async function mlPergContagem(env) {
  const token = await mlToken(env), seller = await getCfg(env, 'ml_user_id');
  if (!token || !seller) return json({ conectado: false, n: 0 });
  try { const d = await mlReq(token, 'GET', `/questions/search?seller_id=${seller}&status=UNANSWERED&api_version=4&limit=1`); return json({ conectado: true, n: d.total || 0 }); }
  catch (e) { return json({ conectado: true, n: 0, erro: erroPerg(e) }); }
}
async function caminhosLocais(env) {
  const r = await env.DB.prepare('SELECT id,nome,pai FROM locais').all(), m = {};
  for (const l of r.results) m[l.id] = l;
  return id => { const p = []; let c = m[id], g = 0; while (c && g++ < 20) { p.unshift(c.nome); c = m[c.pai]; } return p.join(' › '); };
}
async function mlPerguntas(url, env) {
  const token = await mlToken(env), seller = await getCfg(env, 'ml_user_id');
  if (!token || !seller) return bad('conecte o Mercado Livre primeiro');
  await garanteColsPecas(env);
  const sq = url.searchParams.get('status'), st = sq === 'respondidas' ? 'ANSWERED' : sq === 'todas' ? '' : 'UNANSWERED';
  const off = Math.max(0, parseInt(url.searchParams.get('offset')) || 0);
  let d;
  try { d = await mlReq(token, 'GET', `/questions/search?seller_id=${seller}&api_version=4&limit=30&offset=${off}&sort_fields=date_created&sort_types=DESC` + (st ? '&status=' + st : '')); }
  catch (e) { return bad(erroPerg(e)); }
  const qs = d.questions || [], ids = [...new Set(qs.map(q => q.item_id).filter(Boolean))], itens = {}, pecas = {};
  for (let i = 0; i < ids.length; i += 20) {
    try {
      const r = await mlReq(token, 'GET', '/items?ids=' + ids.slice(i, i + 20).join(',') + '&attributes=id,title,secure_thumbnail,thumbnail,permalink,price,available_quantity,status');
      for (const x of r) if (x && x.body && x.body.id) itens[x.body.id] = { id: x.body.id, titulo: x.body.title, foto: x.body.secure_thumbnail || x.body.thumbnail || null, link: x.body.permalink, preco: x.body.price, qtd: x.body.available_quantity, status: x.body.status };
    } catch { /* sem detalhes do anúncio */ }
  }
  if (ids.length) {
    const caminho = await caminhosLocais(env);
    const r = await env.DB.prepare(`SELECT id,codigo,qtd,local_id,pn,ml_id FROM pecas WHERE ml_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
    for (const p of r.results) pecas[p.ml_id] = { id: p.id, codigo: p.codigo, qtd: p.qtd, pn: p.pn, local: p.local_id ? caminho(p.local_id) : null };
  }
  const c = await veoCfg(env);
  return json({ total: d.total || qs.length, offset: off, ia: c.chaves.length > 0,
    perguntas: qs.map(q => ({ id: q.id, texto: q.text, data: q.date_created, status: q.status, item: itens[q.item_id] || { id: q.item_id }, peca: pecas[q.item_id] || null,
      resposta: q.answer ? { texto: q.answer.text, data: q.answer.date_created } : null })) });
}
async function mlResponde(id, request, env) {
  const token = await mlToken(env);
  if (!token) return bad('conecte o Mercado Livre primeiro');
  const t = String(((await request.json().catch(() => ({}))).texto) || '').trim();
  if (!t) return bad('escreva a resposta');
  if (t.length > 2000) return bad('a resposta passou de 2000 letras');
  try { await mlReq(token, 'POST', '/answers', { question_id: Number(id), text: t }); }
  catch (e) { return bad('o Mercado Livre recusou: ' + erroPerg(e)); }
  return json({ ok: true });
}
// texto com a IA do Gemini (usa as mesmas chaves das fotos e vídeos, com troca automática)
async function gmTexto(env, sistema, pedido) {
  const c = await veoCfg(env);
  if (!c.chaves.length) throw new Error('cadastre uma chave do Gemini em Anúncios ML → IA do Google');
  let ultimo = ''; const pulos = [];
  for (const k of gmOrdem(c.chaves)) {
    const modelos = [...new Set([k.txt, 'gemini-flash-latest', 'gemini-2.5-flash', 'gemini-3-flash-preview'].filter(Boolean))];
    let outraChave = false;
    for (const mo of modelos) {
      try {
        const d = await geminiReq(env, k.chave, 'POST', '/models/' + mo + ':generateContent', { systemInstruction: { parts: [{ text: sistema }] },
          contents: [{ role: 'user', parts: [{ text: pedido }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 600 } });
        const txt = (((d.candidates || [])[0] || {}).content || {}).parts;
        const t = (txt || []).map(x => x.text).filter(Boolean).join('').trim();
        if (!t) { ultimo = 'o Gemini não devolveu texto'; continue; }
        if (k.pausa) await gmLibera(env, k.id);
        return t;
      } catch (e) {
        ultimo = k.nome + ': ' + e.message;
        const esg = gmEsgotou(e);
        if (esg) { await gmPausa(env, k.id, esg); pulos.push(k.nome + ' (' + esg.motivo + ')'); outraChave = true; break; }
        if (e.status === 404 || /not found|not supported/i.test(e.message)) continue;
        break;
      }
    }
    if (!outraChave) break;
  }
  throw new Error(pulos.length >= c.chaves.length ? 'todas as chaves do Gemini estão sem saldo ou cota: ' + pulos.join(', ') : 'o Google recusou: ' + ultimo);
}
const SISTEMA_RESPOSTA = `Você é o atendente da loja Rafa Busca Peças (peças automotivas, a maioria usadas, de desmanche) no Mercado Livre. Escreva a resposta para a pergunta do comprador.
Regras:
- Português do Brasil, educado e direto, no máximo 3 frases curtas. Comece com "Olá!".
- Use SOMENTE as informações da peça e do anúncio abaixo. Nunca invente compatibilidade, ano, motor, medida, estado ou garantia.
- Se a resposta não estiver nos dados (ex.: se serve em outro carro), peça o que falta (ano, motor ou o código/part number da peça antiga para comparar) ou diga que vai conferir.
- Se perguntarem do estoque, use a quantidade informada. Sobre frete e prazo, diga que o Mercado Livre calcula no anúncio ao colocar o CEP.
- Nunca passe telefone, WhatsApp, e-mail, endereço, redes sociais ou links, e não ofereça venda ou desconto fora do Mercado Livre (é proibido lá).
- Não escreva assinatura no final.
Responda só com o texto da resposta.`;
async function mlSugereResposta(id, env) {
  const token = await mlToken(env);
  if (!token) return bad('conecte o Mercado Livre primeiro');
  await garanteColsPecas(env);
  let q; try { q = await mlReq(token, 'GET', '/questions/' + id + '?api_version=4'); } catch (e) { return bad(erroPerg(e)); }
  let it = {}; try { it = await mlReq(token, 'GET', '/items/' + q.item_id + '?attributes=id,title,price,available_quantity,condition,attributes,status'); } catch { /* sem anúncio */ }
  const p = q.item_id ? await env.DB.prepare('SELECT * FROM pecas WHERE ml_id=?').bind(q.item_id).first() : null;
  let ant = []; try { ant = ((await mlReq(token, 'GET', `/questions/search?item=${q.item_id}&status=ANSWERED&api_version=4&limit=5&sort_fields=date_created&sort_types=DESC`)).questions || []).filter(x => x.answer); } catch { /* sem histórico */ }
  const attrs = p && p.ml_attrs ? (() => { try { return JSON.parse(p.ml_attrs); } catch { return []; } })() : (it.attributes || []).filter(a => a.value_name).map(a => [a.id, a.name, a.value_name]);
  const L = [];
  L.push('ANÚNCIO: ' + (it.title || (p && p.nome) || q.item_id));
  if (it.price != null) L.push('Preço: R$ ' + it.price);
  L.push('Estoque: ' + (p ? p.qtd : (it.available_quantity ?? '?')) + ' unidade(s)');
  L.push('Condição: ' + (p && p.cond ? p.cond : it.condition === 'new' ? 'Nova' : it.condition === 'used' ? 'Usada' : '?'));
  if (p) {
    if (p.pn) L.push('Part number (código da peça): ' + p.pn);
    const v = [p.marca, p.modelo, p.ano].filter(Boolean).join(' '); if (v) L.push('Marca/modelo/ano: ' + v);
    if (p.veiculo) L.push('Retirada do veículo: ' + p.veiculo);
    if (p.obs) L.push('Descrição/observações: ' + String(p.obs).slice(0, 1500));
  }
  if (attrs.length) L.push('Ficha técnica: ' + attrs.slice(0, 40).map(a => a[1] + ': ' + a[2]).join('; '));
  if (ant.length) L.push('Respostas que a loja já deu nesse anúncio:\n' + ant.map(x => '- P: ' + x.text + '\n  R: ' + x.answer.text).join('\n'));
  L.push('\nPERGUNTA DO COMPRADOR: ' + q.text);
  try { return json({ ok: true, texto: (await gmTexto(env, SISTEMA_RESPOSTA, L.join('\n'))).slice(0, 2000) }); }
  catch (e) { return bad(e.message); }
}
// ---------- importar anúncios do Mercado Livre (os seus) para o sistema ----------
async function mlImportLista(url, env, user) {
  if (user.papel !== 'admin') return bad('somente o administrador', 403);
  const token = await mlToken(env);
  if (!token) return bad('conecte o Mercado Livre primeiro');
  const seller = await getCfg(env, 'ml_user_id');
  if (!seller) return bad('reconecte o Mercado Livre (falta o número da conta)');
  await garanteColsPecas(env);
  const st = url.searchParams.get('status'), offset = Math.max(0, parseInt(url.searchParams.get('offset')) || 0);
  const lim = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit')) || 50));
  const s = await mlReq(token, 'GET', `/users/${seller}/items/search?limit=${lim}&offset=${offset}` + (['active', 'paused', 'closed'].includes(st) ? '&status=' + st : ''));
  const ids = s.results || [], itens = [];
  for (let i = 0; i < ids.length; i += 20) {
    const r = await mlReq(token, 'GET', '/items?ids=' + ids.slice(i, i + 20).join(',') + '&attributes=id,title,price,available_quantity,sold_quantity,status,thumbnail,secure_thumbnail,permalink,pictures');
    for (const x of r) if (x && x.body && x.body.id) itens.push(x.body);
  }
  const ja = {};
  if (ids.length) {
    const r = await env.DB.prepare(`SELECT id,codigo,ml_id FROM pecas WHERE ml_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
    for (const p of r.results) ja[p.ml_id] = { id: p.id, codigo: p.codigo };
  }
  return json({ total: (s.paging && s.paging.total) || itens.length, offset, limite: lim,
    itens: itens.map(x => ({ id: x.id, titulo: x.title, preco: x.price, qtd: x.available_quantity, vendidos: x.sold_quantity, status: x.status,
      foto: x.secure_thumbnail || x.thumbnail || null, link: x.permalink, nfotos: (x.pictures || []).length, peca: ja[x.id] || null })) });
}
// valor de um atributo do ML: "10 cm" → 10 (em cm), "1,5 kg" → 1500 (em g)
function mlMedida(a, alvo) {
  if (!a) return null;
  let n = a.value_struct && a.value_struct.number, u = a.value_struct && a.value_struct.unit;
  if (n == null) { const m = String(a.value_name || '').replace(',', '.').match(/([\d.]+)\s*([a-zA-Z]*)/); if (!m) return null; n = Number(m[1]); u = m[2]; }
  u = String(u || '').toLowerCase(); if (!isFinite(n)) return null;
  if (alvo === 'g') return Math.round(u === 'kg' ? n * 1000 : u === 'mg' ? n / 1000 : n);
  return Math.round((u === 'mm' ? n / 10 : u === 'm' ? n * 100 : n) * 10) / 10;
}
async function mlImportaItem(mlId, request, env, user) {
  if (user.papel !== 'admin') return bad('somente o administrador', 403);
  const token = await mlToken(env);
  if (!token) return bad('conecte o Mercado Livre primeiro');
  await garanteColsPecas(env);
  const b = await request.json().catch(() => ({}));
  const ja = await env.DB.prepare('SELECT id,codigo FROM pecas WHERE ml_id=?').bind(mlId).first();
  if (ja) return json({ ok: true, ja: true, peca: ja });
  const it = await mlReq(token, 'GET', '/items/' + encodeURIComponent(mlId));
  const seller = await getCfg(env, 'ml_user_id');
  if (seller && it.seller_id && String(it.seller_id) !== String(seller)) return bad('esse anúncio não é da sua conta do Mercado Livre');
  let desc = ''; try { desc = String((await mlReq(token, 'GET', '/items/' + encodeURIComponent(mlId) + '/description')).plain_text || '').trim(); } catch { /* sem descrição */ }
  let catNome = null;
  if (it.category_id) { try { const c = await mlReq(token, 'GET', '/categories/' + it.category_id); catNome = (c.path_from_root || []).map(x => x.name).join(' › ') || c.name || null; } catch { /* sem nome */ } }
  const at = {}; for (const a of it.attributes || []) at[a.id] = a;
  const val = (...ks) => { for (const k of ks) { const v = at[k] && at[k].value_name; if (v && !/^n[ãa]o se aplica$/i.test(v)) return String(v).trim(); } return ''; };
  const id = uid();
  // fotos: baixa cada uma do ML (a maior que tiver) e guarda como foto original da peça
  const fotos = []; let falhas = 0;
  for (const pic of (it.pictures || []).slice(0, 12)) {
    const src = pic.secure_url || pic.url; if (!src) continue;
    try {
      const r = await fetch(src);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const ct = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
      const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg';
      const key = `pecas/${id}/${uid()}.${ext}`;
      await env.FOTOS.put(key, await r.arrayBuffer(), { httpMetadata: { contentType: ct } });
      fotos.push(key);
    } catch { falhas++; }
  }
  // ficha técnica completa do anúncio (nome e valor de cada característica)
  const attrs = (it.attributes || []).filter(a => a.value_name).map(a => [a.id, a.name || a.id, String(a.value_name).slice(0, 200)]);
  const cond = it.condition === 'new' ? 'Nova' : it.condition === 'used' ? 'Usada' : it.condition === 'refurbished' ? 'Recondicionada' : null;
  const dados = { nome: String(it.title || mlId).slice(0, 200), marca: val('BRAND') || null, modelo: val('MODEL') || null, ano: val('VEHICLE_YEAR', 'YEAR') || null,
    pn: val('PART_NUMBER', 'OEM', 'ORIGINAL_PART_NUMBER', 'MPN') || null, cond, preco: Number(it.price) || 0, qtd: parseInt(it.available_quantity) || 0,
    local_id: b.local_id || null, obs: desc ? desc.slice(0, 4000) : null, fotos, ml: it.status !== 'closed', ml_link: it.permalink || null,
    peso_g: mlMedida(at.SELLER_PACKAGE_WEIGHT, 'g'), alt_cm: mlMedida(at.SELLER_PACKAGE_HEIGHT), larg_cm: mlMedida(at.SELLER_PACKAGE_WIDTH), comp_cm: mlMedida(at.SELLER_PACKAGE_LENGTH),
    ml_cat: it.category_id || null, ml_cat_nome: catNome };
  await inserePeca(env, dados, user, id);
  await env.DB.prepare('UPDATE pecas SET ml_id=?, ml_status=?, ml_em=?, ml_attrs=? WHERE id=?').bind(mlId, it.status || null, now(), JSON.stringify(attrs), id).run();
  const p = await env.DB.prepare('SELECT id,codigo FROM pecas WHERE id=?').bind(id).first();
  return json({ ok: true, peca: p, fotos: fotos.length, falhas, caracteristicas: attrs.length });
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
  await garanteColsPecas(env);
  const atual = await env.DB.prepare('SELECT id FROM pecas WHERE id=?').bind(id).first();
  if (!atual) return bad('peça não encontrada', 404);
  const b = await request.json();
  const sets = [], binds = [];
  for (const c of CAMPOS) {
    if (c in b) {
      sets.push(`${c}=?`);
      if (c === 'preco') binds.push(Number(b[c]) || 0);
      else if (c === 'qtd') binds.push(parseInt(b[c]) || 0);
      else if (c === 'ml' || c === 'olx' || c === 'seguranca' || c === 'rastreavel') binds.push(b[c] ? 1 : 0);
      else if (['custo', 'peso_g', 'alt_cm', 'larg_cm', 'comp_cm'].includes(c)) binds.push(numOuNull(b[c]));
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
  const marca = new URL(request.url).searchParams.get('ia');
  const key = `pecas/${pecaId}/${marca === 'arte' ? 'arte-' : marca ? 'ia-' : ''}${uid()}.${ext}`;
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

// ---------- vídeo com IA gerado no PC do usuário ----------
let videosOk = false;
async function garanteVideos(env) {
  if (videosOk) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS videos (id TEXT PRIMARY KEY, peca_id TEXT NOT NULL, status TEXT NOT NULL, prompt TEXT,
    foto_key TEXT, video_key TEXT, erro TEXT, progresso TEXT, modelo TEXT, criado_em INTEGER NOT NULL, atualizado_em INTEGER, tipo TEXT DEFAULT 'video', detalhe TEXT)`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_videos_peca ON videos(peca_id)').run();
  for (const c of ["tipo TEXT DEFAULT 'video'", 'detalhe TEXT', 'motor TEXT', 'op TEXT', 'op_chave TEXT']) { try { await env.DB.prepare('ALTER TABLE videos ADD COLUMN ' + c).run(); } catch { /* já existe */ } }
  videosOk = true;
}
const hexAleatorio = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
async function agenteAutorizado(request, env) {
  const h = request.headers.get('authorization') || '', t = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  const ok = await getCfg(env, 'agente_token');
  if (!t || !ok || t.length !== ok.length) return false;
  let d = 0; for (let i = 0; i < t.length; i++) d |= t.charCodeAt(i) ^ ok.charCodeAt(i);
  return d === 0;
}
const NEG_VIDEO = 'product rotation, spinning, orbit, 360 view, morphing, deformation, melting, changing shape, new holes, missing holes, extra parts, missing parts, changed text, fake letters, fake numbers, new logo, watermark, cuts, scene change, transitions, hands, people, voice, blurry, low quality, distorted, cartoon, painting';
// comandos (prompts) da IA — os padrões são os textos do Rafael; editáveis em Anúncios ML → Comandos da IA
const CMD_PADRAO = { foto: "remova o fundo e deixe fundo branco sem sombras, preserve as caracteristicas da peça, com resolução exigidas para anúncios do mercado livre de 1.200 x 1.200 pixels. faça que essa foto fosse tirada com uma câmera Canon RF 24-70mm f/2.8L IS USM e a Canon RF 70-200mm f/2.8L IS USM, mantenha exatamente a fisionomia, características e detalhes do produto. mantenha exatamente as as escritas e numerações que as peças tem, não mude essas características. Se houver reflexo de luzes, remova. Mantenha tonalidade de cores. Mantenha a imagem real da original, cor da peça e características, arranhões, amassados e manchas, Realize um upscale de alta fidelidade e aumente a nitidez e a resolução geral. Corrija qualquer micro-desfoque, reduza ruídos de sensor discretos e OTIMIZE o contraste e o balanço de cores de forma realista, preservando rigorosamente as texturas originais da pele, tecidos e cenário, sem inventar elementos novos ou criar aspecto artificial/pintado. Mantenha a autenticidade técnica da imagem original.", arte: "Crie uma imagem mostrando aonde vai instalada exatamente essa peça do {peca} com resolução 1200x1200 px para anúncios do mercado livre, totalmente em português br, mantenha exatamente a fisionomia, características e detalhes do produto. mantenha exatamente as as escritas e numerações que as peças tem, não mude essas características. Não escreva e nem mencione se a peça é usada ou nova.", video: "Based on the attached product photo, create a 10-second vertical 9:16 cinematic commercial video.\n\nCRITICAL PRODUCT PRESERVATION INSTRUCTION:\n\nThe attached image is the absolute source of truth for the product.\n\nTreat the product as a locked, immutable visual asset. The AI must NOT redesign, reinterpret, regenerate, reconstruct, redraw, replace or modify the product.\n\nThe product shown in the reference image must remain visually identical to the original photograph from the first frame to the last frame.\n\nDo not change even the smallest physical characteristic of the product.\n\nPreserve exactly:\n\noverall silhouette\nouter contours\ndimensions\nproportions\nthickness\nedges\ncurves\nholes\nopenings\nslots\nmounting points\nscrews\nclips\nbrackets\nconnectors\nseams\ngrooves\ntextures\nscratches\nimperfections\nmaterial\ncolor\nreflections\nshadows on the product\nlabels\nlogos\nletters\nnumbers\nsymbols\nprinted markings\n\nThe product must never morph or change shape.\n\nNever add a hole.\nNever remove a hole.\nNever move a hole.\nNever change the size of a hole.\nNever change the thickness of any part.\nNever change the position of any component.\nNever create additional components.\nNever remove any component.\nNever invent details that are not visible in the reference image.\n\nTEXT AND MARKINGS\n\nAny text, logo, number, code, symbol or marking visible in the original image must remain exactly identical, in the exact same position, orientation, shape and appearance.\n\nDo not generate replacement text.\n\nDo not rewrite text.\n\nDo not create fake letters or numbers.\n\nDo not change or improve the typography.\n\nIf the original text is partially visible, keep it exactly as shown rather than attempting to reconstruct it.\n\nPRODUCT MOVEMENT\n\nTHE PRODUCT MUST NOT MOVE.\n\nDo not rotate the product.\n\nDo not spin the product.\n\nDo not bend the product.\n\nDo not deform the product.\n\nDo not animate the product.\n\nDo not make the product transform.\n\nDo not create a 360-degree view.\n\nDo not reveal hidden surfaces.\n\nDo not generate any new side of the product that is not visible in the reference image.\n\nThe product must remain in the same orientation and composition as the reference photograph.\n\nCAMERA\n\nUse an extremely subtle professional camera movement.\n\nThe safest camera movement is a very slow cinematic push-in, with only a minimal change in framing.\n\nThe camera movement must NOT require the AI to reconstruct hidden geometry.\n\nDo not orbit around the product.\n\nDo not move behind the product.\n\nDo not move around the sides of the product.\n\nDo not change the viewing angle significantly.\n\nThe product should remain essentially identical to the reference photograph while the camera makes a very subtle cinematic push-in.\n\nANIMATION\n\nAnimate only the environment, lighting and camera, never the physical geometry of the product.\n\nCreate subtle realistic changes in:\n\nstudio lighting\nsoft reflections\nbackground depth\nextremely subtle camera movement\n\nThe product itself remains frozen and unchanged.\n\nVISUAL QUALITY\n\nPremium automotive advertising aesthetic.\n\nRealistic professional studio environment.\n\nWarm, soft cinematic lighting.\n\nRealistic reflections.\n\nNatural shadows.\n\nSharp focus.\n\nUltra-HD 4K appearance.\n\nPhotorealistic materials.\n\nProfessional commercial product photography.\n\nPremium advertising-style color grading.\n\nClean and sophisticated background.\n\nVIDEO STRUCTURE\n\nUse one continuous shot only.\n\nNO scene changes.\n\nNO cuts.\n\nDo not use narration\n\nDo not use a human voice\n\nNO transitions.\n\nNO different camera angles.\n\nNO product rotation.\n\nNO change of product position.\n\nNO change of product appearance.\n\nThe entire 10-second video must be a single continuous shot of the same exact product.\n\nABSOLUTE PRIORITY\n\nIf there is any conflict between cinematic movement and product preservation, ALWAYS prioritize product preservation.\n\nIt is much more important for the product to remain 100% identical to the reference image than to create an elaborate camera movement.\n\nThe final result must look like a real camera filming the exact physical product shown in the reference photograph, not an AI recreating or redesigning the product.\n\nDO NOT GENERATE A NEW VERSION OF THE PRODUCT.\n\nDO NOT RECONSTRUCT THE PRODUCT.\n\nDO NOT MODIFY THE PRODUCT.\n\nKEEP THE PRODUCT IDENTICAL TO THE REFERENCE IMAGE FROM FRAME 1 TO FRAME 300." };
async function comandosIA(env) {
  const r = {};
  for (const k of ['foto', 'arte', 'video']) r[k] = (await getCfg(env, 'ia_cmd_' + k)) || CMD_PADRAO[k];
  r.padrao = CMD_PADRAO;
  return r;
}
async function salvaComandosIA(request, env, user) {
  if (user.papel !== 'admin') return bad('somente o administrador', 403);
  const b = await request.json().catch(() => ({}));
  for (const k of ['foto', 'arte', 'video']) if (typeof b[k] === 'string') await setCfg(env, 'ia_cmd_' + k, b[k].trim().slice(0, 8000) || CMD_PADRAO[k]);
  return json(await comandosIA(env));
}
const descPeca = p => [p.nome, [p.marca, p.modelo, p.ano].filter(Boolean).join(' '), p.pn].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
// a IA de vídeo só lê o começo de textos longos: o resumo das regras vai na frente do comando completo
const RESUMO_VIDEO = 'One continuous 10-second vertical 9:16 shot. Very slow cinematic push-in towards the exact product from the reference photo. The product stays perfectly still and identical: no rotation, no morphing, same holes, connectors, text and numbers. Only light and camera change. Warm soft studio lighting, clean premium background, photorealistic automotive advertising, sharp focus.';
async function promptVideo(p, env) {
  const tpl = (await getCfg(env, 'ia_cmd_video')) || CMD_PADRAO.video;
  return RESUMO_VIDEO + '\n\nProduct: ' + descPeca(p) + '\n\n' + tpl.split('{peca}').join(descPeca(p));
}
async function agenteResumo(env) {
  const visto = Number((await getCfg(env, 'agente_visto')) || 0);
  let info = {}; try { info = JSON.parse((await getCfg(env, 'agente_info')) || '{}'); } catch { /* sem info */ }
  return { configurado: !!(await getCfg(env, 'agente_token')), visto: visto || null, online: !!visto && now() - visto < 90e3, ...info };
}
async function agenteApi(p, m, request, env, url) {
  if (!(await agenteAutorizado(request, env))) return bad('chave do gerador inválida', 401);
  await garanteVideos(env);
  if (p === '/api/agente/proximo' && m === 'POST') {
    const info = await request.json().catch(() => ({}));
    await setCfg(env, 'agente_visto', String(now()));
    await setCfg(env, 'agente_info', JSON.stringify({ gpu: String(info.gpu || '').slice(0, 80), vram: Number(info.vram) || null, modelo: String(info.modelo || '').slice(0, 20), versao: String(info.versao || '').slice(0, 20), aviso: String(info.aviso || '').slice(0, 240) || null }));
    if (info.pausado) return json({ job: null });   // PC com problema (ex.: Windows bloqueando a IA): não entrega pedidos
    // pedido parado há mais de 3 h (PC desligou no meio) volta pra fila
    await env.DB.prepare("UPDATE videos SET status='fila' WHERE status='gerando' AND COALESCE(motor,'pc')='pc' AND atualizado_em < ?").bind(now() - 3 * 3600e3).run();
    const v = await env.DB.prepare("SELECT * FROM videos v WHERE status='fila' AND COALESCE(v.motor,'pc')='pc' AND NOT (COALESCE(v.tipo,'video')='video' AND EXISTS (SELECT 1 FROM videos f WHERE f.peca_id=v.peca_id AND f.tipo='foto' AND f.status IN ('fila','gerando'))) ORDER BY criado_em LIMIT 1").first();
    if (!v) return json({ job: null });
    if (v.tipo !== 'foto' && !/\/ia-/.test(v.foto_key || '')) {   // a foto foi melhorada no PC depois do pedido: o vídeo usa ela
      const pc = await env.DB.prepare('SELECT fotos FROM pecas WHERE id=?').bind(v.peca_id).first();
      let fs = []; try { fs = JSON.parse((pc && pc.fotos) || '[]'); } catch { /* sem fotos */ }
      const melhor = fs.find(k => /\/ia-pc-/.test(k));
      if (melhor) { v.foto_key = melhor; await env.DB.prepare('UPDATE videos SET foto_key=? WHERE id=?').bind(melhor, v.id).run(); }
    }
    await env.DB.prepare("UPDATE videos SET status='gerando', progresso='o PC começou a gerar', atualizado_em=? WHERE id=?").bind(now(), v.id).run();
    if (v.tipo === 'foto') { let opcoes = {}; try { opcoes = JSON.parse(v.prompt || '{}'); } catch { /* sem opções */ }
      return json({ job: { id: v.id, tipo: 'foto', foto_url: url.origin + '/api/foto/' + v.foto_key, opcoes } }); }
    return json({ job: { id: v.id, tipo: 'video', foto_url: url.origin + '/api/foto/' + v.foto_key, foto_ia: /\/ia-/.test(v.foto_key || ''), prompt: v.prompt, negativo: NEG_VIDEO, segundos: 10 } });
  }
  let mt = p.match(/^\/api\/agente\/progresso\/([\w-]+)$/);
  if (mt && m === 'POST') {
    const b = await request.json().catch(() => ({}));
    await setCfg(env, 'agente_visto', String(now()));
    await env.DB.prepare("UPDATE videos SET progresso=?, atualizado_em=? WHERE id=? AND status='gerando'").bind(String(b.texto || '').slice(0, 200) || null, now(), mt[1]).run();
    return json({ ok: true });
  }
  mt = p.match(/^\/api\/agente\/video\/([\w-]+)$/);
  if (mt && m === 'POST') {
    const v = await env.DB.prepare('SELECT id,peca_id,tipo,prompt,foto_key FROM videos WHERE id=?').bind(mt[1]).first();
    if (!v) return bad('pedido não encontrado', 404);
    if (v.tipo === 'foto') {   // foto melhorada no PC: vira a 1ª foto da peça (troca a versão IA anterior, se houver)
      if (!(request.headers.get('content-type') || '').startsWith('image/')) return bad('envie uma imagem');
      const orig = v.foto_key || '', daOriginal = !!orig && !/\/(ia|arte)-/.test(orig);
      const key = `pecas/${v.peca_id}/ia-pc-${uid().slice(0, 8)}` + (daOriginal ? '--' + orig.split('/').pop().replace(/[^\w.-]/g, '') : '.jpg');
      await env.FOTOS.put(key, request.body, { httpMetadata: { contentType: 'image/jpeg' } });
      const pc = await env.DB.prepare('SELECT fotos FROM pecas WHERE id=?').bind(v.peca_id).first();
      let fs = []; try { fs = JSON.parse((pc && pc.fotos) || '[]'); } catch { /* vazio */ }
      const primeiraOrig = fs.find(k => !/\/(ia|arte)-/.test(k));
      // a versão do PC substitui: as feitas no celular e a edição antiga (sem vínculo) da 1ª foto
      fs = fs.filter(k => !/\/ia-/.test(k) || origemDaEdicao(k) || (/\/ia-pc-/.test(k) && orig !== primeiraOrig));
      const iOrig = fs.indexOf(orig), iVelha = daOriginal ? fs.findIndex(k => origemDaEdicao(k) === orig) : -1;
      if (iOrig >= 0) fs[iOrig] = key; else if (iVelha >= 0) fs[iVelha] = key; else fs.unshift(key);
      fs = fs.filter((k, i) => fs.indexOf(k) === i);
      await env.DB.prepare('UPDATE pecas SET fotos=?, atualizado_em=? WHERE id=?').bind(JSON.stringify(fs.slice(0, 12)), now(), v.peca_id).run();
      let det = (url.searchParams.get('detalhe') || '').slice(0, 260);
      let op = {}; try { op = JSON.parse(v.prompt || '{}'); } catch { /* sem opções */ }
      const faltam = (await env.DB.prepare("SELECT COUNT(*) n FROM videos WHERE peca_id=? AND tipo='foto' AND status IN ('fila','gerando') AND id<>?").bind(v.peca_id, v.id).first()).n;
      if (op.ml && !faltam) {   // anúncio recebe as fotos novas de uma vez, quando a última ficar pronta
        const pm = await env.DB.prepare('SELECT ml_id FROM pecas WHERE id=?').bind(v.peca_id).first();
        if (pm && pm.ml_id) { const res = await mlTrocaFotos(env, pm.ml_id, fs.slice(0, 12), url.origin); det += res === 'ok' ? ' · anúncio do ML atualizado' : ' · ML: ' + res.slice(0, 60); }
      }
      await env.DB.prepare("UPDATE videos SET status='pronto', video_key=?, detalhe=?, erro=NULL, progresso=NULL, atualizado_em=? WHERE id=?")
        .bind(key, det || null, now(), v.id).run();
      await setCfg(env, 'agente_visto', String(now()));
      return json({ ok: true, key });
    }
    if (!(request.headers.get('content-type') || '').startsWith('video/')) return bad('envie um vídeo mp4');
    const key = `videos/${v.peca_id}/${uid()}.mp4`;
    await env.FOTOS.put(key, request.body, { httpMetadata: { contentType: 'video/mp4' } });
    await env.DB.prepare("UPDATE videos SET status='pronto', video_key=?, modelo=?, erro=NULL, progresso=NULL, atualizado_em=? WHERE id=?")
      .bind(key, (request.headers.get('x-modelo') || '').slice(0, 20) || null, now(), v.id).run();
    await setCfg(env, 'agente_visto', String(now()));
    return json({ ok: true, key });
  }
  mt = p.match(/^\/api\/agente\/erro\/([\w-]+)$/);
  if (mt && m === 'POST') {
    const b = await request.json().catch(() => ({}));
    await env.DB.prepare("UPDATE videos SET status='erro', erro=?, progresso=NULL, atualizado_em=? WHERE id=?").bind(String(b.erro || 'erro desconhecido').slice(0, 500), now(), mt[1]).run();
    return json({ ok: true });
  }
  return bad('rota do gerador não encontrada', 404);
}
async function novoVideo(env, b) {
  await garanteVideos(env);
  const row = await env.DB.prepare('SELECT * FROM pecas WHERE id=?').bind(b.peca_id || '').first();
  if (!row) return bad('peça não encontrada', 404);
  const pc = parsePeca(row), fotos = pc.fotos || [];
  const foto = b.foto_key && fotos.includes(b.foto_key) ? b.foto_key : (fotos.find(k => /\/ia-/.test(k)) || fotos.find(k => !/\/arte-/.test(k)) || fotos[0]);
  if (!foto) return bad('a peça precisa de pelo menos uma foto');
  if (!(await getCfg(env, 'agente_token'))) return bad('instale o gerador no PC primeiro (Anúncios ML → Gerador de vídeo)');
  const ja = await env.DB.prepare("SELECT id FROM videos WHERE peca_id=? AND status IN ('fila','gerando') AND COALESCE(tipo,'video')='video'").bind(pc.id).first();
  if (ja) return bad('já tem um vídeo dessa peça sendo gerado', 409);
  const id = uid();
  await env.DB.prepare('INSERT INTO videos (id,peca_id,status,prompt,foto_key,criado_em,atualizado_em) VALUES (?,?,?,?,?,?,?)')
    .bind(id, pc.id, 'fila', await promptVideo(pc, env), foto, now(), now()).run();
  return json({ ok: true, id });
}
// foto melhorada no PC (recorte BiRefNet + melhoria + luz, com trava de integridade)
async function criaFotoIA(request, env) {
  return novaFotoIA(env, await request.json().catch(() => ({})));
}
async function novaFotoIA(env, b) {
  await garanteVideos(env);
  const row = await env.DB.prepare('SELECT * FROM pecas WHERE id=?').bind(b.peca_id || '').first();
  if (!row) return bad('peça não encontrada', 404);
  const pc = parsePeca(row), fotos = pc.fotos || [];
  // sempre parte das fotos originais: uma edição por foto que você subiu (as que ainda não têm versão editada)
  const origs = fotos.filter(k => !/\/(ia|arte)-/.test(k));
  if (!fotos.some(k => !/\/arte-/.test(k))) return bad('a peça precisa de pelo menos uma foto');
  if (!(await getCfg(env, 'agente_token'))) return bad('instale o gerador no PC primeiro (Anúncios ML → Gerador de vídeo)');
  const editadas = new Set(fotos.map(origemDaEdicao).filter(Boolean));
  let alvo = b.foto_key && fotos.includes(b.foto_key) ? [b.foto_key] : origs.filter(k => !editadas.has(k));
  if (!alvo.length) alvo = origs.length ? origs : [fotos.find(k => !/\/arte-/.test(k))];   // tudo já editado: refaz todas
  const pend = (await env.DB.prepare("SELECT foto_key FROM videos WHERE peca_id=? AND tipo='foto' AND status IN ('fila','gerando')").bind(pc.id).all()).results.map(r => r.foto_key);
  alvo = alvo.filter(k => !pend.includes(k));
  if (!alvo.length) return json({ ok: true, ja: true, n: pend.length });
  const ids = [], t = now();
  for (let i = 0; i < alvo.length; i++) {
    const id = uid(); ids.push(id);
    await env.DB.prepare("INSERT INTO videos (id,peca_id,status,prompt,foto_key,criado_em,atualizado_em,tipo) VALUES (?,?,?,?,?,?,?,'foto')")
      .bind(id, pc.id, 'fila', JSON.stringify(b.opcoes || {}).slice(0, 2000), alvo[i], t + i, t + i).run();
  }
  return json({ ok: true, id: ids[0], ids, n: ids.length });
}
// foto editada (no PC ou pelo Gemini) guarda no nome de qual original veio: pecas/<peça>/ia-pc-<código>--<arquivo original> (ou ia-gm-)
function origemDaEdicao(k) {
  const m = String(k || '').match(/^(pecas\/[^/]+\/)ia-(?:pc|gm)-\w+--(.+)$/);
  return m ? m[1] + m[2] : null;
}
// tira as fotos editadas (ia-*) e deixa as originais; opcional: atualiza o anúncio do ML
// e manda o PC refazer a edição (a partir da original) e depois o vídeo (com a foto já editada)
async function fotosOriginais(pecaId, request, env, url) {
  const b = await request.json().catch(() => ({}));
  const row = await env.DB.prepare('SELECT id,fotos,ml_id FROM pecas WHERE id=?').bind(pecaId).first();
  if (!row) return bad('peça não encontrada', 404);
  let fs = []; try { fs = JSON.parse(row.fotos || '[]'); } catch { /* sem fotos */ }
  const ficam = []; let tiradas = 0;
  for (const k of fs) {
    if (!/\/ia-/.test(k)) { if (!ficam.includes(k)) ficam.push(k); continue; }
    tiradas++;
    const o = origemDaEdicao(k);   // editada no PC: a original volta no mesmo lugar
    if (o && !fs.includes(o) && !ficam.includes(o) && await env.FOTOS.head(o)) ficam.push(o);
  }
  if (!ficam.some(k => !/\/arte-/.test(k))) return bad('a foto original desta peça não ficou guardada no sistema — adicione a foto original de novo em Editar');
  if (tiradas) await env.DB.prepare('UPDATE pecas SET fotos=?, atualizado_em=? WHERE id=?').bind(JSON.stringify(ficam), now(), row.id).run();
  const r = { ok: true, tiradas, fotos: ficam };
  if (b.ml && row.ml_id) r.ml = await mlTrocaFotos(env, row.ml_id, ficam, url.origin);
  if (b.refazer) {
    if (!(await getCfg(env, 'agente_token'))) r.pc = 'o gerador não está instalado no PC';
    else {
      const jf = await (await novaFotoIA(env, { peca_id: row.id, opcoes: { ...(b.opcoes || {}), ml: !!(b.ml && row.ml_id) } })).json();
      r.foto = jf.erro ? 'erro: ' + jf.erro : (jf.n || 1) + (jf.n > 1 ? ' fotos na fila' : ' foto na fila');
      if ((await veoCfg(env)).chaves.length) r.video = 'peça o vídeo do Google quando as fotos ficarem prontas';
      else {
        const jv = await (await novoVideo(env, { peca_id: row.id })).json();
        r.video = jv.erro ? (/já tem/.test(jv.erro) ? 'já tinha um na fila' : 'erro: ' + jv.erro) : 'na fila';
      }
    }
  }
  return json(r);
}
// troca as fotos do anúncio no ML (não mexe em mais nada do anúncio)
async function mlTrocaFotos(env, mlId, keys, origem) {
  try {
    const token = await mlToken(env);
    if (!token) return 'erro: Mercado Livre não conectado';
    await mlReq(token, 'PUT', '/items/' + encodeURIComponent(mlId), { pictures: keys.slice(0, 12).map(k => ({ source: origem + '/api/foto/' + k })) });
    return 'ok';
  } catch (e) { return 'erro: ' + String(e.message || e).slice(0, 200); }
}
// ---------- IA do Google (Gemini): vídeo (Veo) e edição de fotos (Nano Banana) ----------
// chaves da API do Gemini (Google AI Studio, com cobrança ativa). Com várias chaves: usa a 1ª; se o Google
// disser que o saldo ou a cota dela acabou, pausa essa chave por um tempo e passa para a próxima.
const VEO_SEG = 8;
const VEO_NIVEIS = {   // US$ por segundo (720p, 1080p) — aproximado; confira na página de preços do Google
  lite: { nome: 'Lite', usd: [0.05, 0.08], padrao: ['veo-3.1-lite-generate-preview'] },
  fast: { nome: 'Fast', usd: [0.10, 0.12], padrao: ['veo-3.1-fast-generate-preview', 'veo-3.0-fast-generate-001'] },
  standard: { nome: 'Standard', usd: [0.40, 0.40], padrao: ['veo-3.1-generate-preview', 'veo-3.0-generate-001'] },
};
const IMG_NIVEIS = {   // US$ por foto (1K) — aproximado
  lite: { nome: 'Lite', usd: 0.034, padrao: ['gemini-3.1-flash-lite-image-preview', 'gemini-3.1-flash-lite-image'] },
  flash: { nome: 'Flash (Nano Banana 2)', usd: 0.067, padrao: ['gemini-3.1-flash-image-preview', 'gemini-3.1-flash-image', 'gemini-2.5-flash-image'] },
  pro: { nome: 'Pro (Nano Banana Pro)', usd: 0.134, padrao: ['gemini-3-pro-image-preview', 'gemini-3-pro-image'] },
};
const geminiBase = env => (env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
const usd2 = n => n.toFixed(2).replace('.', ',');
async function gmChaves(env) {
  let l = []; try { l = JSON.parse((await getCfg(env, 'gm_chaves')) || '[]'); } catch { /* vazio */ }
  if (!l.length) {   // chave única da versão anterior vira a 1ª da lista
    const v = await getCfg(env, 'veo_chave');
    if (v) {
      let mv = {}; try { mv = JSON.parse((await getCfg(env, 'veo_modelos')) || '{}'); } catch { /* sem lista */ }
      l = [{ id: hexAleatorio(4), nome: 'Chave 1', chave: v, veo: mv, img: {} }];
      await setCfg(env, 'gm_chaves', JSON.stringify(l)); await setCfg(env, 'veo_chave', '');
    }
  }
  return l;
}
const gmSalvaChaves = (env, l) => setCfg(env, 'gm_chaves', JSON.stringify(l));
// ordem de uso: as liberadas (na ordem da lista) e depois as pausadas (a que libera antes primeiro)
function gmOrdem(l) { const t = now(); return [...l.filter(k => !(k.pausa > t)), ...l.filter(k => k.pausa > t).sort((a, b) => a.pausa - b.pausa)]; }
// erro que é da chave (saldo, cota, chave inválida): pausa a chave e tenta a próxima
function gmEsgotou(e) {
  const t = String(e.message || '');
  if (e.status === 401 || /API key not valid|API_KEY_INVALID|key expired|API key expired/i.test(t)) return { ms: 24 * 3600e3, motivo: 'chave recusada' };
  if (/billing|prepay|credit|insufficient|payment|balance|FAILED_PRECONDITION/i.test(t)) return { ms: 6 * 3600e3, motivo: 'sem saldo ou cobrança' };
  if (e.status === 429 || /RESOURCE_EXHAUSTED|quota|rate limit|exceeded/i.test(t)) return { ms: 20 * 60e3, motivo: 'cota esgotada' };
  if (e.status === 403 || /PERMISSION_DENIED/i.test(t)) return { ms: 3600e3, motivo: 'sem permissão' };
  return null;
}
async function gmPausa(env, id, c) {
  const l = await gmChaves(env), k = l.find(x => x.id === id);
  if (k) { k.pausa = now() + c.ms; k.motivo = c.motivo; await gmSalvaChaves(env, l); }
}
async function gmLibera(env, id) {
  const l = await gmChaves(env), k = l.find(x => x.id === id);
  if (k && k.pausa) { k.pausa = 0; k.motivo = null; await gmSalvaChaves(env, l); }
}
async function veoCfg(env) {
  const nv = await getCfg(env, 'veo_nivel'), ni = await getCfg(env, 'img_nivel');
  return { chaves: await gmChaves(env), nivel: VEO_NIVEIS[nv] ? nv : 'fast', imgNivel: IMG_NIVEIS[ni] ? ni : 'flash',
    resolucao: (await getCfg(env, 'veo_res')) === '1080p' ? '1080p' : '720p' };
}
function veoResumo(c) {
  const n = VEO_NIVEIS[c.nivel], usd = Math.round(n.usd[c.resolucao === '1080p' ? 1 : 0] * VEO_SEG * 100) / 100, t = now(), k0 = c.chaves[0] || {};
  return { configurado: c.chaves.length > 0, nivel: c.nivel, nivelNome: n.nome, resolucao: c.resolucao, segundos: VEO_SEG, usd,
    modelo: (k0.veo || {})[c.nivel] || n.padrao[0],
    precos: Object.fromEntries(Object.entries(VEO_NIVEIS).map(([k, v]) => [k, v.usd.map(x => Math.round(x * VEO_SEG * 100) / 100)])),
    imgNivel: c.imgNivel, imgNome: IMG_NIVEIS[c.imgNivel].nome, imgUsd: IMG_NIVEIS[c.imgNivel].usd,
    imgModelo: (k0.img || {})[c.imgNivel] || IMG_NIVEIS[c.imgNivel].padrao[0],
    imgPrecos: Object.fromEntries(Object.entries(IMG_NIVEIS).map(([k, v]) => [k, v.usd])),
    chaves: c.chaves.map(k => ({ id: k.id, nome: k.nome, final: String(k.chave || '').slice(-4), pausada: k.pausa > t ? k.pausa : null, motivo: k.pausa > t ? k.motivo : null })) };
}
async function geminiReq(env, chave, metodo, caminho, corpo) {
  const r = await fetch(geminiBase(env) + caminho, { method: metodo, headers: { 'x-goog-api-key': chave, 'content-type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error((d.error && d.error.message) || ('HTTP ' + r.status)); e.status = r.status; throw e; }
  return d;
}
// modelos que a chave pode usar: o mais novo de cada nível (vídeo e foto)
async function gmDescobre(env, chave) {
  const nomes = []; let pg = '';
  for (let i = 0; i < 6; i++) {
    const d = await geminiReq(env, chave, 'GET', '/models?pageSize=200' + (pg ? '&pageToken=' + encodeURIComponent(pg) : ''));
    for (const m of d.models || []) nomes.push(String(m.name || '').replace(/^models\//, ''));
    pg = d.nextPageToken; if (!pg) break;
  }
  const ver = n => { const m = n.match(/(?:veo|gemini)-(\d+)(?:\.(\d+))?/); return m ? Number(m[1]) * 100 + Number(m[2] || 0) : 0; };
  const melhor = f => nomes.filter(f).sort((a, b) => ver(b) - ver(a) || (/preview/.test(a) - /preview/.test(b)))[0];
  const so = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v));
  const veo = n => /veo/i.test(n), img = n => /^gemini-.*image/i.test(n) && !/imagen/i.test(n);
  return { nomes: nomes.filter(n => veo(n) || img(n) || /^gemini-[\d.]+-flash/.test(n)),
    veo: so({ lite: melhor(n => veo(n) && /lite/.test(n)), fast: melhor(n => veo(n) && /fast/.test(n)), standard: melhor(n => veo(n) && !/fast|lite/.test(n)) }),
    img: so({ lite: melhor(n => img(n) && /lite/.test(n)), flash: melhor(n => img(n) && /flash/.test(n) && !/lite/.test(n)), pro: melhor(n => img(n) && /pro/.test(n)) }),
    txt: melhor(n => /^gemini-[\d.]+-flash(-preview)?(-[\d-]+)?$/i.test(n)) || null };
}
async function veoSalva(request, env, user) {
  if (user.papel !== 'admin') return bad('somente o administrador', 403);
  const b = await request.json().catch(() => ({}));
  let l = await gmChaves(env), aviso = null;
  if (b.nivel && VEO_NIVEIS[b.nivel]) await setCfg(env, 'veo_nivel', b.nivel);
  if (b.img_nivel && IMG_NIVEIS[b.img_nivel]) await setCfg(env, 'img_nivel', b.img_nivel);
  if (b.resolucao) await setCfg(env, 'veo_res', b.resolucao === '1080p' ? '1080p' : '720p');
  if (b.remover) { l = l.filter(k => k.id !== b.remover); await gmSalvaChaves(env, l); }
  if (b.subir) { const i = l.findIndex(k => k.id === b.subir); if (i > 0) { [l[i - 1], l[i]] = [l[i], l[i - 1]]; await gmSalvaChaves(env, l); } }
  const nova = String(b.chave || '').trim();
  if (nova) {
    if (l.some(k => k.chave === nova)) return bad('essa chave já está cadastrada');
    let d; try { d = await gmDescobre(env, nova); } catch (e) { return bad('o Google não aceitou a chave: ' + e.message); }
    if (!d.nomes.length) aviso = 'a chave foi aceita, mas o Google não listou modelos de vídeo nem de foto para ela — confira se a cobrança está ativa no Google AI Studio';
    l.push({ id: hexAleatorio(4), nome: String(b.nome || '').trim().slice(0, 40) || 'Chave ' + (l.length + 1), chave: nova, veo: d.veo, img: d.img, txt: d.txt });
    await gmSalvaChaves(env, l);
  }
  if (b.testar) {
    const k = l.find(x => x.id === b.testar);
    if (k) {
      let d; try { d = await gmDescobre(env, k.chave); } catch (e) { return bad(k.nome + ': o Google não aceitou a chave: ' + e.message); }
      Object.assign(k, { veo: d.veo, img: d.img, txt: d.txt, pausa: 0, motivo: null }); await gmSalvaChaves(env, l);
      if (!d.nomes.length) aviso = k.nome + ': o Google não listou modelos de vídeo nem de foto — confira a cobrança';
    }
  }
  return json({ ...veoResumo(await veoCfg(env)), aviso });
}
// o seu script (Comandos da IA → vídeo) ajustado para 8 s, que é o máximo do Veo num vídeo só
function ajustaVeo(t) {
  return String(t).replace(/\b10[- ]second/gi, VEO_SEG + '-second').replace(/\b10 ?s(egundos)?\b/gi, VEO_SEG + ' seconds')
    .replace(/FRAME 1 TO FRAME 300/gi, 'THE FIRST FRAME TO THE LAST FRAME').replace(/\b300 frames\b/gi, 'all frames');
}
async function promptVeo(p, env) {
  const tpl = (await getCfg(env, 'ia_cmd_video')) || CMD_PADRAO.video;
  return ajustaVeo(tpl.split('{peca}').join(descPeca(p))) + '\n\nProduct: ' + descPeca(p);
}
const b64bytes = s => Uint8Array.from(atob(s), ch => ch.charCodeAt(0));
function bytesB64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
async function veoNovo(env, b, user) {
  if (user.papel !== 'admin') return bad('somente o administrador pede vídeo do Google (é cobrado)', 403);
  const c = await veoCfg(env);
  if (!c.chaves.length) return bad('cadastre uma chave da API do Gemini em Anúncios ML → IA do Google');
  await garanteVideos(env);
  const row = await env.DB.prepare('SELECT * FROM pecas WHERE id=?').bind(b.peca_id || '').first();
  if (!row) return bad('peça não encontrada', 404);
  const ja = await env.DB.prepare("SELECT id FROM videos WHERE peca_id=? AND status IN ('fila','gerando') AND COALESCE(tipo,'video')='video'").bind(row.id).first();
  if (ja) return bad('já tem um vídeo dessa peça sendo gerado', 409);
  const m = String(b.imagem || '').match(/^(?:data:(image\/(?:jpeg|png|webp));base64,)?([A-Za-z0-9+/]+={0,2})$/);
  if (!m || m[2].length < 2000) return bad('a imagem da peça não chegou');
  if (m[2].length > 15e6) return bad('imagem grande demais');
  const id = uid(), key = `videos/${row.id}/veo-entrada-${id}.jpg`;
  await env.FOTOS.put(key, b64bytes(m[2]), { httpMetadata: { contentType: m[1] || 'image/jpeg' } });
  await env.DB.prepare("INSERT INTO videos (id,peca_id,status,prompt,foto_key,criado_em,atualizado_em,tipo,motor) VALUES (?,?,?,?,?,?,?,'video','veo')")
    .bind(id, row.id, 'gerando', await promptVeo(parsePeca(row), env), key, now(), now()).run();
  const r = await veoEnvia(env, id);
  return r.erro ? bad(r.erro) : json({ ok: true, id, modelo: r.modelo });
}
// manda pro Google; se ele recusar algum detalhe do pedido, ajusta e tenta de novo; se for a chave, passa pra próxima
async function veoEnvia(env, id) {
  const v = await env.DB.prepare('SELECT * FROM videos WHERE id=?').bind(id).first();
  const falha = async msg => { await env.DB.prepare("UPDATE videos SET status='erro', erro=?, progresso=NULL, atualizado_em=? WHERE id=?").bind(msg.slice(0, 480), now(), id).run(); return { erro: msg }; };
  if (!v) return { erro: 'pedido não encontrado' };
  const c = await veoCfg(env);
  if (!c.chaves.length) return falha('cadastre uma chave da API do Gemini');
  const obj = await env.FOTOS.get(v.foto_key);
  if (!obj) return falha('a imagem do pedido sumiu do armazenamento');
  const img = bytesB64(new Uint8Array(await obj.arrayBuffer())), mime = (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/jpeg';
  const pec = await env.DB.prepare('SELECT * FROM pecas WHERE id=?').bind(v.peca_id).first();
  const curto = ajustaVeo(RESUMO_VIDEO) + '\n\nProduct: ' + (pec ? descPeca(parsePeca(pec)) : '');
  let ultimo = ''; const pulos = [];
  for (const k of gmOrdem(c.chaves)) {
    const modelos = [...new Set([(k.veo || {})[c.nivel], ...VEO_NIVEIS[c.nivel].padrao, ...VEO_NIVEIS.fast.padrao].filter(Boolean))];
    const st = { mi: 0, prompt: v.prompt || curto, img: 'bytes', res: c.resolucao, dur: 'num', neg: true };
    let outraChave = false;
    for (let tent = 0; tent < 10; tent++) {
      if (st.mi >= modelos.length) { outraChave = true; break; }   // essa chave não tem nenhum modelo de vídeo
      const inst = { prompt: st.prompt, image: st.img === 'bytes' ? { bytesBase64Encoded: img, mimeType: mime } : { inlineData: { mimeType: mime, data: img } } };
      const par = { aspectRatio: '9:16' };
      if (st.dur) par.durationSeconds = st.dur === 'num' ? VEO_SEG : String(VEO_SEG);
      if (st.res) par.resolution = st.res;
      if (st.neg) par.negativePrompt = NEG_VIDEO;
      try {
        const d = await geminiReq(env, k.chave, 'POST', '/models/' + modelos[st.mi] + ':predictLongRunning', { instances: [inst], parameters: par });
        if (!d.name) throw new Error('o Google não devolveu o número do pedido');
        const det = `Google ${modelos[st.mi]} · ${VEO_SEG} s · ${st.res || 'padrão'} · ≈ US$ ${usd2(veoResumo({ ...c, resolucao: st.res || '720p' }).usd)} · ${k.nome}`;
        await env.DB.prepare("UPDATE videos SET op=?, op_chave=?, modelo=?, detalhe=?, progresso=?, atualizado_em=? WHERE id=?")
          .bind(d.name, k.id, modelos[st.mi], det, 'o Google está gerando o vídeo (leva de 1 a 4 min)', now(), id).run();
        if (k.pausa) await gmLibera(env, k.id);
        return { ok: true, modelo: modelos[st.mi] };
      } catch (e) {
        const t = String(e.message || ''); ultimo = k.nome + ': ' + t;
        const esg = gmEsgotou(e);
        if (esg) { await gmPausa(env, k.id, esg); pulos.push(k.nome + ' (' + esg.motivo + ')'); outraChave = true; break; }
        // ajustes do pedido (o Google diz qual campo não aceitou); só depois troca de modelo
        if (/resolution/i.test(t) && st.res) { st.res = st.res === '1080p' ? '720p' : null; continue; }
        if (/durationSeconds|duration/i.test(t) && st.dur) { st.dur = st.dur === 'num' ? 'str' : null; continue; }
        if (/negativePrompt|negative/i.test(t) && st.neg) { st.neg = false; continue; }
        if (/bytesBase64Encoded|inlineData|Unknown name "image"/i.test(t) && st.img === 'bytes') { st.img = 'inline'; continue; }
        if (/prompt/i.test(t) && /long|length|token|limit|exceed/i.test(t) && st.prompt !== curto) { st.prompt = curto; continue; }
        if (e.status === 404 || /not found|not supported for predictLongRunning|model.{0,40}(not (found|supported|available)|unavailable|does not exist)/i.test(t)) { st.mi++; continue; }
        break;
      }
    }
    if (!outraChave) break;   // o problema é o pedido, não a chave: outra chave daria o mesmo erro
  }
  let msg = pulos.length && pulos.length >= c.chaves.length ? 'todas as chaves do Gemini estão sem saldo ou cota: ' + pulos.join(', ')
    : 'o Google recusou o pedido: ' + (ultimo || 'nenhum modelo de vídeo disponível');
  if (/billing|quota|exhausted|429|permission|PERMISSION_DENIED|paid/i.test(ultimo)) msg += ' — confira a cobrança no Google AI Studio';
  return falha(msg);
}
// confere os pedidos no Google; quando fica pronto, baixa o vídeo pro armazenamento do sistema
async function veoAtualiza(env, pecaId) {
  await garanteVideos(env);
  const c = await veoCfg(env);
  if (!c.chaves.length) return;
  const r = await env.DB.prepare("SELECT * FROM videos WHERE motor='veo' AND status='gerando' AND op IS NOT NULL AND atualizado_em < ?" + (pecaId ? ' AND peca_id=?' : '') + ' ORDER BY criado_em LIMIT 4')
    .bind(...(pecaId ? [now() - 8000, pecaId] : [now() - 8000])).all();
  for (const v of r.results) {
    // "pega" o pedido (evita dois avisos baixarem o mesmo vídeo ao mesmo tempo)
    const pega = await env.DB.prepare("UPDATE videos SET atualizado_em=? WHERE id=? AND status='gerando' AND atualizado_em=?").bind(now(), v.id, v.atualizado_em).run();
    if (!pega.meta || pega.meta.changes !== 1) continue;
    const erro = msg => env.DB.prepare("UPDATE videos SET status='erro', erro=?, progresso=NULL, atualizado_em=? WHERE id=?").bind(msg.slice(0, 480), now(), v.id).run();
    const k = c.chaves.find(x => x.id === v.op_chave) || (!v.op_chave && c.chaves[0]);   // o pedido só pode ser conferido com a mesma chave
    if (!k) { await erro('a chave do Gemini usada nesse vídeo foi removida — toque em Tentar de novo'); continue; }
    try {
      const d = await geminiReq(env, k.chave, 'GET', '/' + String(v.op).replace(/^\/+/, ''));
      if (!d.done) {
        const min = Math.floor((now() - v.criado_em) / 60e3);
        if (min >= 25) { await erro('o Google não terminou o vídeo em 25 minutos — toque em Tentar de novo'); continue; }
        await env.DB.prepare('UPDATE videos SET progresso=? WHERE id=?').bind('o Google está gerando o vídeo' + (min ? ` (${min} min)` : ''), v.id).run();
        continue;
      }
      if (d.error) { await erro('o Google não conseguiu gerar: ' + (d.error.message || 'erro')); continue; }
      const resp = d.response || {}, gv = resp.generateVideoResponse || resp;
      const amostras = gv.generatedSamples || gv.generatedVideos || gv.videos || [];
      const vid = amostras[0] && (amostras[0].video || amostras[0]);
      if (!vid || (!vid.uri && !vid.bytesBase64Encoded)) {
        const motivo = (gv.raiMediaFilteredReasons || []).join(' ') || 'o Google não devolveu o vídeo';
        await erro('o Google bloqueou o vídeo: ' + motivo); continue;
      }
      let bytes;
      if (vid.bytesBase64Encoded) bytes = b64bytes(vid.bytesBase64Encoded);
      else {
        const rv = await fetch(vid.uri, { headers: { 'x-goog-api-key': k.chave } });
        if (!rv.ok) throw new Error('não consegui baixar o vídeo do Google (HTTP ' + rv.status + ')');
        bytes = new Uint8Array(await rv.arrayBuffer());
      }
      const key = `videos/${v.peca_id}/veo-${v.id}.mp4`;
      await env.FOTOS.put(key, bytes, { httpMetadata: { contentType: 'video/mp4' } });
      await env.DB.prepare("UPDATE videos SET status='pronto', video_key=?, erro=NULL, progresso=NULL, atualizado_em=? WHERE id=?").bind(key, now(), v.id).run();
    } catch (e) {
      if (now() - v.criado_em > 25 * 60e3) await erro(String(e.message || e));   // erro passageiro: tenta de novo no próximo aviso
    }
  }
}
// ---------- foto editada pelo Gemini (Nano Banana) com o seu comando de foto ----------
const PRESERVA_GM = 'IMPORTANT: edit THIS exact photo. Keep the product 100% identical to the photo: same shape, proportions, holes, connectors, clips, labels, printed text and numbers (do not rewrite or invent letters). Do not add, remove or redraw parts. Return one square photo of the product only.';
async function gmFoto(request, env, user, url) {
  if (user.papel !== 'admin') return bad('somente o administrador edita foto com o Gemini (é cobrado)', 403);
  const b = await request.json().catch(() => ({}));
  const c = await veoCfg(env);
  if (!c.chaves.length) return bad('cadastre uma chave da API do Gemini em Anúncios ML → IA do Google');
  const row = await env.DB.prepare('SELECT id,fotos,ml_id FROM pecas WHERE id=?').bind(b.peca_id || '').first();
  if (!row) return bad('peça não encontrada', 404);
  let fs = []; try { fs = JSON.parse(row.fotos || '[]'); } catch { /* sem fotos */ }
  const orig = String(b.foto_key || '');
  if (/\/(ia|arte)-/.test(orig) || !(fs.includes(orig) || fs.some(k => origemDaEdicao(k) === orig))) return bad('escolha uma foto original da peça');
  const obj = await env.FOTOS.get(orig);
  if (!obj) return bad('a foto original sumiu do armazenamento');
  const img = bytesB64(new Uint8Array(await obj.arrayBuffer())), mime = (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/jpeg';
  const prompt = ((await getCfg(env, 'ia_cmd_foto')) || CMD_PADRAO.foto) + '\n\n' + PRESERVA_GM;
  let ultimo = '', saida = null, usada = null, modeloUsado = null; const pulos = [];
  for (const k of gmOrdem(c.chaves)) {
    const modelos = [...new Set([(k.img || {})[c.imgNivel], ...IMG_NIVEIS[c.imgNivel].padrao, ...IMG_NIVEIS.flash.padrao].filter(Boolean))];
    const st = { mi: 0, cfg: true, mod: ['IMAGE'] };
    let outraChave = false;
    for (let tent = 0; tent < 10; tent++) {
      if (st.mi >= modelos.length) { outraChave = true; break; }
      const gc = { responseModalities: st.mod };
      if (st.cfg) gc.imageConfig = { aspectRatio: '1:1' };
      try {
        const d = await geminiReq(env, k.chave, 'POST', '/models/' + modelos[st.mi] + ':generateContent',
          { contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: img } }] }], generationConfig: gc });
        const cand = (d.candidates || [])[0] || {}, partes = (cand.content && cand.content.parts) || [];
        const p = partes.find(x => (x.inlineData || x.inline_data) && /^image\//.test((x.inlineData || x.inline_data).mimeType || (x.inlineData || x.inline_data).mime_type || ''));
        if (!p) {
          const txt = partes.map(x => x.text).filter(Boolean).join(' ').slice(0, 160);
          ultimo = 'o Gemini não devolveu a foto' + (cand.finishReason ? ' (' + cand.finishReason + ')' : '') + (txt ? ': ' + txt : '');
          break;
        }
        saida = p.inlineData || p.inline_data; usada = k; modeloUsado = modelos[st.mi];
        break;
      } catch (e) {
        const t = String(e.message || ''); ultimo = k.nome + ': ' + t;
        const esg = gmEsgotou(e);
        if (esg) { await gmPausa(env, k.id, esg); pulos.push(k.nome + ' (' + esg.motivo + ')'); outraChave = true; break; }
        if (/imageConfig|aspectRatio|aspect_ratio/i.test(t) && st.cfg) { st.cfg = false; continue; }
        if (/responseModalities|response_modalities|modalit/i.test(t) && st.mod.length === 1) { st.mod = ['TEXT', 'IMAGE']; continue; }
        if (e.status === 404 || /not found|not supported for generateContent|model.{0,40}(not (found|supported|available)|unavailable|does not exist)/i.test(t)) { st.mi++; continue; }
        break;
      }
    }
    if (saida || !outraChave) break;
  }
  if (!saida) return bad(pulos.length && pulos.length >= c.chaves.length ? 'todas as chaves do Gemini estão sem saldo ou cota: ' + pulos.join(', ') : (ultimo.startsWith('o Gemini') ? ultimo : 'o Google recusou: ' + ultimo));
  if (usada.pausa) await gmLibera(env, usada.id);
  const tipo = saida.mimeType || saida.mime_type || 'image/png';
  const key = `pecas/${row.id}/ia-gm-${uid().slice(0, 8)}--` + orig.split('/').pop().replace(/[^\w.-]/g, '');
  await env.FOTOS.put(key, b64bytes(saida.data), { httpMetadata: { contentType: tipo } });
  // entra no lugar da original (ou da edição anterior dela), relendo a lista (outra foto pode ter mudado no meio)
  const atual = await env.DB.prepare('SELECT fotos FROM pecas WHERE id=?').bind(row.id).first();
  try { fs = JSON.parse((atual && atual.fotos) || '[]'); } catch { /* mantém */ }
  const primeiraOrig = fs.find(k => !/\/(ia|arte)-/.test(k));
  fs = fs.filter(k => !/\/ia-/.test(k) || origemDaEdicao(k) || (/\/ia-pc-/.test(k) && orig !== primeiraOrig));
  const iOrig = fs.indexOf(orig), iVelha = fs.findIndex(k => origemDaEdicao(k) === orig);
  if (iOrig >= 0) fs[iOrig] = key; else if (iVelha >= 0) fs[iVelha] = key; else fs.unshift(key);
  fs = fs.filter((k, i) => fs.indexOf(k) === i).slice(0, 12);
  await env.DB.prepare('UPDATE pecas SET fotos=?, atualizado_em=? WHERE id=?').bind(JSON.stringify(fs), now(), row.id).run();
  const r = { ok: true, key, fotos: fs, modelo: modeloUsado, chave: usada.nome, usd: IMG_NIVEIS[c.imgNivel].usd };
  if (b.ml && b.ultima && row.ml_id) r.ml = await mlTrocaFotos(env, row.ml_id, fs, url.origin);
  return json(r);
}
async function listaVideos(url, env) {
  await garanteVideos(env);
  await veoAtualiza(env, url.searchParams.get('peca') || '').catch(() => {});
  const r = await env.DB.prepare("SELECT id,status,video_key,erro,progresso,modelo,criado_em,atualizado_em,COALESCE(tipo,'video') tipo,detalhe,motor FROM videos WHERE peca_id=? ORDER BY criado_em DESC LIMIT 40").bind(url.searchParams.get('peca') || '').all();
  const fila = (await env.DB.prepare("SELECT COUNT(*) n FROM videos WHERE status='fila'").first()).n;
  return json({ videos: r.results, fila, agente: await agenteResumo(env), veo: veoResumo(await veoCfg(env)) });
}
async function repeteVideo(id, env) {
  await garanteVideos(env);
  const rv = await env.DB.prepare('SELECT motor FROM videos WHERE id=?').bind(id).first();
  if (rv && rv.motor === 'veo') {
    await env.DB.prepare("UPDATE videos SET status='gerando', erro=NULL, op=NULL, progresso=NULL, atualizado_em=? WHERE id=? AND status IN ('erro','gerando')").bind(now(), id).run();
    const r = await veoEnvia(env, id);
    return r.erro ? bad(r.erro) : json({ ok: true });
  }
  await env.DB.prepare("UPDATE videos SET status='fila', erro=NULL, progresso=NULL, atualizado_em=? WHERE id=? AND status IN ('erro','gerando')").bind(now(), id).run();
  return json({ ok: true });
}
async function agenteNovaChave(env, user) {
  if (user.papel !== 'admin') return bad('somente o administrador', 403);
  await setCfg(env, 'agente_token', hexAleatorio(24));
  return json({ ok: true });
}
async function agenteInstalador(env, url, user) {
  if (user.papel !== 'admin') return bad('somente o administrador', 403);
  let t = await getCfg(env, 'agente_token');
  if (!t) { t = hexAleatorio(24); await setCfg(env, 'agente_token', t); }
  const bat = INSTALADOR_BAT.split('__SERVIDOR__').join(url.origin).split('__TOKEN__').join(t).replace(/\r?\n/g, '\r\n');
  return new Response(bat, { headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="instalar-gerador-video.bat"', 'cache-control': 'no-store' } });
}
async function serveVideo(key, request, env) {
  const rh = request.headers.get('range');
  if (rh) {
    const head = await env.FOTOS.head(key);
    if (!head) return bad('vídeo não encontrado', 404);
    const size = head.size, mm = rh.match(/bytes=(\d*)-(\d*)/);
    let ini = mm && mm[1] ? parseInt(mm[1]) : 0, fim = mm && mm[2] ? parseInt(mm[2]) : size - 1;
    if (mm && !mm[1] && mm[2]) { ini = Math.max(0, size - parseInt(mm[2])); fim = size - 1; }
    fim = Math.min(fim, size - 1);
    if (ini > fim) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
    const obj = await env.FOTOS.get(key, { range: { offset: ini, length: fim - ini + 1 } });
    return new Response(obj.body, { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': `bytes ${ini}-${fim}/${size}`, 'content-length': String(fim - ini + 1), 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=31536000' } });
  }
  const obj = await env.FOTOS.get(key);
  if (!obj) return bad('vídeo não encontrado', 404);
  return new Response(obj.body, { headers: { 'content-type': 'video/mp4', 'content-length': String(obj.size), 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=31536000' } });
}
// instalador para Windows (o sistema troca __SERVIDOR__ e __TOKEN__ na hora do download)
const INSTALADOR_BAT = String.raw`@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Instalando o gerador de video - Rafa Busca Pecas
set "SERVIDOR=__SERVIDOR__"
set "TOKEN=__TOKEN__"
set "PASTA=%USERPROFILE%\RafaGerador"
echo.
echo  === IA de fotos e videos - Rafa Busca Pecas ===
echo  Pasta: %PASTA%
echo.
set "PLACA=outra"
powershell -NoProfile -Command "(Get-CimInstance Win32_VideoController).Name" > "%TEMP%\rafa_placa.txt" 2>nul
findstr /I "AMD Radeon" "%TEMP%\rafa_placa.txt" >nul && set "PLACA=amd"
findstr /I "Intel" "%TEMP%\rafa_placa.txt" >nul && if "%PLACA%"=="outra" set "PLACA=intel"
nvidia-smi >nul 2>&1 && set "PLACA=nvidia"
echo  Placa de video encontrada:
type "%TEMP%\rafa_placa.txt"
if "%PLACA%"=="nvidia" (
  echo  Modo: NVIDIA - fotos com IA e video com IA
) else (
  echo  Modo: leve - fotos com IA pelo DirectX/Vulkan e video cinematografico com a foto real
)
echo.
set "CU=cu124"
if "%PLACA%"=="nvidia" nvidia-smi --query-gpu=name --format=csv,noheader | findstr /R /C:"RTX 50[0-9][0-9]" >nul && set "CU=cu128"
set PY=
py -3.11 --version >nul 2>&1 && set PY=py -3.11
if not defined PY python --version 2>nul | findstr /R /C:"3\.1[0-2]\." >nul && set PY=python
if not defined PY (
  echo  Instalando o Python 3.11 ...
  winget install -e --id Python.Python.3.11 --scope user --accept-source-agreements --accept-package-agreements
)
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" set PY="%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
if not defined PY (
  echo  [ERRO] Nao consegui instalar o Python. Instale o Python 3.11 em https://www.python.org/downloads/
  echo         marcando "Add python.exe to PATH", e rode este instalador de novo.
  pause
  exit /b 1
)
if not exist "%PASTA%" mkdir "%PASTA%"
cd /d "%PASTA%"
echo  Baixando o programa...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; Invoke-WebRequest -UseBasicParsing '%SERVIDOR%/agente/agente.py' -OutFile 'agente.py'; Invoke-WebRequest -UseBasicParsing '%SERVIDOR%/agente/requirements.txt' -OutFile 'requirements.txt'; Invoke-WebRequest -UseBasicParsing '%SERVIDOR%/agente/requirements-leve.txt' -OutFile 'requirements-leve.txt'"
if errorlevel 1 (
  echo  [ERRO] Nao consegui baixar o programa. Confira a internet e tente de novo.
  pause
  exit /b 1
)
> config.json echo {"servidor": "%SERVIDOR%", "token": "%TOKEN%", "modelo": "auto", "passos": 30}
if not exist "venv\Scripts\python.exe" %PY% -m venv venv
if not exist "venv\Scripts\python.exe" (
  echo  [ERRO] Nao consegui criar o ambiente do Python.
  pause
  exit /b 1
)
echo  Instalando a IA (na primeira vez pode levar de 10 a 30 minutos)...
"venv\Scripts\python.exe" -m pip install --upgrade pip
if "%PLACA%"=="nvidia" (
  "venv\Scripts\python.exe" -m pip install torch torchvision --index-url https://download.pytorch.org/whl/%CU%
  "venv\Scripts\python.exe" -m pip install -r requirements.txt
) else (
  "venv\Scripts\python.exe" -m pip install -r requirements-leve.txt
)
if errorlevel 1 (
  echo  [ERRO] Falhou ao instalar as bibliotecas. Tire um print desta tela e mande pro suporte.
  pause
  exit /b 1
)
> iniciar.bat echo @echo off
>> iniciar.bat echo chcp 65001 ^>nul
>> iniciar.bat echo title Gerador de video - Rafa Busca Pecas
>> iniciar.bat echo cd /d "%PASTA%"
>> iniciar.bat echo "venv\Scripts\python.exe" agente.py
>> iniciar.bat echo pause
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Gerador de video Rafa.lnk'); $s.TargetPath='%PASTA%\iniciar.bat'; $s.WorkingDirectory='%PASTA%'; $s.Save()"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\Gerador de video Rafa.lnk'); $s.TargetPath='%PASTA%\iniciar.bat'; $s.WorkingDirectory='%PASTA%'; $s.WindowStyle=7; $s.Save()"
echo.
echo  Instalado! Criei o atalho "Gerador de video Rafa" na Area de Trabalho.
echo  Ele tambem abre sozinho (minimizado) toda vez que o Windows ligar.
echo  Deixe a janela do gerador aberta enquanto quiser gerar videos.
echo.
call iniciar.bat
`;

// ---------- vendas ----------
let colsVendasOk = false;
async function garanteColsVendas(env) {
  if (colsVendasOk) return;
  try { await env.DB.prepare('ALTER TABLE vendas ADD COLUMN ml_pedido TEXT').run(); } catch { /* já existe */ }
  colsVendasOk = true;
}
async function listaVendas(url, env) {
  const periodo = url.searchParams.get('periodo') || 'mes';
  let ini = 0, fim = now() + 864e5;
  if (periodo === 'hoje') ini = inicioDiaBR();
  else if (periodo === '7d') ini = now() - 7 * 864e5;
  else if (periodo === '30d') ini = now() - 30 * 864e5;
  else if (periodo === 'mes') ini = inicioMesBR(0);
  else if (periodo === 'mesant') { ini = inicioMesBR(-1); fim = inicioMesBR(0); }
  const r = await env.DB.prepare('SELECT * FROM vendas WHERE data>=? AND data<? ORDER BY data DESC LIMIT 5000').bind(ini, fim).all();
  return json({ vendas: r.results });
}
async function criaVenda(request, env) {
  await garanteColsVendas(env);
  const b = await request.json();
  if (b.ml_pedido) {
    const ja = await env.DB.prepare('SELECT id FROM vendas WHERE ml_pedido=? AND peca_id=? AND cancelada=0').bind(String(b.ml_pedido), b.peca_id).first();
    if (ja) return bad('a baixa deste pedido já foi feita', 409);
  }
  const peca = await env.DB.prepare('SELECT * FROM pecas WHERE id=?').bind(b.peca_id).first();
  if (!peca) return bad('peça não encontrada', 404);
  const qtd = Math.max(1, parseInt(b.qtd) || 1);
  if (qtd > peca.qtd) return bad('quantidade maior que o estoque', 409);
  const unit = Number(b.unit) || peca.preco || 0;
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO vendas (id,peca_id,nome,codigo,qtd,unit,total,canal,cliente,pagamento,local_path,data,ml_pedido)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, peca.id, peca.nome, peca.codigo, qtd, unit, qtd * unit, b.canal || 'Balcão',
    b.cliente || null, b.pagamento || null, b.local_path || null, now(), b.ml_pedido ? String(b.ml_pedido) : null).run();
  await env.DB.prepare('UPDATE pecas SET qtd=qtd-?, atualizado_em=? WHERE id=?').bind(qtd, now(), peca.id).run();
  const ml = await mlAposEstoque(env, peca.id);
  return json({ ok: true, id, ml });
}
async function cancelaVenda(id, env) {
  const v = await env.DB.prepare('SELECT * FROM vendas WHERE id=?').bind(id).first();
  if (!v) return bad('venda não encontrada', 404);
  if (v.cancelada) return json({ ok: true });
  await env.DB.prepare('UPDATE vendas SET cancelada=1 WHERE id=?').bind(id).run();
  await env.DB.prepare('UPDATE pecas SET qtd=qtd+?, atualizado_em=? WHERE id=?').bind(v.qtd, now(), v.peca_id).run();
  const ml = await mlAposEstoque(env, v.peca_id);
  return json({ ok: true, ml });
}

// ---------- painel ----------
async function painel(env) {
  await garanteColsPecas(env);
  const inicioMes = inicioMesBR(0), iniAnt = inicioMesBR(-1), decorrido = now() - inicioMes;
  const soma = (a, b2) => env.DB.prepare('SELECT COUNT(*) n, COALESCE(SUM(total),0) total FROM vendas WHERE cancelada=0 AND data>=? AND data<?').bind(a, b2).first();
  const hoje = await soma(inicioDiaBR(), now() + 864e5);
  const antTotal = await soma(iniAnt, inicioMes);
  const antParcial = await soma(iniAnt, Math.min(iniAnt + decorrido, inicioMes));
  const pagamentos = await env.DB.prepare("SELECT COALESCE(NULLIF(pagamento,''),'Não informado') pagamento, COUNT(*) n, SUM(total) total FROM vendas WHERE cancelada=0 AND data>=? GROUP BY 1 ORDER BY total DESC").bind(inicioMes).all();
  const top = await env.DB.prepare('SELECT nome, codigo, SUM(qtd) qtd, SUM(total) total FROM vendas WHERE cancelada=0 AND data>=? GROUP BY codigo, nome ORDER BY total DESC LIMIT 5').bind(inicioMes).all();
  const mlSt = await env.DB.prepare("SELECT COALESCE(ml_status,'active') st, COUNT(*) c FROM pecas WHERE ml=1 GROUP BY 1").all();
  const semEtq = await env.DB.prepare('SELECT COUNT(*) c FROM pecas WHERE qtd>0 AND etq_em IS NULL').first();
  const semFoto = await env.DB.prepare("SELECT COUNT(*) c FROM pecas WHERE qtd>0 AND (fotos IS NULL OR fotos IN ('','[]'))").first();
  const est = await env.DB.prepare('SELECT COUNT(*) cadastros, COALESCE(SUM(qtd),0) pecas, COALESCE(SUM(qtd*preco),0) valor FROM pecas').first();
  const vend = await env.DB.prepare('SELECT COUNT(*) n, COALESCE(SUM(total),0) total FROM vendas WHERE cancelada=0 AND data>=?').bind(inicioMes).first();
  const semAnuncio = await env.DB.prepare('SELECT COUNT(*) c FROM pecas WHERE qtd>0 AND ml=0 AND olx=0').first();
  const semLocal = await env.DB.prepare('SELECT COUNT(*) c FROM pecas WHERE local_id IS NULL OR local_id NOT IN (SELECT id FROM locais)').first();
  const parado = await env.DB.prepare('SELECT COUNT(*) c FROM pecas WHERE qtd>0 AND criado_em < ?').bind(now() - 90 * 864e5).first();
  const canais = await env.DB.prepare('SELECT canal, SUM(total) total FROM vendas WHERE cancelada=0 AND data>=? GROUP BY canal').bind(inicioMes).all();
  const ultimas = await env.DB.prepare('SELECT id,nome,codigo,total,canal,data,cancelada FROM vendas ORDER BY data DESC LIMIT 8').all();
  return json({
    estoque: { cadastros: est.cadastros, pecas: est.pecas, valor: est.valor },
    vendasMes: { n: vend.n, total: vend.total, ticket: vend.n ? vend.total / vend.n : 0 },
    vendasHoje: { n: hoje.n, total: hoje.total },
    mesAnterior: { n: antTotal.n, total: antTotal.total, mesmoPeriodo: antParcial.total },
    porPagamento: pagamentos.results, maisVendidas: top.results,
    anunciosML: Object.fromEntries(mlSt.results.map(r => [r.st, r.c])),
    semEtiqueta: semEtq.c, semFoto: semFoto.c,
    semAnuncio: semAnuncio.c, semLocal: semLocal.c, parado: parado.c,
    porCanal: canais.results, ultimas: ultimas.results,
  });
}
