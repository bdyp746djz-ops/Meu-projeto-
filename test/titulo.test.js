import { test } from 'node:test';
import assert from 'node:assert/strict';
import { montarTitulo, capitaliza, LIMITE } from '../src/titulo.js';

test('segue a ordem: nome, pn, carro, motor, ano, modelo, combustível', () => {
  const r = montarTitulo({ nome: 'caixa filtro ar', pn: '7560918', carro: 'bmw 120i', motor: '2.0', ano: '2008/2011', modelo: 'e87', combustivel: 'gasolina' });
  assert.equal(r.titulo, 'Caixa Filtro Ar 7560918 BMW 120i 2.0 2008/2011 E87 Gasolina');
  assert.deepEqual(r.cortes, []);
});

test('campos vazios são ignorados', () => {
  const r = montarTitulo({ nome: 'Farol Esquerdo', pn: '5U0941005', carro: 'VW Gol', ano: '2009-2012' });
  assert.equal(r.titulo, 'Farol Esquerdo 5U0941005 VW Gol 2009/2012');
});

test('ano curto quando precisa e siglas de versão', () => {
  const r = montarTitulo({ nome: 'Caixa fusível', pn: '9674982680', carro: 'Citroën Aircross', motor: '1.6 16v', ano: '2012/2015', combustivel: 'flex' });
  assert.equal(r.titulo, 'Caixa Fusível 9674982680 Citroën Aircross 1.6 16V 12/15 Flex');
  assert.equal(capitaliza('peugeot 208 gt'), 'Peugeot 208 GT');
  assert.equal(capitaliza('bmw 120i e87'), 'BMW 120i E87');
});

test('normaliza capitalização, motor, ano curto e combustível', () => {
  assert.equal(capitaliza('CAIXA DE FUSIVEL do MOTOR'), 'Caixa de Fusivel do Motor');
  const r = montarTitulo({ nome: 'modulo injeção', pn: '8s51-12a650', carro: 'ford ka', motor: '1,0 8v', ano: '08/13', combustivel: 'FLEX' });
  assert.equal(r.titulo, 'Modulo Injeção 8S51-12A650 Ford Ka 1.0 8V 2008/2013 Flex');
});

test('encurta em etapas e nunca passa de 60, preservando nome, pn e carro', () => {
  const p = { nome: 'Acabamento Inferior Direito do Painel', pn: '7071272', carro: 'BMW 118i 120i 130i', motor: '2.0 16V', ano: '2007/2011', modelo: 'Hatch E87', combustivel: 'Gasolina' };
  const r = montarTitulo(p);
  assert.ok(r.tamanho <= LIMITE, r.titulo);
  assert.equal(r.titulo, 'Acabamento Inferior Direito 7071272 BMW 118i 120i 130i');
  assert.ok(r.cortes.length > 0);
});

test('nome muito longo é cortado por palavra, mantendo pn e carro', () => {
  const r = montarTitulo({ nome: 'Chicote Elétrico Completo do Motor com Módulo e Sensores Originais', pn: '1234567890', carro: 'Citroën Aircross', ano: '2012/2015' });
  assert.ok(r.tamanho <= LIMITE, r.titulo);
  assert.match(r.titulo, /1234567890 Citroën Aircross$/);
  assert.ok(r.cortes.includes('nome encurtado'));
});
