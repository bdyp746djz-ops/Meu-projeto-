import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sugerirPreco, termoAvaria } from '../src/preco.js';

const peca = { condicao: 'usado', pn: '9674982680' };
const anuncios = [
  { id:'A', titulo:'Caixa Fusivel Citroen Aircross 9674982680', preco:200, condicao:'usado', pn:'9674982680' },
  { id:'B', titulo:'Caixa Fusivel Aircross NO ESTADO para retirada de peças', preco:60, condicao:'usado', pn:'9674982680' },
  { id:'C', titulo:'Caixa Fusivel C4 Aircross original 967.498.2680', preco:240, condicao:'usado', pn:'9674982680' },
  { id:'D', titulo:'Caixa Fusivel Aircross NOVA', preco:500, condicao:'novo', pn:'9674982680' },
  { id:'E', titulo:'Caixa Fusivel Aircross', preco:30, condicao:'usado', pn:'' },
  { id:'F', titulo:'Caixa Fusivel Aircross 9674982680', preco:220, condicao:'usado', pn:'9674982680' },
];

test('separa inteiras das quebradas e sugere preço só das boas', () => {
  const r = sugerirPreco(peca, anuncios);
  const usadosIds = r.usados.map(u => u.id).sort();
  assert.deepEqual(usadosIds, ['A','C','F']);               // só as comparáveis e inteiras
  assert.deepEqual(r.sugerido, { min:200, mediana:220, max:240 });
  assert.equal(r.confianca, 'boa');
  const motivo = id => r.descartados.find(d => d.anuncio.id===id).motivo;
  assert.match(motivo('B'), /avariado/);                     // "no estado / retirada de peças"
  assert.match(motivo('D'), /condição diferente/);           // nova, não compara com usada
  assert.match(motivo('E'), /fora da curva/);                // R$ 30 é outlier baixo
});

test('casa part number mesmo com pontuação diferente', () => {
  const r = sugerirPreco(peca, [anuncios[2]]); // "967.498.2680"
  assert.equal(r.usados[0].pnBate, true);
});

test('detecta vários termos de avaria', () => {
  assert.ok(termoAvaria('vendo motor TRINCADO'));
  assert.ok(termoAvaria('somente a carcaça, não funciona'));
  assert.equal(termoAvaria('peça testada e em perfeito estado'), null);
});

test('exigirPn descarta quem não tem o código', () => {
  const r = sugerirPreco(peca, anuncios, { exigirPn: true });
  assert.ok(!r.usados.some(u => u.id === 'E'));
});
