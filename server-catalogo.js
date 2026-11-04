// Servidor local para testar integração com o catálogo de peças
import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import { join } from 'path';
import { buscarPorOEM, buscarPorID, autocompletar } from './src/catalogo.js';

const app = express();
const PORT = 3001;
let dbCatalogo;

app.use(cors());
app.use(express.json());

// GET /api/catalogo/buscar?q=termo&limit=20
app.get('/api/catalogo/buscar', async (req, res) => {
  const termo = String(req.query.q || '').trim();
  if (termo.length < 2) return res.status(400).json({ erro: 'Digite ao menos 2 caracteres para buscar' });

  const limite = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const termos = termo.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/\s+/).filter(Boolean);
  if (!termos.length) return res.status(400).json({ erro: 'Digite palavras ou um código OEM para buscar' });

  try {
    if (!dbCatalogo) dbCatalogo = new Database(join(process.cwd(), 'pecas_full_completo.db'), { readonly: true, fileMustExist: true });

    const exatos = dbCatalogo.prepare(`
      SELECT * FROM pecas
      WHERE LOWER(TRIM(code)) = ?
      LIMIT ?
    `).all(termo.toLowerCase(), limite);

    const campos = ['name', 'marketplace_name', 'code', 'brand', 'vehicle_model', 'category', 'description'];
    const where = termos.map(() => `(${campos.map(c => `LOWER(${c}) LIKE ?`).join(' OR ')})`).join(' AND ');
    const valores = termos.flatMap(t => campos.map(() => `%${t}%`));
    const resultados = exatos.length ? exatos : dbCatalogo.prepare(`
      SELECT * FROM pecas
      WHERE ${where}
      ORDER BY id DESC
      LIMIT ?
    `).all(...valores, limite);

    const pecas = resultados.map(p => {
      let fotos = [];
      try { if (p.photos) fotos = JSON.parse(p.photos); } catch (error) { console.error('Erro ao ler fotos do catálogo:', error); }
      const ano = `${p.vehicle_model || ''} ${p.name || ''}`.match(/\b(?:19|20)\d{2}(?:\s*(?:\/|-|a)\s*(?:(?:19|20)?\d{2}))?\b/i);
      return {
        id: p.id, nome: p.name, nome_marketplace: p.marketplace_name, codigo: p.code,
        marca: p.brand, modelo: p.vehicle_model, ano: ano ? ano[0] : '',
        categoria: p.category, foto: p.photo, fotos,
        descricao: p.description ? p.description.substring(0, 200) : ''
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

app.listen(PORT, () => {
  console.log(`\n🚀 Servidor de catálogo rodando em http://localhost:${PORT}`);
  console.log('\n📋 Rotas disponíveis:');
  console.log(`  GET http://localhost:${PORT}/api/catalogo/buscar?q=fechadura`);
  console.log(`  GET http://localhost:${PORT}/api/catalogo/oem/5pinos`);
  console.log(`  GET http://localhost:${PORT}/api/catalogo/autocompletar?q=gol\n`);
});
