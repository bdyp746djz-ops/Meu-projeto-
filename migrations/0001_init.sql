-- Rafa Busca Peças — esquema inicial (Cloudflare D1 / SQLite)
-- Etapa 1: usuários, localizações, peças, vendas. + base de compatibilidades (Etapa 2).

CREATE TABLE IF NOT EXISTS usuarios (
  id         TEXT PRIMARY KEY,
  nome       TEXT NOT NULL,
  login      TEXT UNIQUE NOT NULL,
  senha_hash TEXT NOT NULL,
  salt       TEXT NOT NULL,
  papel      TEXT NOT NULL DEFAULT 'atendente',   -- 'admin' | 'atendente'
  criado_em  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS locais (
  id         TEXT PRIMARY KEY,
  nome       TEXT NOT NULL,
  pai        TEXT,                                 -- id do local pai; NULL = raiz
  capacidade INTEGER,                              -- quantas peças cabem (NULL = sem limite)
  sigla      TEXT,                                 -- sigla curta na etiqueta (ex.: 17E, CX1); vazio = automática
  regras     TEXT,                                 -- palavras p/ localização automática (ex.: farol, lanterna)
  criado_em  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_locais_pai ON locais(pai);

CREATE TABLE IF NOT EXISTS pecas (
  id            TEXT PRIMARY KEY,
  codigo        INTEGER NOT NULL,                  -- código interno sequencial (#000691)
  nome          TEXT NOT NULL,
  marca         TEXT,
  modelo        TEXT,
  ano           TEXT,
  pn            TEXT,                              -- part number / código original
  cond          TEXT,                             -- condição
  veiculo       TEXT,                             -- sucata de origem
  preco         REAL NOT NULL DEFAULT 0,
  qtd           INTEGER NOT NULL DEFAULT 0,
  local_id      TEXT,
  obs           TEXT,
  busca         TEXT,                             -- texto normalizado (minúsculo, sem acento) p/ busca
  fotos         TEXT,                             -- JSON: array de chaves no R2
  ml            INTEGER NOT NULL DEFAULT 0,        -- anunciada no Mercado Livre? 0/1
  ml_id         TEXT,                             -- id do anúncio no ML (Etapa 2)
  ml_link       TEXT,
  olx           INTEGER NOT NULL DEFAULT 0,
  olx_link      TEXT,
  criado_em     INTEGER NOT NULL,
  atualizado_em INTEGER,
  criado_por    TEXT,                             -- id do usuário que cadastrou
  custo         REAL,                             -- quanto pagou (opcional)
  qualidade     TEXT,                             -- A / B / C
  seguranca     INTEGER DEFAULT 0,                -- item de segurança (airbag, freio...)
  rastreavel    INTEGER DEFAULT 0,
  peso_g        INTEGER,                          -- embalagem (frete do ML)
  alt_cm        REAL,
  larg_cm       REAL,
  comp_cm       REAL,
  video         TEXT,                             -- link do YouTube
  etq_em        INTEGER,                          -- quando a etiqueta foi impressa
  ml_status     TEXT,                             -- status do anúncio no ML
  ml_em         INTEGER,                          -- quando foi publicada no ML
  ml_cat        TEXT,                             -- categoria do ML escolhida no cadastro
  ml_cat_nome   TEXT
);
CREATE INDEX IF NOT EXISTS idx_pecas_codigo ON pecas(codigo);
CREATE INDEX IF NOT EXISTS idx_pecas_pn     ON pecas(pn);
CREATE INDEX IF NOT EXISTS idx_pecas_local  ON pecas(local_id);

CREATE TABLE IF NOT EXISTS vendas (
  id        TEXT PRIMARY KEY,
  peca_id   TEXT,
  nome      TEXT,
  codigo    INTEGER,
  qtd       INTEGER NOT NULL,
  unit      REAL NOT NULL,
  total     REAL NOT NULL,
  canal     TEXT,
  cliente   TEXT,
  pagamento TEXT,
  local_path TEXT,
  cancelada INTEGER NOT NULL DEFAULT 0,
  data      INTEGER NOT NULL,
  ml_pedido TEXT                                 -- nº do pedido no Mercado Livre (baixa pela expedição)
);
CREATE INDEX IF NOT EXISTS idx_vendas_data ON vendas(data);

-- Histórico de movimentação de peças entre locais (quem moveu, de onde, para onde).
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

-- Base própria de compatibilidades por part number (alimenta a Etapa 2 / Mercado Livre).
CREATE TABLE IF NOT EXISTS compat_base (
  pn        TEXT NOT NULL,
  veiculo   TEXT NOT NULL,                        -- descrição do carro compatível
  origem    TEXT NOT NULL DEFAULT 'manual',       -- 'manual' | 'import' | 'ml'
  criado_em INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_compat_pn ON compat_base(pn);
