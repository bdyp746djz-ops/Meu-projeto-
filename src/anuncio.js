// Monta o anúncio completo (título + descrição) a partir dos dados da peça,
// reaproveitando o padrão de título. Pronto para copiar/colar ou publicar via API.

import { montarTitulo, capitaliza } from './titulo.js';

const linha = s => String(s ?? '').replace(/\s+/g, ' ').trim();

const COND_TXT = {
  novo: 'Nova, sem uso',
  usado: 'Usada, em bom estado',
  recondicionado: 'Recondicionada',
};

// peca = { nome, pn, carro, motor, ano, modelo, combustivel, condicao,
//          compatibilidades:[...], origem, preco, codigo, obs, garantiaDias }
export function montarAnuncio(peca) {
  const { titulo, tamanho, cortes } = montarTitulo(peca);
  const veic = linha([capitaliza(peca.carro), peca.motor, peca.ano].filter(Boolean).join(' '));
  const cond = COND_TXT[linha(peca.condicao).toLowerCase()] || peca.condicao || 'Usada, em bom estado';
  const ehUsada = !/^nov/i.test(linha(peca.condicao));
  const gar = peca.garantiaDias ?? 90;

  const compat = (peca.compatibilidades || []).map(linha).filter(Boolean);
  // O carro de origem entra sempre, como compatibilidade garantida.
  if (peca.origem && !compat.some(c => c.toLowerCase() === linha(peca.origem).toLowerCase())) {
    compat.unshift(linha(peca.origem));
  }

  const L = [];
  L.push(`${capitaliza(peca.nome)}${veic ? ' ' + veic : ''}`);
  L.push('');
  L.push(`✅ Condição: ${cond}`);
  if (peca.pn) L.push(`🔢 Código original (part number): ${linha(peca.pn).toUpperCase()}`);
  if (compat.length) {
    L.push('🚗 Compatível com:');
    compat.forEach(c => L.push(`   • ${c}`));
    L.push('   Confira a compatibilidade pelo código original antes de comprar.');
  } else if (peca.origem) {
    L.push(`🚗 Retirada de ${linha(peca.origem)} — confira a compatibilidade pelo código original antes de comprar.`);
  }
  if (linha(peca.obs)) L.push(`📝 ${linha(peca.obs)}`);
  L.push(`📦 Peça${ehUsada ? ' original, testada e conferida' : ' nova'}. Enviamos para todo o Brasil.`);
  L.push(`🛡️ Garantia de ${gar} dias contra defeito de funcionamento.`);
  L.push('❓ Ficou com dúvida? Chame no chat informando o chassi ou o modelo exato antes de comprar.');
  if (peca.codigo != null) { L.push(''); L.push(`Código interno: #${String(peca.codigo).padStart(6, '0')}`); }

  return { titulo, tituloTamanho: tamanho, tituloCortes: cortes, descricao: L.join('\n') };
}
