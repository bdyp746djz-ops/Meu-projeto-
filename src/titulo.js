// Monta o título do anúncio sempre no mesmo padrão:
//   Nome da peça · Part number · Carro · Motor · Ano · Modelo · Combustível
// Ex.: "Caixa Filtro Ar 7560918 BMW 120i 2.0 2008/11 E87 Gasolina"
//
// O Mercado Livre aceita no máximo 60 caracteres. Quando passa disso, o título
// é encurtado em etapas, sempre preservando nome, part number e carro.

export const LIMITE = 60;

export const ORDEM = ['nome', 'pn', 'carro', 'motor', 'ano', 'modelo', 'combustivel'];

const COMBUSTIVEL = {
  flex: ['Flex', 'Flex'],
  gasolina: ['Gasolina', 'Gas'],
  diesel: ['Diesel', 'Diesel'],
  alcool: ['Álcool', 'Álcool'],
  'álcool': ['Álcool', 'Álcool'],
  etanol: ['Etanol', 'Etanol'],
  hibrido: ['Híbrido', 'Híbrido'],
  'híbrido': ['Híbrido', 'Híbrido'],
  eletrico: ['Elétrico', 'Elétrico'],
  'elétrico': ['Elétrico', 'Elétrico'],
};

// Palavras que ficam sempre em maiúsculas.
const SIGLAS = new Set(['BMW', 'VW', 'GM', 'KIA', 'BYD', 'JAC', 'GWM', 'RAM', 'MINI', 'DS',
  'ABS', 'ECU', 'TPMS', 'LED', 'GNV', 'TSI', 'TFSI', 'THP', 'MPI', 'GDI', 'TDI', 'CVT', 'AT', 'MT',
  'GT', 'GTI', 'GTS', 'RS', 'SW', 'CD', 'LX', 'EX', 'EXL', 'LT', 'LTZ', 'SE', 'XEI', 'GLI', 'SUV', 'HB20']);
// Palavras pequenas que ficam em minúsculas no meio do nome.
const MINUSCULAS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'com', 'sem', 'para', 'p/']);

const limpa = s => String(s ?? '').replace(/\s+/g, ' ').trim();

// "CAIXA DE FUSIVEL do motor" -> "Caixa de Fusivel do Motor".
// Palavras com número: começando por letra viram maiúsculas (e87 -> E87);
// começando por número ficam como digitadas (120i, 1.6).
export function capitaliza(texto) {
  return limpa(texto).split(' ').map((p, i) => {
    if (!p) return p;
    if (/\d/.test(p)) return /^\d/.test(p) ? p : p.toUpperCase();
    const up = p.toUpperCase();
    if (SIGLAS.has(up)) return up;
    const low = p.toLowerCase();
    if (i > 0 && MINUSCULAS.has(low)) return low;
    return low.charAt(0).toUpperCase() + low.slice(1);
  }).join(' ');
}

// Motor: "2.0", "1.6 16v", "2,0" -> "2.0", "1.6 16V"
function formataMotor(m) {
  return limpa(m).replace(/(\d),(\d)/g, '$1.$2').replace(/(\d+)v\b/gi, '$1V');
}

// Ano: aceita "2008/2011", "2008-2011", "2008 a 2011", "08/11", "2012".
// nivel 0 = "2008/2011", 1 = "2008/11", 2 = "08/11"
function formataAno(a, nivel = 0) {
  const nums = (limpa(a).match(/\d{2,4}/g) || []).map(n => n.length === 2 ? (Number(n) > 50 ? '19' : '20') + n : n);
  if (!nums.length) return limpa(a);
  const [ini, fim] = [nums[0], nums[nums.length - 1]];
  if (ini === fim) return nivel >= 2 ? ini.slice(2) : ini;
  if (nivel === 0) return `${ini}/${fim}`;
  if (nivel === 1) return `${ini}/${fim.slice(2)}`;
  return `${ini.slice(2)}/${fim.slice(2)}`;
}

function formataCombustivel(c, curto = false) {
  const k = limpa(c).toLowerCase();
  const v = COMBUSTIVEL[k];
  return v ? v[curto ? 1 : 0] : capitaliza(c);
}

// peca = { nome, pn, carro, motor, ano, modelo, combustivel }
// Retorna { titulo, tamanho, cortes } — "cortes" lista o que foi encurtado/removido.
export function montarTitulo(peca, limite = LIMITE) {
  const campos = {
    nome: capitaliza(peca.nome),
    pn: limpa(peca.pn).toUpperCase(),
    carro: capitaliza(peca.carro),
    motor: formataMotor(peca.motor),
    ano: formataAno(peca.ano, 0),
    modelo: capitaliza(peca.modelo),
    combustivel: peca.combustivel ? formataCombustivel(peca.combustivel) : '',
  };

  const junta = () => limpa(ORDEM.map(k => campos[k]).filter(Boolean).join(' '));

  // Etapas para caber no limite, da menos para a mais drástica.
  const etapas = [
    ['ano encurtado', () => { campos.ano = formataAno(peca.ano, 1); }],
    ['combustível abreviado', () => { if (campos.combustivel) campos.combustivel = formataCombustivel(peca.combustivel, true); }],
    ['ano curto', () => { campos.ano = formataAno(peca.ano, 2); }],
    ['sem combustível', () => { campos.combustivel = ''; }],
    ['sem modelo', () => { campos.modelo = ''; }],
    ['sem motor', () => { campos.motor = ''; }],
    ['sem ano', () => { campos.ano = ''; }],
  ];

  const cortes = [];
  let titulo = junta();
  for (const [nome, aplica] of etapas) {
    if (titulo.length <= limite) break;
    const antes = titulo;
    aplica();
    titulo = junta();
    if (titulo !== antes) cortes.push(nome);
  }
  // Último recurso: corta o nome da peça por palavra, mantendo part number e carro.
  if (titulo.length > limite && campos.nome) {
    const resto = limpa([campos.pn, campos.carro].filter(Boolean).join(' '));
    const espaco = limite - resto.length - 1;
    let nome = campos.nome;
    while (nome.length > espaco && nome.includes(' ')) nome = nome.replace(/\s+\S+$/, '');
    // não termina em "de", "do", "com"...
    while (nome.includes(' ') && MINUSCULAS.has(nome.split(' ').pop().toLowerCase())) nome = nome.replace(/\s+\S+$/, '');
    if (nome.length > espaco) nome = nome.slice(0, Math.max(0, espaco));
    campos.nome = nome;
    titulo = junta();
    cortes.push('nome encurtado');
  }
  if (titulo.length > limite) titulo = titulo.slice(0, limite).trim();

  return { titulo, tamanho: titulo.length, cortes };
}
