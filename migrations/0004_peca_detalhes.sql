-- Detalhes da peça: custo, qualidade, segurança, embalagem (frete do ML), vídeo,
-- data da etiqueta e status do anúncio no Mercado Livre.
-- O sistema já cria essas colunas sozinho na primeira vez que lista/salva peças;
-- este arquivo serve só para quem preferir aplicar à mão:
--   npx wrangler d1 execute rafa-desmanche --remote --file migrations/0004_peca_detalhes.sql
ALTER TABLE pecas ADD COLUMN custo REAL;
ALTER TABLE pecas ADD COLUMN qualidade TEXT;
ALTER TABLE pecas ADD COLUMN seguranca INTEGER DEFAULT 0;
ALTER TABLE pecas ADD COLUMN rastreavel INTEGER DEFAULT 0;
ALTER TABLE pecas ADD COLUMN peso_g INTEGER;
ALTER TABLE pecas ADD COLUMN alt_cm REAL;
ALTER TABLE pecas ADD COLUMN larg_cm REAL;
ALTER TABLE pecas ADD COLUMN comp_cm REAL;
ALTER TABLE pecas ADD COLUMN video TEXT;
ALTER TABLE pecas ADD COLUMN etq_em INTEGER;
ALTER TABLE pecas ADD COLUMN ml_status TEXT;
