-- Vídeos gerados com IA no PC do usuário (fila de pedidos).
-- O sistema já cria esta tabela sozinho na primeira vez; este arquivo é só para quem preferir aplicar à mão:
--   npx wrangler d1 execute rafa-desmanche --remote --file migrations/0005_videos.sql
CREATE TABLE IF NOT EXISTS videos (
  id            TEXT PRIMARY KEY,
  peca_id       TEXT NOT NULL,
  status        TEXT NOT NULL,          -- fila | gerando | pronto | erro
  prompt        TEXT,
  foto_key      TEXT,                   -- foto usada (a 1ª, de fundo branco)
  video_key     TEXT,                   -- MP4 no R2 (videos/...)
  erro          TEXT,
  progresso     TEXT,
  modelo        TEXT,                   -- wan | ltx
  criado_em     INTEGER NOT NULL,
  atualizado_em INTEGER
);
CREATE INDEX IF NOT EXISTS idx_videos_peca ON videos(peca_id);
