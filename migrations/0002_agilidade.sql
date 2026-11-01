-- Atualização: completa o banco com o que as funções de agilidade precisam.
-- Use SÓ para atualizar um banco criado ANTES dessas funções (como o primeiro deploy).
-- Num banco novo (criado pelo 0001 mais recente) isto não é necessário.

-- quem cadastrou a peça (produtividade por funcionário)
ALTER TABLE pecas ADD COLUMN criado_por TEXT;

-- histórico de movimentação de peças entre locais (mover/conferir com o leitor)
CREATE TABLE IF NOT EXISTS movimentacoes (
  id           TEXT PRIMARY KEY,
  peca_id      TEXT,
  codigo       INTEGER,
  nome         TEXT,
  de_local     TEXT,
  para_local   TEXT,
  usuario_id   TEXT,
  usuario_nome TEXT,
  data         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mov_data ON movimentacoes(data);
