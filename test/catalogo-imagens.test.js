// Testes do serviço de imagens do catálogo (origens simuladas; PNG/JPEG reais gerados em memória).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectaImagem, origemPermitida, tokensOEM, codigoValido, nomesBatem, mesmoComponente } from '../src/catalogo-imagens.js';
import { png, jpegMinimo, ambiente, BASE } from './helpers-imagens.js';

test('valida OEM, nome e origens autorizadas', () => {
  assert.deepEqual(tokensOEM('2614291 3730004050'), ['2614291', '3730004050', '26142913730004050']);
  assert.deepEqual(tokensOEM('5 Pinos'), []);
  assert.deepEqual(tokensOEM('G4'), []);
  assert.equal(codigoValido('00000000'), false);
  assert.ok(nomesBatem('Alternador Hb20 1.6', 'Alternador Hyundai Hb20 1.6 flex'));
  assert.ok(!nomesBatem('Alternador Hb20', 'Farol Dianteiro Gol'));
  assert.ok(!mesmoComponente('Alternador Hb20', 'Lupa com lente'));
  assert.ok(!mesmoComponente('Farol Dianteiro Direito Gol', 'Farol Dianteiro Esquerdo Gol'));
  assert.ok(origemPermitida(new URL('https://http2.mlstatic.com/a.jpg')));
  assert.ok(!origemPermitida(new URL('http://http2.mlstatic.com/a.jpg')));
  assert.ok(!origemPermitida(new URL('https://mlstatic.com.evil.com/a.jpg')));
  assert.ok(!origemPermitida(new URL('https://example.com/a.jpg')));
  assert.ok(!origemPermitida(new URL('https://ibr-api-prod.s3.amazonaws.com/media/a.png'), false), 'S3 só como destino de redirecionamento');
});

test('detectaImagem decodifica PNG/JPEG e rejeita lixo', () => {
  assert.deepEqual(detectaImagem(png(8, 6)), { tipo: 'image/png', largura: 8, altura: 6 });
  assert.equal(detectaImagem(jpegMinimo(16, 12)).tipo, 'image/jpeg');
  assert.equal(detectaImagem(Buffer.from('<html>403 Forbidden</html>')), null);
  assert.equal(detectaImagem(Buffer.alloc(100)), null);
});

test('OEM exato → fotos do catálogo oficial do ML, com a associação OEM↔produto registrada', async () => {
  const a = ambiente();
  try {
    const r = await a.svc.resolverImagens({ id: 'p1', codigo: '37300-2b510', nome: 'Alternador Hb20 Kia Soul Cerato Veloster I30 1.6 16v' }, { base: BASE });
    assert.equal(r.status, 'ok');
    assert.equal(r.imagens.length, 4);
    assert.ok(r.imagens.every(i => i.origem === 'ml-catalogo' && i.referencia === true && i.ml.id === 'MLB1' && /PART_NUMBER 373002b510/.test(i.motivo)));
    assert.deepEqual(r.fotos, [], 'foto de terceiros nunca entra em `fotos` (que alimenta o cadastro do anúncio)');
  } finally { a.limpa(); }
});

test('produto do ML com PART_NUMBER diferente, ou de outra peça, NÃO é aceito', async () => {
  const a = ambiente();
  try {
    const diferente = await a.svc.resolverImagens({ id: 'p2', codigo: '37300-2B910', nome: 'Alternador Hb20 2020 Creta Kia Soul' }, { base: BASE });
    assert.equal(diferente.status, 'sem-foto');
    const outraPeca = await a.svc.resolverImagens({ id: 'p3', codigo: '9999900001', nome: 'Alternador Hb20 Picanto' }, { base: BASE });
    assert.equal(outraPeca.status, 'sem-foto', 'mesmo código, mas é uma lupa');
  } finally { a.limpa(); }
});

test('peça com UMA fotografia e peça com VÁRIAS fotografias (sem duplicadas)', async () => {
  const a = ambiente();
  try {
    const uma = await a.svc.resolverImagens({ id: 'p4', codigo: '2614291 3730004050', nome: 'Alternador Hb20 Picanto 1.0 12v 3cc' }, { base: BASE });
    assert.equal(uma.imagens.length, 1);
    const varias = await a.svc.resolverImagens({ id: 'p1', codigo: '373002B510', nome: 'Alternador Hb20 1.6' }, { base: BASE });
    assert.equal(varias.imagens.length, 4);
    assert.equal(new Set(varias.imagens.map(i => i.url)).size, 4);
  } finally { a.limpa(); }
});
