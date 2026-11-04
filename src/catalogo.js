// CATÁLOGO DE AUTOPEÇAS - Integração com pecas_full_completo.db
// 2.100.584 peças indexadas

import Database from 'better-sqlite3';
import { join } from 'path';

let db = null;

// Inicializa conexão com o banco de dados
function initDB() {
  if (!db) {
    try {
      const dbPath = join(process.cwd(), 'pecas_full_completo.db');
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      console.log('✅ Banco de dados de catálogo conectado');
    } catch (error) {
      console.error('❌ Erro ao conectar banco de catálogo:', error);
      return null;
    }
  }
  return db;
}

// Normaliza texto para busca (remove acentos e converte para minúsculas)
const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// GET /api/catalogo/buscar?q=termo&limit=20
export async function buscarPecas(req) {
  const db = initDB();
  if (!db) return { erro: 'Banco de dados não disponível' };

  const url = new URL(req.url);
  const termo = url.searchParams.get('q') || '';
  const limit = parseInt(url.searchParams.get('limit') || '20');

  if (termo.length < 2) {
    return { erro: 'Digite ao menos 2 caracteres para buscar' };
  }

  try {
    const termoNorm = norm(termo);
    const results = db.prepare(`
      SELECT id, name, marketplace_name, code, brand, vehicle_model, category, 
             price, marketplace_price, stock_qty, available_qty, photo, photos,
             compat_count, location, description
      FROM pecas
      WHERE LOWER(name) LIKE ? OR LOWER(code) LIKE ? OR LOWER(brand) LIKE ?
         OR LOWER(category) LIKE ? OR LOWER(description) LIKE ?
      LIMIT ?
    `).all(`%${termoNorm}%`, `%${termoNorm}%`, `%${termoNorm}%`, `%${termoNorm}%`, `%${termoNorm}%`, limit);

    return {
      sucesso: true,
      total: results.length,
      termo: termo,
      pecas: results.map(p => formatarPeca(p))
    };
  } catch (error) {
    return { erro: 'Erro ao buscar peças: ' + error.message };
  }
}


// GET /api/catalogo/oem/:codigo
export async function buscarPorOEM(codigo) {
  const db = initDB();
  if (!db) return { erro: 'Banco de dados não disponível' };
  if (!codigo || codigo.length < 2) return { erro: 'Código OEM inválido' };

  try {
    const codigoNorm = norm(codigo);
    const results = db.prepare(`SELECT * FROM pecas WHERE LOWER(code) LIKE ? LIMIT 10`).all(`%${codigoNorm}%`);
    if (results.length === 0) return { sucesso: false, encontrado: false, mensagem: 'Nenhuma peça encontrada' };
    return { sucesso: true, encontrado: true, total: results.length, pecas: results.map(p => formatarPeca(p)) };
  } catch (error) {
    return { erro: 'Erro: ' + error.message };
  }
}

// GET /api/catalogo/id/:id
export async function buscarPorID(id) {
  const db = initDB();
  if (!db) return { erro: 'Banco de dados não disponível' };
  try {
    const result = db.prepare(`SELECT * FROM pecas WHERE id = ? LIMIT 1`).get(id);
    if (!result) return { sucesso: false, encontrado: false };
    return { sucesso: true, encontrado: true, peca: formatarPecaCompleta(result) };
  } catch (error) {
    return { erro: 'Erro: ' + error.message };
  }
}

// GET /api/catalogo/autocompletar?q=termo
export async function autocompletar(req) {
  const db = initDB();
  if (!db) return { sugestoes: [] };
  const url = new URL(req.url);
  const termo = url.searchParams.get('q') || '';
  if (termo.length < 2) return { sugestoes: [] };
  try {
    const termoNorm = norm(termo);
    const results = db.prepare(`SELECT DISTINCT name, code, brand, category FROM pecas WHERE LOWER(name) LIKE ? OR LOWER(code) LIKE ? LIMIT 10`).all(`%${termoNorm}%`, `%${termoNorm}%`);
    return { sugestoes: results.map(r => ({ texto: r.name, codigo: r.code, marca: r.brand, categoria: r.category })) };
  } catch (error) {
    return { sugestoes: [] };
  }
}

// Funções de formatação
function formatarPeca(p) {
  let fotos = [];
  try { if (p.photos) fotos = JSON.parse(p.photos); } catch (e) {}
  return {
    id: p.id, nome: p.name, nome_marketplace: p.marketplace_name, codigo: p.code,
    marca: p.brand, modelo: p.vehicle_model, categoria: p.category,
    preco: parseFloat(p.price) || 0, preco_marketplace: parseFloat(p.marketplace_price) || 0,
    estoque: parseInt(p.stock_qty) || 0, disponivel: parseInt(p.available_qty) || 0,
    foto: p.photo, fotos: fotos, compatibilidades: parseInt(p.compat_count) || 0,
    localizacao: p.location, descricao: p.description ? p.description.substring(0, 200) : ''
  };
}

function formatarPecaCompleta(p) {
  let fotos = [];
  try { if (p.photos) fotos = JSON.parse(p.photos); } catch (e) {}
  return { ...formatarPeca(p), catalog_item_id: p.catalog_item_id, ncm: p.ncm, sku: p.sku,
    marca_id: p.brand_id, categoria_id: p.category_id, descricao_completa: p.description,
    dimensoes: { altura: parseFloat(p.pkg_h) || 0, largura: parseFloat(p.pkg_w) || 0,
      comprimento: parseFloat(p.pkg_l) || 0, peso: parseFloat(p.pkg_weight) || 0 },
    loja: { id: p.store_id, nome: p.store_name, endereco: p.store_addr },
    criado_em: p.created_at, atualizado_em: p.updated_at, url_publica: p.public_path, status_anuncio: p.listing_status
  };
}

export function fecharDB() { if (db) { db.close(); db = null; } }
