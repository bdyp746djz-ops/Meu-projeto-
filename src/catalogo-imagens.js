// Imagens do catálogo local (server-catalogo.js): descobre, valida e serve as fotos das peças.
// Roda só no Node (servidor local da porta 3001) — não faz parte do Worker publicado.
//
// Fontes, em ordem de prioridade:
//   1. arquivos locais em pastas autorizadas (imagens-catalogo/, fotos_pecas/ ou CATALOGO_IMAGENS_DIR)
//   2. fotos do próprio estoque no R2 (rafa-fotos), quando OEM e nome da peça batem
//   3. URL original do catálogo (só se o host estiver respondendo imagem de verdade)
//   4. catálogo oficial do Mercado Livre (/products/search + PART_NUMBER igual ao OEM) — só referência
import { createHash } from 'node:crypto';
import { promises as fsp, existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { exec } from 'node:child_process';
import { join, resolve, sep, extname, basename, relative } from 'node:path';

export const TIPOS_IMAGEM = new Set(['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp']);
export const MAX_BYTES = 8 * 1024 * 1024;
const EXT_OK = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif']);
const TTL_CACHE_IMG = 30 * 24 * 3600e3;
const TTL_NEGATIVO = 10 * 60e3;
const TTL_ML_OK = 7 * 24 * 3600e3;
const TTL_ML_NAO = 24 * 3600e3;
const TTL_R2 = 6 * 3600e3;
const TTL_HOST = 10 * 60e3;
const ML_API = 'https://api.mercadolibre.com';

// ---------- texto / códigos ----------
export function semAcento(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
export function normalizaCodigo(s) { return semAcento(s).replace(/[^a-z0-9]/g, ''); }
// código que realmente identifica uma peça (descarta "5 Pinos", "G4", "0000"…)
export function codigoValido(t) {
  if (typeof t !== 'string' || t.length < 5) return false;
  if ((t.match(/\d/g) || []).length < 3) return false;
  return !/^(.)\1+$/.test(t);
}
export function tokensOEM(code) {
  const bruto = String(code || '').trim();
  if (!bruto) return [];
  const set = new Set();
  for (const t of [...bruto.split(/[\s,;/|]+/).map(normalizaCodigo), normalizaCodigo(bruto)]) if (codigoValido(t)) set.add(t);
  return [...set];
}
const STOP = new Set(['de', 'da', 'do', 'das', 'dos', 'para', 'com', 'sem', 'por', 'em', 'na', 'no', 'ate', 'kit', 'par', 'original', 'orig', 'usado', 'usada', 'novo', 'nova', 'peca', 'pecas']);
export function palavras(s) { return semAcento(s).split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOP.has(w)); }
// nomes de duas peças (estoque × catálogo) falam da mesma coisa?
export function nomesBatem(a, b) {
  const A = [...new Set(palavras(a))], B = new Set(palavras(b));
  if (!A.length || !B.size) return false;
  const comum = A.filter(w => B.has(w)).length;
  return comum >= Math.min(2, A.length, B.size) && comum / Math.min(A.length, B.size) >= 0.5;
}
function lados(s) {
  const t = ' ' + semAcento(s).replace(/[^a-z0-9]+/g, ' ') + ' ';
  const r = {};
  if (/ (direit[oa]|ld|dir) /.test(t)) r.lr = 'D'; else if (/ (esquerd[oa]|le|esq) /.test(t)) r.lr = 'E';
  if (/ (dianteir[oa]|diant|dt) /.test(t)) r.fr = 'F'; else if (/ (traseir[oa]|tras|tr) /.test(t)) r.fr = 'T';
  return r;
}
// o produto do ML é o mesmo tipo de peça do catálogo? (mesmo substantivo principal e sem lado oposto)
export function mesmoComponente(nomeCatalogo, nomeOutro) {
  const head = palavras(nomeCatalogo)[0];
  if (!head) return false;
  const stem = head.slice(0, 6);
  if (!palavras(nomeOutro).some(w => w.startsWith(stem) || stem.startsWith(w.slice(0, 6)))) return false;
  const a = lados(nomeCatalogo), b = lados(nomeOutro);
  return !(a.lr && b.lr && a.lr !== b.lr) && !(a.fr && b.fr && a.fr !== b.fr);
}

// ---------- validação real do conteúdo (não basta o Content-Type) ----------
export function detectaImagem(b) {
  if (!Buffer.isBuffer(b) || b.length < 12) return null;
  if (b[0] === 0xFF && b[1] === 0xD8) {   // JPEG: procura o marcador SOFn com as dimensões
    let i = 2;
    while (i < b.length - 9) {
      if (b[i] !== 0xFF) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xFF) { i++; continue; }
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        const altura = b.readUInt16BE(i + 5), largura = b.readUInt16BE(i + 7);
        return largura && altura ? { tipo: 'image/jpeg', largura, altura } : null;
      }
      if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
      i += 2 + b.readUInt16BE(i + 2);
    }
    return null;
  }
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504E47 && b.readUInt32BE(4) === 0x0D0A1A0A) {
    const largura = b.readUInt32BE(16), altura = b.readUInt32BE(20);
    return largura && altura ? { tipo: 'image/png', largura, altura } : null;
  }
  const cab = b.toString('latin1', 0, 6);
  if (cab === 'GIF87a' || cab === 'GIF89a') {
    const largura = b.readUInt16LE(6), altura = b.readUInt16LE(8);
    return largura && altura ? { tipo: 'image/gif', largura, altura } : null;
  }
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' && b.length >= 30) {
    const k = b.toString('latin1', 12, 16);
    let largura = 0, altura = 0;
    if (k === 'VP8 ') { largura = b.readUInt16LE(26) & 0x3fff; altura = b.readUInt16LE(28) & 0x3fff; }
    else if (k === 'VP8L') { const bits = b.readUInt32LE(21); largura = (bits & 0x3fff) + 1; altura = ((bits >> 14) & 0x3fff) + 1; }
    else if (k === 'VP8X') { largura = 1 + (b[24] | (b[25] << 8) | (b[26] << 16)); altura = 1 + (b[27] | (b[28] << 8) | (b[29] << 16)); }
    return largura && altura ? { tipo: 'image/webp', largura, altura } : null;
  }
  if (b.toString('latin1', 4, 8) === 'ftyp' && /avi[fs]/.test(b.toString('latin1', 8, 32))) return { tipo: 'image/avif', largura: 0, altura: 0 };
  return null;
}

// ---------- origens externas autorizadas (nada de proxy aberto) ----------
export function origemPermitida(u, ehRedirecionamento = false, workerHost = 'rafa-busca-pecas.rafabuscapecas.workers.dev') {
  if (!(u instanceof URL) || u.protocol !== 'https:' || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  if (h === 'files.ibrsoftweb.com.br') return !ehRedirecionamento && u.pathname.startsWith('/media/');
  if (h === 'ibr-api-prod.s3.amazonaws.com') return ehRedirecionamento && u.pathname.startsWith('/media/');
  if (/^[a-z0-9-]+\.mlstatic\.com$/.test(h)) return true;
  if (h === workerHost) return u.pathname.startsWith('/api/foto/');
  return false;
}

async function baixaComRedirect(fetchImpl, urlStr, { timeoutMs = 8000, maxBytes = MAX_BYTES, valida, headers }) {
  let atual;
  try { atual = new URL(urlStr); } catch { return { status: 400, erro: 'url-invalida' }; }
  for (let salto = 0; salto <= 3; salto++) {
    if (!valida(atual, salto > 0)) return { status: 400, erro: 'origem-nao-permitida' };
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(atual, { headers, redirect: 'manual', signal: ctl.signal });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get('location');
        try { await r.body?.cancel(); } catch { /* sem corpo */ }
        if (!loc) return { status: 502, erro: 'redirecionamento-invalido' };
        atual = new URL(loc, atual);
        continue;
      }
      if (!r.ok) { try { await r.body?.cancel(); } catch { /* sem corpo */ } return { status: r.status, erro: 'http-' + r.status, host: atual.hostname }; }
      const len = Number(r.headers.get('content-length'));
      if (len > maxBytes) { try { await r.body?.cancel(); } catch { /* sem corpo */ } return { status: 413, erro: 'imagem-grande-demais' }; }
      const chunks = []; let total = 0;
      for await (const c of r.body) {
        total += c.length;
        if (total > maxBytes) { ctl.abort(); return { status: 413, erro: 'imagem-grande-demais' }; }
        chunks.push(c);
      }
      return { status: 200, buf: Buffer.concat(chunks, total), contentType: (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(), host: atual.hostname };
    } catch (e) {
      return e && e.name === 'AbortError' ? { status: 504, erro: 'timeout' } : { status: 502, erro: String((e && e.message) || e).slice(0, 120) };
    } finally { clearTimeout(t); }
  }
  return { status: 502, erro: 'redirecionamentos-demais' };
}

const sha1 = s => createHash('sha1').update(s).digest('hex');

// ---------- Cloudflare D1 pelo wrangler (credencial do próprio usuário já logado) ----------
function lerNomeD1(baseDir) {
  try { return (readFileSync(join(baseDir, 'wrangler.toml'), 'utf8').match(/database_name\s*=\s*"([^"]+)"/) || [])[1] || null; } catch { return null; }
}
function d1Remoto(baseDir, sql) {
  const banco = lerNomeD1(baseDir);
  return new Promise((ok, falha) => {
    if (!banco) return falha(new Error('database_name não encontrado no wrangler.toml'));
    exec(`npx wrangler d1 execute ${banco} --remote --json --command "${sql}"`, { cwd: baseDir, maxBuffer: 64 * 1024 * 1024, timeout: 90000, windowsHide: true }, (err, out) => {
      if (err && !out) return falha(err);
      const i = out.search(/^\[/m);
      if (i < 0) return falha(new Error('resposta do D1 sem JSON'));
      try { const j = JSON.parse(out.slice(i)); ok((j[0] && j[0].results) || []); } catch (e) { falha(e); }
    });
  });
}

export function criarServicoImagens(opcoes = {}) {
  const baseDir = opcoes.baseDir || process.cwd();
  const cacheDir = opcoes.cacheDir || join(baseDir, 'cache', 'catalogo-imagens');
  const fetchImpl = opcoes.fetchImpl || globalThis.fetch;
  const agora = opcoes.agora || (() => Date.now());
  const workerBase = (opcoes.workerBase || process.env.FOTOS_PUBLIC_BASE || 'https://rafa-busca-pecas.rafabuscapecas.workers.dev').replace(/\/+$/, '');
  const workerHost = new URL(workerBase).hostname;
  const log = opcoes.log || console;
  const mlAtivo = opcoes.mlAtivo ?? process.env.CATALOGO_ML !== '0';
  const valida = (u, redir) => origemPermitida(u, redir, workerHost);
  const cabecalhos = { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.5', 'user-agent': 'RafaBuscaPecas/1.0 (catalog image preview)' };

  const stats = { pedidos: 0, cacheDisco: 0, baixadas: 0, negativoCache: 0, invalidas: 0, falhasPorStatus: {}, ml: { consultas: 0, confirmadas: 0, semMatch: 0, erros: 0 }, r2: 0, locais: 0 };
  const falha = chave => { stats.falhasPorStatus[chave] = (stats.falhasPorStatus[chave] || 0) + 1; };

  // ----- pastas locais autorizadas -----
  const dirsLocais = (opcoes.localDirs || [join(baseDir, 'imagens-catalogo'), join(baseDir, 'fotos_pecas'), process.env.CATALOGO_IMAGENS_DIR].filter(Boolean))
    .map(d => resolve(d)).filter(d => { try { return existsSync(d) && statSync(d).isDirectory(); } catch { return false; } });
  let indiceLocal = null, indiceLocalEm = 0;
  function construirIndiceLocal() {
    const porToken = new Map(), porNome = new Map(); let arquivos = 0;
    const add = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
    const anda = (idx, dir, prof) => {
      if (prof > 6 || arquivos > 300000) return;
      let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) { anda(idx, p, prof + 1); continue; }
        if (!e.isFile() || !EXT_OK.has(extname(e.name).toLowerCase())) continue;
        arquivos++;
        const rel = `${idx}/${relative(dirsLocais[idx], p).split(sep).join('/')}`;
        const nome = basename(e.name, extname(e.name));
        add(porNome, semAcento(e.name), rel);
        // "37300-2B510_frente" → 37300, 2b510, 373002b510 (junção de partes vizinhas), 373002b510frente…
        const partes = nome.split(/[^A-Za-z0-9]+/).filter(Boolean).map(normalizaCodigo), toks = new Set([normalizaCodigo(nome)]);
        for (let i = 0; i < partes.length; i++) for (let n = 1; n <= 3 && i + n <= partes.length; n++) toks.add(partes.slice(i, i + n).join(''));
        for (const t of toks) if (codigoValido(t)) add(porToken, t, rel);
      }
    };
    dirsLocais.forEach((d, i) => anda(i, d, 0));
    return { porToken, porNome, arquivos };
  }
  function indiceDeLocais() {
    if (!dirsLocais.length) return null;
    if (!indiceLocal || agora() - indiceLocalEm > 10 * 60e3) { indiceLocal = construirIndiceLocal(); indiceLocalEm = agora(); }
    return indiceLocal;
  }
  // ref = "<índice da pasta>/<caminho relativo>"; nunca sai da pasta autorizada
  function caminhoLocalSeguro(ref) {
    const m = String(ref || '').match(/^(\d+)\/(.+)$/);
    if (!m || !dirsLocais[+m[1]]) return null;
    let rel; try { rel = decodeURIComponent(m[2]); } catch { return null; }
    if (rel.includes('\0') || !EXT_OK.has(extname(rel).toLowerCase())) return null;
    const raiz = dirsLocais[+m[1]], alvo = resolve(raiz, rel);
    if (alvo !== raiz && !alvo.startsWith(raiz + sep)) return null;
    try { const s = statSync(alvo); return s.isFile() && s.size <= MAX_BYTES ? alvo : null; } catch { return null; }
  }


  // ----- obtenção + cache de imagens remotas -----
  const negativos = new Map(), emVoo = new Map();
  async function obterRemota(urlStr) {
    const chave = sha1(urlStr);
    const neg = negativos.get(chave);
    if (neg && agora() - neg.em < neg.ttl) { stats.negativoCache++; return { ok: false, status: neg.status, erro: neg.erro }; }
    try {
      const meta = JSON.parse(await fsp.readFile(join(cacheDir, chave + '.json'), 'utf8'));
      if (agora() - meta.ts < TTL_CACHE_IMG) { const buf = await fsp.readFile(join(cacheDir, chave + '.img')); stats.cacheDisco++; return { ok: true, buf, tipo: meta.tipo, etag: meta.etag, doCache: true }; }
    } catch { /* sem cache */ }
    if (emVoo.has(chave)) return emVoo.get(chave);
    const p = (async () => {
      const r = await baixaComRedirect(fetchImpl, urlStr, { valida, headers: cabecalhos });
      if (r.status !== 200) {
        negativos.set(chave, { em: agora(), ttl: r.status >= 500 ? 60e3 : TTL_NEGATIVO, status: r.status, erro: r.erro });
        falha(`${r.host || new URL(urlStr).hostname}:${r.status}`);
        return { ok: false, status: r.status, erro: r.erro };
      }
      const info = detectaImagem(r.buf);
      if (!info || !r.contentType.startsWith('image/')) {
        negativos.set(chave, { em: agora(), ttl: TTL_NEGATIVO, status: 415, erro: 'conteudo-nao-e-imagem' });
        stats.invalidas++;
        return { ok: false, status: 415, erro: 'conteudo-nao-e-imagem' };
      }
      const etag = '"' + createHash('sha1').update(r.buf).digest('hex').slice(0, 20) + '"';
      try {
        await fsp.mkdir(cacheDir, { recursive: true });
        await fsp.writeFile(join(cacheDir, chave + '.img'), r.buf);
        await fsp.writeFile(join(cacheDir, chave + '.json'), JSON.stringify({ url: urlStr, tipo: info.tipo, bytes: r.buf.length, largura: info.largura, altura: info.altura, ts: agora(), etag }));
      } catch (e) { log.error('Não consegui gravar o cache de imagens:', e.message); }
      stats.baixadas++;
      return { ok: true, buf: r.buf, tipo: info.tipo, etag };
    })().finally(() => emVoo.delete(chave));
    emVoo.set(chave, p);
    return p;
  }

  // GET /api/catalogo/img?url=<https autorizada> | ?local=<ref>
  async function servirImagem(req, res) {
    stats.pedidos++;
    try {
      let r;
      if (req.query.local) {
        const alvo = caminhoLocalSeguro(req.query.local);
        if (!alvo) return res.status(404).json({ erro: 'Imagem local não encontrada ou fora das pastas autorizadas' });
        const buf = await fsp.readFile(alvo), info = detectaImagem(buf);
        if (!info) return res.status(415).json({ erro: 'O arquivo local não é uma imagem válida' });
        r = { ok: true, buf, tipo: info.tipo, etag: '"' + createHash('sha1').update(buf).digest('hex').slice(0, 20) + '"' };
      } else {
        let u;
        try { u = new URL(String(req.query.url || '')); } catch { return res.status(400).json({ erro: 'URL de imagem inválida' }); }
        if (!valida(u, false)) return res.status(400).json({ erro: 'Origem de imagem não permitida' });
        r = await obterRemota(u.href);
      }
      if (!r.ok) {
        res.set('X-Origem-Status', String(r.status));
        return res.status(r.status === 504 ? 504 : r.status === 413 || r.status === 415 ? r.status : r.status >= 500 ? 502 : 404).json({ erro: 'Imagem indisponível na origem (' + (r.erro || r.status) + ')' });
      }
      res.set({ 'Content-Type': r.tipo, 'Cache-Control': 'public, max-age=86400', ETag: r.etag, 'Cross-Origin-Resource-Policy': 'cross-origin', 'X-Content-Type-Options': 'nosniff' });
      if (req.headers['if-none-match'] === r.etag) return res.status(304).end();
      return res.send(r.buf);
    } catch (e) {
      log.error('Erro ao servir imagem do catálogo:', e);
      return res.status(502).json({ erro: 'Não foi possível carregar a imagem do catálogo' });
    }
  }

  // ----- o host das fotos originais está devolvendo imagem de verdade? -----
  const hosts = new Map();
  async function hostOriginalOk(urlAmostra) {
    let u; try { u = new URL(urlAmostra); } catch { return { ok: false, motivo: 'url-invalida' }; }
    const h = u.hostname, c = hosts.get(h);
    if (c && agora() - c.em < TTL_HOST) return c.p ? c.p : { ok: c.ok, motivo: c.motivo };
    const p = obterRemota(u.href).then(r => {
      const est = { ok: r.ok, motivo: r.ok ? null : `${h} respondeu ${r.status}${r.erro ? ' (' + r.erro + ')' : ''}` };
      hosts.set(h, { em: agora(), ...est });
      return est;
    });
    hosts.set(h, { em: agora(), p });
    return p;
  }


  // ----- estoque no R2 (rafa-fotos) -----
  let r2 = null, r2Carregando = null;
  const arquivoR2 = join(cacheDir, 'estoque-r2.json');
  const carregaEstoque = opcoes.carregaEstoqueR2 || (() => d1Remoto(baseDir, "SELECT codigo,pn,nome,fotos FROM pecas WHERE fotos IS NOT NULL AND fotos NOT IN ('','[]')"));
  function montaIndiceR2(rows) {
    const mapa = new Map();
    for (const r of rows) {
      let ks = []; try { ks = JSON.parse(r.fotos || '[]'); } catch { ks = []; }
      ks = ks.filter(k => typeof k === 'string' && k && !k.includes('..'));
      if (!ks.length) continue;
      for (const t of tokensOEM(r.pn)) { if (!mapa.has(t)) mapa.set(t, []); mapa.get(t).push({ codigo: r.codigo, nome: r.nome || '', fotos: ks }); }
    }
    return mapa;
  }
  async function garanteR2() {
    if (r2 && agora() - r2.em < TTL_R2) return r2.mapa;
    if (!r2Carregando) {
      r2Carregando = (async () => {
        try {
          if (!r2) { try { const c = JSON.parse(await fsp.readFile(arquivoR2, 'utf8')); r2 = { em: c.em, mapa: montaIndiceR2(c.rows), total: c.rows.length }; } catch { /* sem cache */ } }
          if (!r2 || agora() - r2.em >= TTL_R2) {
            const rows = await carregaEstoque();
            r2 = { em: agora(), mapa: montaIndiceR2(rows), total: rows.length };
            try { await fsp.mkdir(cacheDir, { recursive: true }); await fsp.writeFile(arquivoR2, JSON.stringify({ em: r2.em, rows })); } catch { /* cache é opcional */ }
          }
        } catch (e) {
          log.error('Não consegui ler o estoque do D1 para casar fotos do R2:', e.message);
          if (!r2) r2 = { em: agora() - TTL_R2 + 60e3, mapa: new Map(), total: 0, erro: e.message };
        } finally { r2Carregando = null; }
      })();
    }
    await r2Carregando;
    return r2 ? r2.mapa : new Map();
  }

  // ----- Mercado Livre (API oficial, token OAuth da própria loja) -----
  let tokenML = null, tokenCarregando = null, tokenTentouEm = 0, mlMotivo = null;
  const lerToken = opcoes.obterTokenML || (async () => {
    if (process.env.ML_ACCESS_TOKEN) return { valor: process.env.ML_ACCESS_TOKEN, exp: Infinity };
    const rows = await d1Remoto(baseDir, "SELECT chave,valor FROM config WHERE chave IN ('ml_access_token','ml_token_exp')");
    const m = Object.fromEntries(rows.map(r => [r.chave, r.valor]));
    return m.ml_access_token ? { valor: m.ml_access_token, exp: Number(m.ml_token_exp) || 0 } : null;
  });
  async function obterTokenML(forcar = false) {
    if (!forcar && tokenML && tokenML.exp > agora() + 60e3) return tokenML.valor;
    if (!forcar && !tokenML && agora() - tokenTentouEm < 120e3) return null;
    if (!tokenCarregando) {
      tokenCarregando = (async () => {
        tokenTentouEm = agora();
        try {
          const t = await lerToken();
          if (!t) { tokenML = null; mlMotivo = 'token do Mercado Livre não encontrado no D1'; }
          else if (t.exp <= agora() + 60e3) { tokenML = null; mlMotivo = 'token do Mercado Livre expirado — abra o sistema e use qualquer função do ML para renová-lo'; }
          else { tokenML = t; mlMotivo = null; }
        } catch (e) { tokenML = null; mlMotivo = 'não consegui ler o token do ML: ' + e.message; }
        finally { tokenCarregando = null; }
      })();
    }
    await tokenCarregando;
    return tokenML ? tokenML.valor : null;
  }
  async function mlGet(caminho, tentativa = 0) {
    const tk = await obterTokenML();
    if (!tk) return { status: 0, erro: mlMotivo || 'sem-token' };
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 6000);
    try {
      const r = await fetchImpl(ML_API + caminho, { headers: { Authorization: 'Bearer ' + tk, accept: 'application/json' }, signal: ctl.signal });
      if (r.status === 401 && tentativa === 0) { tokenML = null; await obterTokenML(true); return mlGet(caminho, 1); }
      const json = await r.json().catch(() => null);
      return { status: r.status, json };
    } catch (e) { return { status: 0, erro: e && e.name === 'AbortError' ? 'timeout' : String((e && e.message) || e) }; }
    finally { clearTimeout(t); }
  }


  const atributosCodigo = new Set(['PART_NUMBER', 'ORIGINAL_PART_NUMBER', 'MPN', 'OEM_CODE', 'MANUFACTURER_PART_NUMBER']);
  function codigosDoProduto(prod) {
    const out = new Set();
    for (const a of prod.attributes || []) {
      if (!atributosCodigo.has(a.id)) continue;
      const vals = [a.value_name, ...((a.values || []).map(v => v && v.name))].filter(Boolean);
      for (const v of vals) { out.add(normalizaCodigo(v)); for (const p of String(v).split(/[\s,;/|]+/)) out.add(normalizaCodigo(p)); }
    }
    out.delete('');
    return out;
  }
  const arqIndiceML = join(cacheDir, 'indice-oem-ml.json');
  let indiceML = null, salvandoML = null;
  async function carregaIndiceML() {
    if (indiceML) return indiceML;
    try { indiceML = JSON.parse(await fsp.readFile(arqIndiceML, 'utf8')); } catch { indiceML = {}; }
    return indiceML;
  }
  function salvaIndiceML() {
    clearTimeout(salvandoML);
    salvandoML = setTimeout(async () => { try { await fsp.mkdir(cacheDir, { recursive: true }); await fsp.writeFile(arqIndiceML, JSON.stringify(indiceML)); } catch { /* cache é opcional */ } }, 1500);
    salvandoML.unref?.();
  }
  const mlEmVoo = new Map();
  // procura no catálogo do ML o produto cujo PART_NUMBER é exatamente o OEM e que é o mesmo tipo de peça
  async function buscaMLPorOEM(token, nomeCatalogo) {
    const idx = await carregaIndiceML();
    const chave = token + '|' + (palavras(nomeCatalogo)[0] || '');
    const c = idx[chave];
    if (c && agora() - c.ts < (c.produto ? TTL_ML_OK : TTL_ML_NAO)) return { produto: c.produto || null, doCache: true };
    if (mlEmVoo.has(chave)) return mlEmVoo.get(chave);
    const p = (async () => {
      stats.ml.consultas++;
      const s = await mlGet('/products/search?status=active&site_id=MLB&q=' + encodeURIComponent(token));
      if (s.status !== 200 || !s.json) { stats.ml.erros++; return { produto: null, erro: s.erro || 'ML respondeu HTTP ' + s.status }; }
      let achado = null;
      for (const cand of (s.json.results || []).slice(0, 3)) {
        if (!cand || !cand.id) continue;
        const d = await mlGet('/products/' + encodeURIComponent(cand.id));
        if (d.status !== 200 || !d.json) continue;
        if (!codigosDoProduto(d.json).has(token)) continue;                       // o OEM tem que ser exatamente o do produto
        if (!mesmoComponente(nomeCatalogo, d.json.name || '')) continue;          // e tem que ser o mesmo tipo de peça
        const fotos = (d.json.pictures || []).map(x => x && x.url).filter(u => typeof u === 'string' && /^https:\/\/[a-z0-9-]+\.mlstatic\.com\//i.test(u)).slice(0, 6);
        if (!fotos.length) continue;
        achado = { id: d.json.id, nome: d.json.name || '', link: d.json.permalink || null, fotos };
        break;
      }
      if (achado) stats.ml.confirmadas++; else stats.ml.semMatch++;
      idx[chave] = { ts: agora(), produto: achado };
      salvaIndiceML();
      return { produto: achado };
    })().finally(() => mlEmVoo.delete(chave));
    mlEmVoo.set(chave, p);
    return p;
  }

  const proxy = (base, url) => `${base}/api/catalogo/img?url=${encodeURIComponent(url)}`;
  const comTimeout = (promessa, ms, valor) => Promise.race([promessa, new Promise(r => { const t = setTimeout(() => r(valor), ms); t.unref?.(); })]);


  // Descobre as fotos de UMA peça do catálogo. Nunca lança: se falhar devolve lista vazia com os motivos.
  // peca = { id, codigo, nome, catalog_item_id? }   ctx = { base, originais: [https absolutas], originaisRelativos: [caminhos], originaisBrutos }
  async function resolverImagens(peca, ctx = {}) {
    const base = (ctx.base || '').replace(/\/+$/, '');
    const imagens = [], motivos = [], proprias = [];
    const tokens = tokensOEM(peca.codigo);
    const vistos = new Set();
    const empurra = (img, propria) => { if (vistos.has(img.url)) return; vistos.add(img.url); imagens.push(img); if (propria && img.absoluta) proprias.push(img.absoluta); };

    // 1) arquivos locais em pastas autorizadas
    try {
      const il = indiceDeLocais();
      if (il) {
        const refs = new Set();
        for (const t of [...tokens, normalizaCodigo(peca.id), normalizaCodigo(peca.catalog_item_id)]) for (const r of il.porToken.get(t) || []) refs.add(r);
        // pelo nome original do arquivo no banco — só quando o nome é específico (evita casar "IMG_1.jpg" com peças diferentes)
        for (const o of ctx.originaisRelativos || []) {
          let n, stem; try { n = semAcento(basename(decodeURIComponent(String(o)))); stem = normalizaCodigo(n.replace(/\.[a-z0-9]+$/, '')); } catch { continue; }
          if (!codigoValido(stem)) continue;
          for (const r of il.porNome.get(n) || []) refs.add(r);
        }
        for (const r of [...refs].slice(0, 12)) { stats.locais++; empurra({ url: `${base}/api/catalogo/img?local=${encodeURIComponent(r)}`, origem: 'local', confirmada: true, motivo: 'arquivo em pasta autorizada com o OEM/ID no nome' }, false); }
      }
    } catch (e) { motivos.push('locais: ' + e.message); }

    // 2) fotos do próprio estoque (R2), só com OEM igual E nome compatível
    if (tokens.length) {
      try {
        const mapa = await comTimeout(garanteR2(), 20000, null);
        if (mapa) {
          for (const t of tokens) for (const it of mapa.get(t) || []) {
            if (!nomesBatem(peca.nome, it.nome)) continue;
            for (const k of it.fotos.slice(0, 8)) {
              const abs = `${workerBase}/api/foto/${k.split('/').map(encodeURIComponent).join('/')}`;
              stats.r2++;
              empurra({ url: proxy(base, abs), origem: 'estoque-r2', confirmada: true, motivo: `peça nº ${it.codigo} do seu estoque (mesmo OEM e nome)`, absoluta: abs }, true);
            }
          }
        } else motivos.push('estoque-r2: demorou demais para carregar');
      } catch (e) { motivos.push('estoque-r2: ' + e.message); }
    }

    // 3) fotos originais do catálogo — só se o host estiver devolvendo imagem de verdade
    const originais = [...new Set(ctx.originais || [])].filter(u => { try { return valida(new URL(u), false); } catch { return false; } });
    if (originais.length) {
      const h = await hostOriginalOk(originais[0]);
      if (h.ok) for (const u of originais.slice(0, 8)) empurra({ url: proxy(base, u), origem: 'catalogo-original', confirmada: true, motivo: 'foto cadastrada na própria peça do catálogo', absoluta: u }, true);
      else motivos.push('original-bloqueada: ' + h.motivo);
    } else if ((ctx.originaisBrutos || 0) > 0) motivos.push('original-fora-da-lista-autorizada');

    // 4) catálogo oficial do ML, só referência (não entra em `fotos`, que alimenta o cadastro do anúncio)
    if (!imagens.length && mlAtivo && tokens.length) {
      let achou = false;
      for (const t of tokens.slice(0, 2)) {
        const r = await comTimeout(buscaMLPorOEM(t, peca.nome), 9000, { produto: null, erro: 'timeout' });
        if (r.produto) {
          achou = true;
          for (const u of r.produto.fotos) empurra({ url: proxy(base, u), origem: 'ml-catalogo', confirmada: true, referencia: true, motivo: `produto ${r.produto.id} do catálogo do ML com PART_NUMBER ${t}`, ml: { id: r.produto.id, nome: r.produto.nome, link: r.produto.link } }, false);
          break;
        }
        if (r.erro) motivos.push('ml: ' + r.erro);
      }
      if (!achou && !motivos.some(m => m.startsWith('ml:'))) motivos.push('ml: nenhum produto com PART_NUMBER idêntico ao OEM e mesmo tipo de peça');
    } else if (!imagens.length && !tokens.length) motivos.push('sem-oem-valido: o código da peça não identifica um OEM, então não busquei foto de terceiros');

    return { imagens, foto: proprias[0] || null, fotos: proprias, status: imagens.length ? 'ok' : 'sem-foto', motivos };
  }

  function diagnostico() {
    return {
      stats,
      pastasLocais: dirsLocais, arquivosLocais: indiceLocal ? indiceLocal.arquivos : 0,
      estoqueR2: r2 ? { pecasComFoto: r2.total, oemsIndexados: r2.mapa.size, erro: r2.erro || null } : null,
      mercadoLivre: { ativo: mlAtivo, tokenValido: !!(tokenML && tokenML.exp > agora()), motivo: mlMotivo },
      hostsOriginais: Object.fromEntries([...hosts].map(([h, v]) => [h, v.p ? 'verificando' : { ok: v.ok, motivo: v.motivo }])),
      cache: cacheDir
    };
  }

  return { servirImagem, resolverImagens, diagnostico, obterRemota, caminhoLocalSeguro, indiceDeLocais, garanteR2, buscaMLPorOEM, hostOriginalOk, obterTokenML, dirsLocais };
}

