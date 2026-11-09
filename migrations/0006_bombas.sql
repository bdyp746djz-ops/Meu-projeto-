-- Bombas de alta: trocas do ML (base de troca) e compras de bombas estragadas.
-- O sistema já cria estas tabelas sozinho na primeira vez que abre as telas;
-- este arquivo serve só para quem preferir aplicar à mão:
--   npx wrangler d1 execute rafa-desmanche --remote --file migrations/0006_bombas.sql
CREATE TABLE IF NOT EXISTS trocas (
  id TEXT PRIMARY KEY, ml_pedido TEXT UNIQUE, data_venda INTEGER, comprador TEXT, titulo TEXT, valor REAL,
  envio_id TEXT, envio_status TEXT, entregue_em INTEGER,
  cliente TEXT, whatsapp TEXT, modelo INTEGER,
  status TEXT NOT NULL DEFAULT 'aguardando_entrega',   -- aguardando_entrega | falta_enviar | a_caminho | concluida | cancelada
  reversa_codigo TEXT, reversa_rastreio TEXT, postada_em INTEGER, recebida_em INTEGER,
  lembretes INTEGER NOT NULL DEFAULT 0, ultimo_lembrete INTEGER, aviso_troca INTEGER NOT NULL DEFAULT 0,
  obs TEXT, criado_em INTEGER NOT NULL, atualizado_em INTEGER);
CREATE TABLE IF NOT EXISTS compras (
  id TEXT PRIMARY KEY, nome TEXT, whatsapp TEXT, canal TEXT, origem TEXT, modelo INTEGER,
  status TEXT NOT NULL DEFAULT 'novo',                  -- novo | modelo_ok | dados_ok | nos_correios | etiqueta | a_caminho | recebida | recusada
  valor REAL NOT NULL DEFAULT 250,
  cpf TEXT, cep TEXT, endereco TEXT, pix TEXT, pago_em INTEGER,
  etiqueta_codigo TEXT, rastreio TEXT, recebida_em INTEGER,
  obs TEXT, criado_em INTEGER NOT NULL, atualizado_em INTEGER, criado_por TEXT);
