# Contexto do projeto – Rafa Busca Peças

Resumo da conversa de 30/10/2026 no app do Claude, salvo aqui para não se perder entre sessões.

## Situação atual
- **iBR Desmonte** (desmonte.ibrsoftweb.com.br) – R$ 400/mês. Usado para: criar anúncios, gerenciar vendas, localizar peças, etiquetas de prateleira. Não emite NF nem faz registro no Detran.
  - Menu: Dashboard, QR Code, Cadastros (Sucatas, Peças, Grupo de Peças, Clientes, Localizações, Transportadoras, Vendedores, Fornecedores, Configuração Tributária), Estoque, Etiquetas, Integrações.
  - Localizações em árvore: RAFA › PRT-1 › NÍVEL-A/B › CAIXA-1…21.
  - Ao digitar o part number, preenche título, compatibilidades (vêm certas), foto e preço.
  - Dashboard tem botão "Exportar Excel" (verificar se exporta as peças).
- **DevZapp** (chat.devzapp.com.br) – R$ 180/mês. WhatsApp via QR code, filas, etiquetas, transcrição de áudio, disparo para grupos.
  - ~250 grupos que NÃO devem aparecer para a atendente.
  - Número da loja = número pessoal → ocultar contatos pessoais da atendente.
  - 1 atendente; ~376 atendimentos/mês.

## Já feito
- Protótipo (artifact "Meu Desmanche – Gestão de Peças", slug `626ab988-ab63-48af-ab3d-7568d3078630`): painel, estoque com fotos e filtros, cadastro de peça (mantém dados da sucata), localizações em árvore com criação em lote, etiquetas QR (`P:000123` peça, `L:<id>` local, leitor USB), vendas (baixa/cancela estoque), gerador de anúncio (título ≤ 60) e marcação ML/OLX.

## Plano

### Frente 1 – Sistema do desmanche (economiza R$ 400/mês) — prioridade
- Hospedagem: **Cloudflare grátis** – Workers + D1 (banco) + R2 (fotos). Não usar Vercel Hobby (proíbe uso comercial).
- **Etapa 1:** estoque, localização, etiquetas, vendas, login com senha, backup automático.
- **Etapa 2:** API oficial do Mercado Livre (OAuth): publicar/editar/pausar/reativar; tirar do ar ao vender no balcão; baixar estoque ao vender no ML; part number → título, categoria (preditor), compatibilidades (catálogo ML + carro da sucata sempre incluído, revisão manual) e preço sugerido (mín/médio/máx). Não copiar fotos de terceiros.
  - Antes: comparar 5–10 peças (compatibilidades iBR × ML). Se ML for pior, avaliar base paga (TecDoc).
- **Etapa 3:** OLX (acesso de parceiro), controle de sucatas, financeiro.
- Migração via exportação do iBR; usar em paralelo antes de cancelar.
- Aviso: Lei do Desmanche (12.977/2014) – confirmar obrigação de registro no Detran com o contador.

### Frente 2 – WhatsApp (substituir DevZapp)
- API oficial da Meta descartada (custo por mensagem com esse volume).
- **Evolution API + Chatwoot**, self-hosted, ignorando grupos e contatos pessoais (confirmar se `ignoreJids` aceita números individuais).
- Hospedagem: **Oracle Cloud Always Free** (ARM, Home Region Brazil East – São Paulo). Plano B: VPS no Brasil ~R$ 65/mês.
- Risco: conexão por QR vai contra os termos do WhatsApp (mesmo risco da DevZapp hoje).
- Rodar em paralelo com a DevZapp.

## Melhorias escolhidas (pesquisa em sistemas de fora)
- Etapa 1: inventário com leitor QR (conferir caixa), sugestão de baixar preço de peças paradas.
- Etapa 2: anunciar em vários canais (ML, OLX, Facebook – a confirmar), publicação em lote, pedidos em espera/alertas, revisão de compatibilidades.
- Depois: leitura de chassi por foto, vitrine própria para WhatsApp/grupos.

## Fora do escopo (decisão do usuário)
- Lucro por sucata
- Ordem de desmontagem
- Nota fiscal
- Registro no Detran

## Pendências
- [ ] Conta no GitHub (✅ existe – este repositório)
- [ ] Conta na Cloudflare
- [ ] Conta de desenvolvedor no Mercado Livre + registro do app
- [ ] Verificar se o iBR exporta peças em Excel/CSV
- [ ] Prints de 5–10 peças do iBR (part number, título, descrição, compatibilidades)
- [ ] Conta na Oracle Cloud (onde a conversa parou)

## Padrão de título (src/titulo.js)
Ordem fixa: **Nome da peça · Part number · Carro · Motor · Ano · Modelo · Combustível** (máx. 60 caracteres).
Se passar de 60, encurta nesta ordem: ano 2008/11 → combustível abreviado → ano 08/11 → tira combustível → tira modelo → tira motor → tira ano → corta o nome por palavra. Nome, part number e carro são sempre mantidos.
