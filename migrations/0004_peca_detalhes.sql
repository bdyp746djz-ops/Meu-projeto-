-- Detalhes da peça: custo, qualidade, segurança, embalagem (frete do ML), vídeo,
-- data da etiqueta, status/data do anúncio no Mercado Livre e nº do pedido do ML na venda.
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
ALTER TABLE pecas ADD COLUMN ml_em INTEGER;
ALTER TABLE vendas ADD COLUMN ml_pedido TEXT;
ALTER TABLE pecas ADD COLUMN ml_cat TEXT;
ALTER TABLE pecas ADD COLUMN ml_cat_nome TEXT;
