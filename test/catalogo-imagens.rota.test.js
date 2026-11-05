// Testes da rota /api/catalogo/img: HTTP 200, image/*, conteúdo decodificável, cache, 304 e recusas de segurança.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectaImagem } from '../src/catalogo-imagens.js';
import { ambiente } from './helpers-imagens.js';

const fakeRes = () => ({ cab: {}, codigo: 200, set(h, v) { if (typeof h === 'string') this.cab[h] = v; else Object.assign(this.cab, h); return this; }, status(c) { this.codigo = c; return this; }, json(o) { this.corpo = o; return this; }, send(b) { this.corpo = b; return this; }, end() { return this; } });

test('rota de imagem: HTTP 200, image/*, conteúdo decodificável, cache em disco e 304', async () => {
  const a = ambiente();
  try {
    const url = 'https://http2.mlstatic.com/D_NQ_NP_MLB1_0-F.jpg';
    const r1 = fakeRes(); await a.svc.servirImagem({ query: { url }, headers: {} }, r1);
    assert.equal(r1.codigo, 200);
    assert.match(r1.cab['Content-Type'], /^image\//);
    assert.ok(detectaImagem(r1.corpo), 'o corpo é uma imagem decodificável');
    const antes = a.chamadas.total;
    const r2 = fakeRes(); await a.svc.servirImagem({ query: { url }, headers: {} }, r2);
    assert.equal(a.chamadas.total, antes, 'segunda leitura vem do cache, sem nova requisição');
    const r3 = fakeRes(); await a.svc.servirImagem({ query: { url }, headers: { 'if-none-match': r1.cab.ETag } }, r3);
    assert.equal(r3.codigo, 304);
  } finally { a.limpa(); }
});

test('rota de imagem: recusa origens não autorizadas, conteúdo que não é imagem e 403 do host', async () => {
  const a = ambiente();
  try {
    for (const url of ['https://example.com/a.png', 'http://http2.mlstatic.com/a.jpg', 'https://mlstatic.com.evil.com/a.jpg', 'file:///c:/windows/win.ini', '']) {
      const r = fakeRes(); await a.svc.servirImagem({ query: { url }, headers: {} }, r);
      assert.equal(r.codigo, 400, url);
    }
    const falsa = fakeRes(); await a.svc.servirImagem({ query: { url: 'https://http2.mlstatic.com/quebrada.jpg' }, headers: {} }, falsa);
    assert.equal(falsa.codigo, 415, 'Content-Type image/jpeg mas o conteúdo é HTML');
    const bloqueada = fakeRes(); await a.svc.servirImagem({ query: { url: 'https://files.ibrsoftweb.com.br/media/thumbnail/25327.png' }, headers: {} }, bloqueada);
    assert.equal(bloqueada.codigo, 404);
    assert.equal(bloqueada.cab['X-Origem-Status'], '403');
  } finally { a.limpa(); }
});

test('requisições simultâneas da mesma imagem baixam uma vez só', async () => {
  const a = ambiente();
  try {
    const url = 'https://http2.mlstatic.com/D_NQ_NP_MLB1_1-F.jpg';
    const rs = await Promise.all(Array.from({ length: 6 }, async () => { const r = fakeRes(); await a.svc.servirImagem({ query: { url }, headers: {} }, r); return r; }));
    assert.ok(rs.every(r => r.codigo === 200));
    assert.equal(a.chamadas.urls.filter(u => u === url).length, 1);
  } finally { a.limpa(); }
});
