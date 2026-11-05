// Apoio dos testes de imagens: imagens reais geradas em memória e um ambiente com origens simuladas.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { criarServicoImagens } from '../src/catalogo-imagens.js';

function chunk(tipo, dados) {
  const t = Buffer.from(tipo, 'latin1'), len = Buffer.alloc(4), crc = Buffer.alloc(4);
  len.writeUInt32BE(dados.length); crc.writeUInt32BE(crc32(Buffer.concat([t, dados])) >>> 0);
  return Buffer.concat([len, t, dados, crc]);
}
// PNG válido e decodificável
export function png(w = 8, h = 6, cor = [200, 30, 30]) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const linha = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => cor).flat())]);
  const bruto = Buffer.concat(Array.from({ length: h }, () => linha));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(bruto)), chunk('IEND', Buffer.alloc(0))]);
}
// cabeçalho JPEG válido até o SOF0
export function jpegMinimo(w = 16, h = 12) {
  const sof = Buffer.from([0xFF, 0xC0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xFF, 0xD8]), sof, Buffer.from([0xFF, 0xD9])]);
}

export const silencio = { error() {}, log() {} };
export const BASE = 'http://localhost:3001';
const resp = (corpo, status = 200, tipo = 'image/png', extra = {}) => new Response(corpo, { status, headers: { 'content-type': tipo, ...extra } });

// catálogo do ML simulado: OEM normalizado → produto
export const ML = {
  '373002b510': { id: 'MLB1', nome: 'Alternador Hyundai Hb20 Hatch 1.6 2018', pn: '373002B510', fotos: 4 },
  '2614291': { id: 'MLB2', nome: 'Alternador Hyundai Hb20 1.0 3 Cilindros', pn: '2614291', fotos: 1 },
  '373002b910': { id: 'MLB9', nome: 'Alternador Hyundai Creta', pn: '37300-03800', fotos: 3 },     // PART_NUMBER diferente
  '9999900001': { id: 'MLB8', nome: 'Lupa com lente anti-deformação', pn: '9999900001', fotos: 2 }   // mesmo OEM, outra peça
};

export function ambiente({ estoque = [], hostOriginal = 'bloqueado' } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'cat-img-'));
  const locais = join(tmp, 'imagens-catalogo'); mkdirSync(locais);
  const chamadas = { total: 0, urls: [] };
  const fetchImpl = async (u, opts = {}) => {
    const url = new URL(String(u)); chamadas.total++; chamadas.urls.push(url.href);
    if (url.hostname === 'files.ibrsoftweb.com.br') {
      return hostOriginal === 'bloqueado' ? resp(null, 301, 'text/html', { location: 'https://ibr-api-prod.s3.amazonaws.com' + url.pathname }) : resp(png(10, 10));
    }
    if (url.hostname === 'ibr-api-prod.s3.amazonaws.com') return resp('<Error>AccessDenied</Error>', 403, 'application/xml');
    if (url.hostname === 'api.mercadolibre.com') {
      if (!/Bearer tk/.test((opts.headers || {}).Authorization || '')) return resp('{}', 401, 'application/json');
      if (url.pathname === '/products/search') {
        const q = (url.searchParams.get('q') || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const p = ML[q]; return resp(JSON.stringify({ results: p ? [{ id: p.id, name: p.nome }] : [] }), 200, 'application/json');
      }
      const m = url.pathname.match(/^\/products\/(MLB\d+)$/);
      if (m) {
        const p = Object.values(ML).find(x => x.id === m[1]);
        return resp(JSON.stringify({ id: p.id, name: p.nome, permalink: 'https://www.mercadolivre.com.br/p/' + p.id, attributes: [{ id: 'PART_NUMBER', value_name: p.pn }],
          pictures: Array.from({ length: p.fotos }, (_, i) => ({ url: `https://http2.mlstatic.com/D_NQ_NP_${p.id}_${i}-F.jpg` })) }), 200, 'application/json');
      }
    }
    if (/\.mlstatic\.com$/.test(url.hostname)) return resp(url.pathname.includes('quebrada') ? '<html>nao sou imagem</html>' : png(12, 9), 200, 'image/jpeg');
    if (url.hostname === 'rafa-busca-pecas.rafabuscapecas.workers.dev') return resp(png(20, 15), 200, 'image/webp');
    return resp('nada', 404, 'text/plain');
  };
  const svc = criarServicoImagens({
    baseDir: tmp, cacheDir: join(tmp, 'cache'), fetchImpl, localDirs: [locais], log: silencio,
    carregaEstoqueR2: async () => estoque, obterTokenML: async () => ({ valor: 'tk', exp: Infinity })
  });
  return { tmp, locais, svc, chamadas, limpa: () => rmSync(tmp, { recursive: true, force: true }) };
}
