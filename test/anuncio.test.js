import { test } from 'node:test';
import assert from 'node:assert/strict';
import { montarAnuncio } from '../src/anuncio.js';

test('monta título e descrição com compatibilidades e código interno', () => {
  const r = montarAnuncio({
    nome:'caixa de fusível', pn:'9674982680', carro:'citroën aircross', motor:'1.6 16v',
    ano:'2012/2015', combustivel:'flex', condicao:'usado', origem:'Citroën Aircross 2013 – ABC1D23',
    compatibilidades:['Citroën C4 Aircross 2012-2016'], preco:200, codigo:691,
  });
  assert.ok(r.titulo.length <= 60);
  assert.match(r.descricao, /Código original \(part number\): 9674982680/);
  assert.match(r.descricao, /Compatível com:/);
  assert.match(r.descricao, /Citroën Aircross 2013/);      // origem entra sempre
  assert.match(r.descricao, /Garantia de 90 dias/);
  assert.match(r.descricao, /#000691/);
});

test('peça nova muda o texto', () => {
  const r = montarAnuncio({ nome:'bomba de água', pn:'ABC123', carro:'Fiat Uno', condicao:'novo', codigo:5 });
  assert.match(r.descricao, /Condição: Nova, sem uso/);
  assert.match(r.descricao, /Peça nova\./);
});
