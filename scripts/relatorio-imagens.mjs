// RelatÃ³rio de cobertura de imagens do catÃ¡logo (somente leitura no SQLite).
// Uso: node scripts/relatorio-imagens.mjs [amostra=300]
// Parte contada no banco inteiro (agregaÃ§Ãµes SQL); a recuperaÃ§Ã£o real Ã© medida numa amostra aleatÃ³ria,
// porque consultar o Mercado Livre para 2,1 milhÃµes de peÃ§as levaria dias e estouraria o limite da API.
import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync } from 'node:fs';
import { criarServicoImagens, tokensOEM, detectaImagem } from '../src/catalogo-imagens.js';

const N = Math.max(20, parseInt(process.argv[2], 10) || 300);
const db = new Database('pecas_full_completo.db', { readonly: true, fileMustExist: true });
const svc = criarServicoImagens({ baseDir: process.cwd() });
const rel = { geradoEm: new Date().toISOString(), amostra: N };

console.log('Contando no banco inteiro (leva ~1 minuto)â€¦');
const g = db.prepare(`SELECT count(*) total,
  sum(photos IS NOT NULL AND photos NOT IN ('','[]')) com_foto,
  sum(photo LIKE 'http%') foto_http,
  sum(photo LIKE '/%') foto_relativa,
  sum(photos IN ('','[]') OR photos IS NULL) sem_foto FROM pecas`).get();
rel.banco = g;

// amostra aleatÃ³ria espalhada pelo banco (rowid), sÃ³ peÃ§as com foto cadastrada
const max = db.prepare('SELECT MAX(rowid) m FROM pecas').get().m;
const pegar = db.prepare("SELECT rowid,id,name,code,photo,photos FROM pecas WHERE rowid >= ? AND photos NOT IN ('','[]') LIMIT 1");
const amostra = [];
for (let i = 0; i < N * 3 && amostra.length < N; i++) { const r = pegar.get(1 + Math.floor(Math.random() * max)); if (r && !amostra.some(a => a.id === r.id)) amostra.push(r); }

const t = { examinadas: 0, comUrl: 0, comOemValido: 0, semOemValido: 0, originalAcessivel: 0, originalBloqueada: 0, locais: 0, estoqueR2: 0, mlConfirmadas: 0, recuperadas: 0, semFoto: 0, mlErros: 0 };
const hosts = {}; const comMl = [];
const base = 'http://localhost:3001';
const normaliza = v => { try { const a = JSON.parse(v); return a.map(x => x && (x.url || x.thumbnailUrl)).filter(Boolean); } catch { return []; } };

for (const p of amostra) {
  t.examinadas++;
  const urls = normaliza(p.photos); if (urls.length || p.photo) t.comUrl++;
  const originais = [...new Set([p.photo, ...urls].filter(Boolean).map(u => /^https?:/i.test(u) ? u : 'https://files.ibrsoftweb.com.br/media/' + String(u).replace(/^\/+/, '')))];
  for (const u of originais.slice(0, 1)) { try { const h = new URL(u).host; hosts[h] = (hosts[h] || 0) + 1; } catch { /* ignora */ } }
  tokensOEM(p.code).length ? t.comOemValido++ : t.semOemValido++;
  const r = await svc.resolverImagens({ id: p.id, codigo: p.code, nome: p.name }, { base, originais, originaisBrutos: originais.length, originaisRelativos: originais.map(u => { try { return new URL(u).pathname; } catch { return ''; } }) });
  const origens = new Set(r.imagens.map(i => i.origem));
  if (origens.has('catalogo-original')) t.originalAcessivel++;
  else if (r.motivos.some(m => m.startsWith('original-bloqueada'))) t.originalBloqueada++;
  if (origens.has('local')) t.locais++;
  if (origens.has('estoque-r2')) t.estoqueR2++;
  if (origens.has('ml-catalogo')) { t.mlConfirmadas++; comMl.push({ oem: p.code, peca: p.name.slice(0, 50), produtoML: r.imagens[0].ml.id, fotos: r.imagens.length, primeiraUrl: decodeURIComponent(new URL(r.imagens[0].url).searchParams.get('url')) }); }
  if (r.motivos.some(m => /^ml: (ML respondeu|timeout|token|nÃ£o consegui)/.test(m))) t.mlErros++;
  r.imagens.length ? t.recuperadas++ : t.semFoto++;
  if (t.examinadas % 25 === 0) console.log(`  â€¦${t.examinadas}/${amostra.length}`);
}

// imagens realmente acessÃ­veis: baixa e decodifica uma miniatura de cada peÃ§a recuperada
// confere que a primeira imagem de cada peca recuperada (ate 40) baixa e DECODIFICA de verdade
let decodificam = 0, testadas = 0;
for (const c of comMl.slice(0, 40)) {
  testadas++;
  const r = await svc.obterRemota(c.primeiraUrl);
  if (r.ok && detectaImagem(r.buf)) decodificam++;
}
rel.verificacaoDecodificacao = { testadas, decodificam };
rel.amostraResultado = t; rel.hostsOriginais = hosts; rel.exemplosMlConfirmados = comMl.slice(0, 8); rel.diagnostico = svc.diagnostico();
const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : '0%';
const estim = Math.round(g.com_foto * t.recuperadas / Math.max(1, t.examinadas));
rel.projecao = { recuperaveisEstimadosNoBancoInteiro: estim, observacao: 'estimativa por amostragem; o resultado real Ã© calculado por busca, sob demanda' };

mkdirSync('cache', { recursive: true });
writeFileSync('cache/relatorio-imagens.json', JSON.stringify(rel, null, 2));
console.log(`
RELATÃ“RIO DE IMAGENS DO CATÃLOGO
Banco inteiro (${g.total.toLocaleString('pt-BR')} peÃ§as):
  com URL/caminho de foto cadastrado ......... ${g.com_foto.toLocaleString('pt-BR')}
  sem nenhuma foto cadastrada ................ ${g.sem_foto.toLocaleString('pt-BR')}
  foto como caminho relativo ................. ${g.foto_relativa.toLocaleString('pt-BR')}
  foto como URL https (mlstatic) ............. ${g.foto_http.toLocaleString('pt-BR')}
Amostra aleatÃ³ria de ${t.examinadas} peÃ§as com foto cadastrada:
  hosts das fotos originais ................... ${JSON.stringify(hosts)}
  fotos originais acessÃ­veis (HTTP 200) ....... ${t.originalAcessivel} (${pct(t.originalAcessivel, t.examinadas)})
  fotos originais bloqueadas (HTTP 403) ....... ${t.originalBloqueada} (${pct(t.originalBloqueada, t.examinadas)})
  imagens locais encontradas .................. ${t.locais}
  casadas com o estoque (R2) .................. ${t.estoqueR2}
  OEM vÃ¡lido para buscar no ML ................ ${t.comOemValido} (${pct(t.comOemValido, t.examinadas)})
  correspondÃªncias confirmadas no ML .......... ${t.mlConfirmadas} (${pct(t.mlConfirmadas, t.comOemValido)} dos com OEM vÃ¡lido)
  peÃ§as com imagem real recuperada ............ ${t.recuperadas} (${pct(t.recuperadas, t.examinadas)})
  peÃ§as ainda sem fotografia .................. ${t.semFoto} (${pct(t.semFoto, t.examinadas)})
  erros de consulta ao ML ..................... ${t.mlErros}
  imagens baixadas e decodificadas ............ ${decodificam}/${testadas}
ProjeÃ§Ã£o para o banco inteiro: ~${estim.toLocaleString('pt-BR')} peÃ§as com foto recuperÃ¡vel.
Arquivo: cache/relatorio-imagens.json`);

