// Testes de resolução: URL externa, 403, arquivo local, peça sem foto, estoque R2, rota de imagem, cache e segurança.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectaImagem } from '../src/catalogo-imagens.js';
import { png, ambiente, BASE } from './helpers-imagens.js';

const fakeRes = () => ({ cab: {}, codigo: 200, set(h, v) { if (typeof h === 'string') this.cab[h] = v; else Object.assign(this.cab, h); return this; }, status(c) { this.codigo = c; return this; }, json(o) { this.corpo = o; return this; }, send(b) { this.corpo = b; return this; }, end() { return this; } });

test('URL externa acessível vira foto própria; URL original com 403 é registrada e não vira imagem', async () => {
  const a = ambiente();
  try {
    const externa = await a.svc.resolverImagens({ id: 'p5', codigo: '97834-29000', nome: 'Mola Suspensão' }, {
      base: BASE, originais: ['https://http2.mlstatic.com/D_882781-MLB52368677345_112022-O.jpg'], originaisBrutos: 1 });
    assert.equal(externa.status, 'ok');
    assert.equal(externa.imagens[0].origem, 'catalogo-original');
    assert.equal(externa.fotos.length, 1);

    const bloqueada = await a.svc.resolverImagens({ id: 'p6', codigo: 'XX', nome: 'Alternador Hb20' }, {
      base: BASE, originais: ['https://files.ibrsoftweb.com.br/media/thumbnail/25327.png'], originaisBrutos: 1 });
    assert.equal(bloqueada.status, 'sem-foto');
    assert.ok(bloqueada.motivos.some(m => /original-bloqueada: files\.ibrsoftweb\.com\.br respondeu 403/.test(m)), JSON.stringify(bloqueada.motivos));
    assert.equal(a.svc.diagnostico().hostsOriginais['files.ibrsoftweb.com.br'].ok, false);
  } finally { a.limpa(); }
});

test('caminho local: casa por OEM no nome do arquivo e é servido sem sair da pasta autorizada', async () => {
  const a = ambiente();
  try {
    writeFileSync(join(a.locais, '37300-2B510_frente.png'), png(30, 20));
    writeFileSync(join(a.locais, 'IMG_0001.png'), png(5, 5));
    writeFileSync(join(tmpdir(), 'segredo-fora.png'), png(5, 5));
    const r = await a.svc.resolverImagens({ id: 'p7', codigo: '37300-2B510', nome: 'Alternador Hb20' }, { base: BASE });
    const local = r.imagens.find(i => i.origem === 'local');
    assert.ok(local, 'achou o arquivo local');
    assert.ok(!r.imagens.some(i => /IMG_0001/.test(decodeURIComponent(i.url))), 'nome genérico nunca casa');
    const res = fakeRes();
    await a.svc.servirImagem({ query: { local: new URL(local.url).searchParams.get('local') }, headers: {} }, res);
    assert.equal(res.codigo, 200);
    assert.equal(res.cab['Content-Type'], 'image/png');
    assert.equal(detectaImagem(res.corpo).largura, 30);
    for (const mal of ['0/../../package.json', '0/..%2f..%2fsegredo-fora.png', '0/../segredo-fora.png', '5/x.png', '0/%00.png']) assert.equal(a.svc.caminhoLocalSeguro(mal), null, mal);
  } finally { a.limpa(); }
});

test('peça sem fotografia nem OEM válido → sem-foto, sem inventar imagem', async () => {
  const a = ambiente();
  try {
    const r = await a.svc.resolverImagens({ id: 'p8', codigo: null, nome: 'Alternador Hb20 Creta 1.0 Turbo' }, { base: BASE });
    assert.equal(r.status, 'sem-foto');
    assert.deepEqual(r.imagens, []);
    assert.ok(r.motivos.some(m => /^sem-oem-valido/.test(m)));
  } finally { a.limpa(); }
});

test('fotos do estoque (R2) só entram com OEM igual E nome compatível', async () => {
  const estoque = [{ codigo: 12, pn: '37300-2B510', nome: 'Alternador Hb20 I30 Soul Cerato', fotos: JSON.stringify(['pecas/abc/1.webp', 'pecas/abc/2.jpg']) },
                   { codigo: 13, pn: '37300-2B510', nome: 'Capa de Volante Qualquer', fotos: JSON.stringify(['pecas/zzz/1.webp']) }];
  const a = ambiente({ estoque });
  try {
    const r = await a.svc.resolverImagens({ id: 'p9', codigo: '373002B510', nome: 'Alternador Hb20 Kia Soul Cerato 1.6' }, { base: BASE });
    assert.deepEqual(r.imagens.map(i => i.origem), ['estoque-r2', 'estoque-r2']);
    assert.equal(r.fotos.length, 2);
    assert.ok(r.imagens.every(i => /peça nº 12/.test(i.motivo)));
  } finally { a.limpa(); }
});
