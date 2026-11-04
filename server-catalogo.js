// Servidor local para testar integração com o catálogo de peças
import express from 'express';
import cors from 'cors';
import { buscarPecas, buscarPorOEM, buscarPorID, autocompletar } from './src/catalogo.js';

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// GET /api/catalogo/buscar?q=termo&limit=20
app.get('/api/catalogo/buscar', async (req, res) => {
  const mockReq = { url: `http://localhost:3001${req.url}` };
  const resultado = await buscarPecas(mockReq);
  res.json(resultado);
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
