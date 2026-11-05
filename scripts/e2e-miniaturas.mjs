// Teste de ponta a ponta (navegador real): pesquisa na Etapa 1 e confere se as miniaturas DECODIFICAM de verdade.
// Uso: node scripts/e2e-miniaturas.mjs "alternador hb20"   (o servidor local da porta 3001 precisa estar ativo)
import { chromium } from 'playwright';
import fs from 'node:fs';
import http from 'node:http';

const termo = process.argv[2] || 'alternador hb20';
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1100, height: 1500 } })).newPage();
const problemas = [];
p.on('pageerror', e => problemas.push('pageerror: ' + e.message));
p.on('requestfailed', r => problemas.push('requisiÃ§Ã£o falhou: ' + r.url().slice(0, 90) + ' ' + (r.failure() || {}).errorText));
const srv = http.createServer((rq, rs) => {
  const u = new URL(rq.url, 'http://x');
  const j = o => { rs.writeHead(200, { 'content-type': 'application/json' }); rs.end(JSON.stringify(o)); };
  if (u.pathname === '/') { rs.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return rs.end(html); }
  if (u.pathname === '/api/me') return j({ user: { id: 'u1', nome: 'Teste', login: 'teste', papel: 'admin' } });
  if (u.pathname.startsWith('/api/')) return j({ locais: [], pecas: [], fotos: [] });
  rs.writeHead(204); rs.end();
});
await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
const origem = 'http://localhost:' + srv.address().port;
await p.goto(origem + "/");
await p.waitForFunction(() => typeof go === 'function' && document.querySelector('#navb'), null, { timeout: 15000 });
await p.evaluate(() => go('nova'));
await p.waitForSelector('#wzq', { timeout: 15000 });
await p.fill('#wzq', termo);
await p.click('#wzb');
try { await p.waitForSelector('.wz-it', { timeout: 90000 }); }
catch { console.log('Sem resultados na tela. ConteÃºdo:', (await p.locator('#wzexternal').innerText()).slice(0, 300)); }
await p.waitForTimeout(8000);
const linhas = await p.$$eval('.wz-it', its => its.map(it => {
  const img = it.querySelector('.wz-mini img');
  return { nome: (it.querySelector('b') || {}).textContent?.slice(0, 48), foto: !!img, decodificou: img ? img.complete && img.naturalWidth > 0 : false, largura: img ? img.naturalWidth : 0, fotos: Number((it.querySelector('.wz-mais') || {}).textContent) || (img ? 1 : 0), referencia: !!it.querySelector('.wz-ref'), placeholder: !!it.querySelector('.wz-mini svg.wz-img-fallback') };
}));
console.table(linhas);
const comFoto = linhas.filter(l => l.decodificou).length;
console.log(`Resultados: ${linhas.length} | miniaturas reais decodificadas: ${comFoto} | placeholders: ${linhas.filter(l => l.placeholder).length} | imagens quebradas: ${linhas.filter(l => l.foto && !l.decodificou).length}`);
await p.locator('.wz-mini[data-gal]').first().click().catch(() => {});
await p.waitForTimeout(1500);
const galeria = await p.$$eval('#modal .photos img', ims => ims.map(i => i.complete && i.naturalWidth > 0));
console.log('Galeria (modal):', galeria.length, 'fotos,', galeria.filter(Boolean).length, 'decodificadas');
await p.screenshot({ path: new URL('../cache/etapa1-' + termo.replace(/\W+/g, '-') + '.png', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') });
if (problemas.length) console.log('Problemas na pÃ¡gina:', problemas.slice(0, 6));
await b.close();
process.exit(comFoto > 0 ? 0 : 1);

