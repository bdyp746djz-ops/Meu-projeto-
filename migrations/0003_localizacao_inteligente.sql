-- Localização inteligente: sigla curta (etiqueta da caixa) e regras por palavra.
-- O sistema já cria essas colunas sozinho na primeira vez que abre Localizações;
-- este arquivo serve só para quem preferir aplicar à mão:
--   npx wrangler d1 execute rafa-desmanche --remote --file migrations/0003_localizacao_inteligente.sql
ALTER TABLE locais ADD COLUMN sigla TEXT;
ALTER TABLE locais ADD COLUMN regras TEXT;
