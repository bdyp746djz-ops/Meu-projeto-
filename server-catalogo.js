// Servidor local para testar integração com o catálogo de peças
import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import { join } from 'path';
import { buscarPorOEM, buscarPorID, autocompletar } from './src/catalogo.js';

const app = express();
const PORT = 3001;
const DB_PATH = join(process.cwd(), 'pecas_full_completo.db');
const MEDIA_BASE = 'https://files.ibrsoftweb.com.br/media/';
const MEDIA_HOST = 'files.ibrsoftweb.com.br';
const MEDIA_REDIRECT_HOST = 'ibr-api-prod.s3.amazonaws.com';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
let dbCatalogo;

app.use(cors());
app.use(express.json());

function normalizaFoto(valor) {
  if (valor && typeof valor === 'object') {
    return normalizaFoto(valor.thumbnailUrl || valor.thumbnail_url || valor.url || valor.path);
  }
  if (typeof valor !== 'string' || !valor.trim()) return null;
  const caminho = valor.trim();
  if (/^https?:\/\//i.test(caminho)) return caminho.replace(/^http:/i, 'https:');
  if (caminho.startsWith('//')) return 'https:' + caminho;
  if (/^data:image\//i.test(caminho)) return caminho;
  if (/^[a-z][a-z\d+.-]*:/i.test(caminho)) return null;
  return new URL(caminho.replace(/^\/+/, ''), MEDIA_BASE).href;
}

function fotosDoCatalogo(valor) {
  if (Array.isArray(valor)) return valor.map(normalizaFoto).filter(Boolean);
  if (typeof valor !== 'string' || !valor.trim()) return [];
  try {
    const parsed = JSON.parse(valor);
    if (Array.isArray(parsed)) return parsed.map(normalizaFoto).filter(Boolean);
    if (parsed && typeof parsed === 'object') return [normalizaFoto(parsed)].filter(Boolean);
  } catch (error) {
    if (valor.trim().startsWith('[') || valor.trim().startsWith('{')) {
      console.error('Erro ao interpretar fotos do catálogo:', error);
    }
  }
  return valor.split(',').map(normalizaFoto).filter(Boolean);
}

app.get('/api/catalogo/img', async (req, res) => {
  let url;
  try {
    url = new URL(String(req.query.url || ''));
  } catch {
    return res.status(400).json({ erro: 'URL de imagem inválida' });
  }
  if (url.protocol !== 'https:' || url.hostname !== MEDIA_HOST || !url.pathname.startsWith('/media/')) {
    return res.status(400).json({ erro: 'Origem de imagem não permitida' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const options = {
      headers: {
        accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.8',
        'user-agent': 'RafaBuscaPecas/1.0 (catalog image preview)'
      },
      redirect: 'manual',
      signal: controller.signal
    };
    let response = await fetch(url, options);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return res.status(502).json({ erro: 'Redirecionamento de imagem inválido' });
      const redirected = new URL(location, url);
      if (redirected.protocol !== 'https:' || redirected.hostname !== MEDIA_REDIRECT_HOST || !redirected.pathname.startsWith('/media/')) {
        return res.status(502).json({ erro: 'Redirecionamento de imagem não permitido' });
      }
      response = await fetch(redirected, options);
    }
    if (!response.ok) return res.status(response.status).end();

    const contentType = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (!['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
      return res.status(415).json({ erro: 'O servidor não retornou uma imagem compatível' });
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (contentLength > MAX_IMAGE_BYTES) return res.status(413).json({ erro: 'Imagem muito grande' });

    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > MAX_IMAGE_BYTES) {
        controller.abort();
        return res.status(413).json({ erro: 'Imagem muito grande' });
      }
      chunks.push(chunk);
    }
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(Buffer.concat(chunks, total));
  } catch (error) {
    if (error.name === 'AbortError') return res.status(504).json({ erro: 'Tempo esgotado ao carregar a imagem' });
    console.error('Erro ao carregar imagem do catálogo:', error);
    res.status(502).json({ erro: 'Não foi possível carregar a imagem do catálogo' });
  } finally {
    clearTimeout(timeout);
  }
});

// GET /api/catalogo/buscar?q=termo&limit=20
app.get('/api/catalogo/buscar', async (req, res) => {
  const termo = String(req.query.q || '').trim();
  if (termo.length < 2) return res.status(400).json({ erro: 'Digite ao menos 2 caracteres para buscar' });

  const limite = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const termos = termo.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/\s+/).filter(Boolean);
  if (!termos.length) return res.status(400).json({ erro: 'Digite palavras ou um código OEM para buscar' });

  try {
    const exatos = dbCatalogo.prepare(`
      SELECT id, name, marketplace_name, code, brand, vehicle_model, category, photo, photos
      FROM pecas
      WHERE TRIM(code) COLLATE NOCASE = ?
      LIMIT ?
    `).all(termo, limite);

    const campos = ['name', 'code', 'brand', 'vehicle_model'];
    const where = termos.map(() => `(${campos.map(c => `${c} LIKE ? COLLATE NOCASE`).join(' OR ')})`).join(' AND ');
    const valores = termos.flatMap(t => campos.map(() => `%${t}%`));
    const resultados = exatos.length ? exatos : dbCatalogo.prepare(`
      SELECT id, name, marketplace_name, code, brand, vehicle_model, category, photo, photos
      FROM pecas
      WHERE ${where}
      LIMIT ?
    `).all(...valores, limite);

    const pecas = resultados.map(p => {
      const fotos = fotosDoCatalogo(p.photos);
      const foto = fotosDoCatalogo(p.photo)[0] || fotos[0] || null;
      const ano = `${p.vehicle_model || ''} ${p.name || ''}`.match(/\b(?:19|20)\d{2}(?:\s*(?:\/|-|a)\s*(?:(?:19|20)?\d{2}))?\b/i);
      return {
        id: p.id, nome: p.name, nome_marketplace: p.marketplace_name, codigo: p.code,
        marca: p.brand, modelo: p.vehicle_model, ano: ano ? ano[0] : '',
        categoria: p.category, foto, fotos
      };
    });

    res.json({ sucesso: true, total: pecas.length, termo, pecas });
  } catch (error) {
    console.error('Erro ao buscar no catálogo local:', error);
    res.status(500).json({ erro: 'Erro ao buscar no catálogo: ' + error.message });
  }
});

// GET /api/catalogo/oem/:codigo
app.get('/api/catalogo/oem/:codigo', async (req, res) => {
  const resultado = await buscarPorOEM(req.params.codigo);
  res.json(resultado);
});

// GET /api/catalogo/id/:id
app.get('/api/catalogo/id/:id', async (req, res) => {
  const resultado = await buscarPorID(req.params.id);
  res.json(resultado);
});

// GET /api/catalogo/autocompletar?q=termo
app.get('/api/catalogo/autocompletar', async (req, res) => {
  const mockReq = { url: `http://localhost:3001${req.url}` };
  const resultado = await autocompletar(mockReq);
  res.json(resultado);
});

// Rota de teste
app.get('/', (req, res) => {
  res.json({
    sucesso: true,
    mensagem: 'Servidor de catálogo ativo',
    rotas: [
      'GET /api/catalogo/buscar?q=termo',
      'GET /api/catalogo/oem/:codigo',
      'GET /api/catalogo/id/:id',
      'GET /api/catalogo/autocompletar?q=termo'
    ]
  });
});

try {
  dbCatalogo = new Database(DB_PATH, { fileMustExist: true });
  dbCatalogo.exec(`
    CREATE INDEX IF NOT EXISTS idx_pecas_code ON pecas(code);
    CREATE INDEX IF NOT EXISTS idx_pecas_code_trimmed ON pecas(TRIM(code) COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_pecas_name ON pecas(name COLLATE NOCASE);
  `);
} catch (error) {
  console.error('Erro ao preparar os índices do catálogo local:', error);
  process.exitCode = 1;
}

if (dbCatalogo) app.listen(PORT, () => {
  console.log(`\n🚀 Servidor de catálogo rodando em http://localhost:${PORT}`);
  console.log('\n📋 Rotas disponíveis:');
  console.log(`  GET http://localhost:${PORT}/api/catalogo/buscar?q=fechadura`);
  console.log(`  GET http://localhost:${PORT}/api/catalogo/oem/5pinos`);
  console.log(`  GET http://localhost:${PORT}/api/catalogo/autocompletar?q=gol\n`);
});
