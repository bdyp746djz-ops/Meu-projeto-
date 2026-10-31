// Sugere preço comparando SÓ peças equivalentes e inteiras.
// Recebe os anúncios concorrentes e devolve min/mediana/máx do conjunto limpo,
// mais a lista do que foi descartado e por quê (pra você conferir).
//
// A busca no Mercado Livre (pelo part number) alimenta esta função; aqui fica
// o "filtro" que separa o que presta do que é peça quebrada, errada ou golpe.

const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const soPn = s => norm(s).replace(/[^a-z0-9]/g, '');

// Sinais, no texto do anúncio, de peça avariada ou vendida "no estado".
export const TERMOS_AVARIA = [
  'no estado', 'retirada de peca', 'quebrad', 'trincad', 'rachad', 'com avaria',
  'avariad', 'danificad', 'so a carcaca', 'somente a carcaca', 'nao funciona',
  'nao liga', 'com defeito', 'defeituos', 'sucata', 'para conserto', 'para projeto',
  'incomplet', 'faltando peca', 'leia o anuncio', 'leia a descri', 'nao testad', 'sem teste',
];

export function termoAvaria(texto) {
  const t = norm(texto);
  return TERMOS_AVARIA.find(k => t.includes(k)) || null;
}

function mediana(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// peca     = { condicao, pn }
// anuncios = [{ id, titulo, descricao, preco, condicao, pn, link }]
// opts.pisoRatio: descarta preço abaixo de pisoRatio × mediana (padrão 0.5)
// opts.exigirPn: só compara quando o part number confere (padrão false)
export function sugerirPreco(peca, anuncios, opts = {}) {
  const pisoRatio = opts.pisoRatio ?? 0.5;
  const meuPn = soPn(peca.pn);
  const descartados = [];
  const candidatos = [];

  for (const a of anuncios) {
    const preco = Number(a.preco) || 0;
    if (preco <= 0) { descartados.push({ anuncio: a, motivo: 'sem preço' }); continue; }
    if (peca.condicao && a.condicao && norm(a.condicao) !== norm(peca.condicao)) {
      descartados.push({ anuncio: a, motivo: `condição diferente (${a.condicao})` }); continue;
    }
    const avaria = termoAvaria(`${a.titulo} ${a.descricao || ''}`);
    if (avaria) { descartados.push({ anuncio: a, motivo: `parece avariado ("${avaria}")` }); continue; }
    const pnBate = !!(meuPn && soPn(a.pn) && soPn(a.pn) === meuPn);
    if (opts.exigirPn && !pnBate) { descartados.push({ anuncio: a, motivo: 'part number não confere' }); continue; }
    candidatos.push({ ...a, preco, pnBate });
  }

  // Outliers baixos: abaixo de pisoRatio × mediana dos candidatos (peça quebrada/errada/golpe).
  const medBase = mediana(candidatos.map(c => c.preco));
  const piso = medBase * pisoRatio;
  const usados = [];
  for (const c of candidatos) {
    if (medBase && c.preco < piso) {
      descartados.push({ anuncio: c, motivo: `preço fora da curva (abaixo de R$ ${piso.toFixed(0)})` });
    } else usados.push(c);
  }

  const precos = usados.map(c => c.preco);
  const temPnConfirmado = usados.some(c => c.pnBate);
  return {
    sugerido: precos.length ? { min: Math.min(...precos), mediana: mediana(precos), max: Math.max(...precos) } : null,
    usados,
    descartados,
    confianca: !precos.length ? 'nenhum comparável'
      : precos.length < 3 ? 'baixa (poucos anúncios)'
      : !temPnConfirmado ? 'média (part number não confirmado)'
      : 'boa',
  };
}
