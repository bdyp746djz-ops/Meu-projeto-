import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dbPath = join(__dirname, '..', 'pecas_full_completo.db');

console.log('🔍 INICIANDO INSPEÇÃO DO BANCO DE DADOS\n');
console.log(`📁 Arquivo: ${dbPath}\n`);

try {
  // Abre o banco de dados em modo somente leitura
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  // 1. Lista todas as tabelas
  console.log('=' .repeat(80));
  console.log('📊 TABELAS ENCONTRADAS NO BANCO DE DADOS');
  console.log('='.repeat(80));

  const tables = db.prepare(`
    SELECT name 
    FROM sqlite_master 
    WHERE type='table' 
    ORDER BY name
  `).all();

  console.log(`\n✅ Total de tabelas: ${tables.length}\n`);

  const inspection = [];

  // 2. Para cada tabela, inspeciona estrutura e dados
  for (const table of tables) {
    const tableName = table.name;
    console.log('\n' + '─'.repeat(80));
    console.log(`📋 TABELA: ${tableName}`);
    console.log('─'.repeat(80));

    // Obtém informações das colunas
    const columns = db.pragma(`table_info(${tableName})`);
    
    console.log('\n🔹 COLUNAS:');
    console.log('─'.repeat(80));
    columns.forEach((col, idx) => {
      console.log(`  ${idx + 1}. ${col.name.padEnd(30)} | Tipo: ${col.type.padEnd(15)} | PK: ${col.pk ? 'Sim' : 'Não'} | NOT NULL: ${col.notnull ? 'Sim' : 'Não'}`);
    });

    // Conta registros
    let count = 0;
    try {
      const countResult = db.prepare(`SELECT COUNT(*) as total FROM "${tableName}"`).get();
      count = countResult.total;
    } catch (e) {
      count = 0;
    }

    console.log(`\n📊 Total de registros: ${count.toLocaleString('pt-BR')}`);

    // Pega 5 exemplos
    console.log('\n📝 EXEMPLOS DE DADOS (até 5 registros):');
    console.log('─'.repeat(80));

    if (count > 0) {
      try {
        const samples = db.prepare(`SELECT * FROM "${tableName}" LIMIT 5`).all();
        samples.forEach((row, idx) => {
          console.log(`\n  Registro ${idx + 1}:`);
          Object.entries(row).forEach(([key, value]) => {
            let displayValue = value;
            if (typeof value === 'string' && value.length > 100) {
              displayValue = value.substring(0, 100) + '...';
            }
            console.log(`    ${key}: ${displayValue}`);
          });
        });
      } catch (e) {
        console.log(`    ⚠️ Erro ao ler exemplos: ${e.message}`);
      }
    }

    // Armazena informações para análise
    inspection.push({
      table: tableName,
      columns: columns.map(c => ({
        name: c.name,
        type: c.type,
        pk: c.pk === 1,
        notnull: c.notnull === 1
      })),
      count: count
    });
  }

  // 3. Análise inteligente - identifica campos relevantes
  console.log('\n\n' + '='.repeat(80));
  console.log('🔍 ANÁLISE INTELIGENTE - MAPEAMENTO DE CAMPOS RELEVANTES');
  console.log('='.repeat(80));

  const keywords = {
    oem: ['oem', 'part_number', 'partnumber', 'codigo', 'code', 'referencia', 'ref'],
    nome: ['nome', 'name', 'titulo', 'title', 'descricao', 'description', 'peca'],
    foto: ['foto', 'photo', 'image', 'imagem', 'img', 'picture', 'url_foto'],
    marca: ['marca', 'brand', 'fabricante', 'manufacturer'],
    modelo: ['modelo', 'model', 'veiculo', 'vehicle', 'carro', 'car'],
    ano: ['ano', 'year', 'data', 'date'],
    preco: ['preco', 'price', 'valor', 'value', 'custo', 'cost']
  };

  inspection.forEach(({ table, columns, count }) => {
    console.log(`\n📋 Tabela: ${table} (${count.toLocaleString('pt-BR')} registros)`);
    
    Object.entries(keywords).forEach(([category, keys]) => {
      const found = columns.filter(col => 
        keys.some(key => col.name.toLowerCase().includes(key))
      );
      if (found.length > 0) {
        console.log(`  ✅ ${category.toUpperCase()}: ${found.map(c => c.name).join(', ')}`);
      }
    });
  });

  // 4. Sugestão de estrutura para API
  console.log('\n\n' + '='.repeat(80));
  console.log('🚀 SUGESTÕES PARA INTEGRAÇÃO NO SISTEMA');
  console.log('='.repeat(80));

  console.log('\n📌 Rotas de API sugeridas:');
  console.log('  GET /api/catalogo/buscar?q=:termo');
  console.log('  GET /api/catalogo/oem/:codigo');
  console.log('  GET /api/catalogo/veiculo/:marca/:modelo/:ano');
  console.log('  GET /api/catalogo/compatibilidade/:oem');

  console.log('\n📌 Tabelas principais identificadas:');
  const mainTables = inspection.filter(t => t.count > 1000);
  mainTables.forEach(t => {
    console.log(`  • ${t.table}: ${t.count.toLocaleString('pt-BR')} registros`);
  });

  db.close();
  console.log('\n\n✅ INSPEÇÃO CONCLUÍDA COM SUCESSO!\n');

} catch (error) {
  console.error('❌ ERRO AO INSPECIONAR BANCO DE DADOS:', error);
  process.exit(1);
}
