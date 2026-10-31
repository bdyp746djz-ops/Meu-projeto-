# Pesquisa de funcionalidades – sistemas de desmanche (Brasil e exterior)

Pesquisa feita em 31/10/2026. Foco: **postagem de anúncios**, **agilidade** e **organização de peças e etiquetas**.
Fora do escopo (a pedido): nota fiscal, Detran e cadastro de sucatas.

Sistemas analisados:
- **Brasil:** Drive Parts, VHD Sistema, Gestão Desmonte, Vaapt, iBR.
- **Exterior:** Checkmate/Car-Part (EUA), BreakerPRO (Reino Unido), Ovoko/RRR (Europa), Dismantly (EUA).
- **Integradores de Mercado Livre:** Magis5, Ideris, UpSeller.

> As informações vêm, em sua maioria, dos sites e materiais dos próprios fornecedores (marketing), não de testes.
> Os sites brasileiros não puderam ser abertos direto desta sessão (rede bloqueada); o conteúdo veio pelo buscador.

Legenda: ✅ já está no plano · 🆕 ideia nova · ⚠️ ponto de atenção

---

## ⚠️ Descoberta importante: mudança na API de compatibilidades do Mercado Livre

Desde **15/07/2026**, segundo a documentação oficial do ML:
- Para compatibilidades que vêm do **catálogo do ML**, a API só mostra um **resumo (marca e total)** e permite **aceitar ou recusar 100% das sugeridas**. Editar ou excluir uma por uma só pelo site do ML.
- O recurso de busca de veículos `POST /catalog_compatibilities/products_search/chunks` foi **descontinuado**.
- Compatibilidades informadas pelo **vendedor** (origem SELLER) continuam podendo ser enviadas pela API.
- Existem filtros para achar anúncios com **compatibilidades sugeridas pendentes** (`pending_compatibilities`) e **incompletas** (`incomplete_compatibilities`, que podem levar à moderação).

**Impacto no plano (Etapa 2):** "puxar as compatibilidades do ML pelo part number e marcar/desmarcar uma por uma" ficou limitado. Caminho ajustado:
1. **Base própria de compatibilidades:** cada peça cadastrada com part number e compatibilidades vira referência para as próximas com o mesmo número. Se a exportação do iBR trouxer as compatibilidades, elas alimentam essa base desde o primeiro dia.
2. Enviar ao ML as compatibilidades da base própria (origem SELLER).
3. Mostrar as sugestões do ML e deixar você aceitar todas ou nenhuma; ajuste fino pelo site do ML.
4. Testar tudo isso logo no início da Etapa 2, com as 5–10 peças de comparação.

Contexto: o iBR divulga um **catálogo próprio de compatibilidade com mais de 3 milhões de peças** — provavelmente é por isso que as compatibilidades dele vêm certas.

## ⚠️ Lição de um concorrente

Há reclamação pública (Reclame Aqui) de cliente do iBR sobre **peça vendida no ML que continuou disponível e foi vendida de novo**. No nosso sistema: baixa imediata pelo aviso de venda do ML (notificação), conferência periódica entre estoque e anúncios, e alerta se algo divergir.

---

## 1. Postagem de anúncios

| # | Funcionalidade | Onde existe | Situação |
|---|---|---|---|
| 1.1 | **Publicação em lote** (várias peças num clique) | iBR, Checkmate (Listing Manager), Ideris, UpSeller (até 300) | ✅ Etapa 2 |
| 1.2 | **Modelos de título e descrição** aplicados automaticamente | Checkmate (templates) | ✅ título pronto (`src/titulo.js`); 🆕 modelo de descrição |
| 1.3 | **Vendeu num canal, sai de todos** (inclusive venda no balcão) | VHD, Dismantly, BreakerPRO, iBR | ✅ Etapa 2 |
| 1.4 | **Preço, descrição e quantidade sincronizados** com o ML | Drive Parts, Gestão Desmonte | ✅ Etapa 2 |
| 1.5 | **Painel de pendências do ML**: compatibilidade pendente/incompleta e anúncios moderados | API oficial do ML (tags e moderações) | 🆕 evita anúncio pausado |
| 1.6 | **Perguntas do ML dentro do sistema**, com respostas prontas | UpSeller, Ideris | 🆕 a resposta pode puxar compatibilidade e estoque da peça |
| 1.7 | **Republicar anúncios parados** | Checkmate (relist, 2023) | 🆕 junto com "peças paradas" |
| 1.8 | **Preço para ganhar a vitrine** em peças **novas** de catálogo | API oficial do ML (`price_to_win`) | 🆕 só para peças novas |
| 1.9 | **Título e ficha técnica por IA** | VHD | ✅ título; 🆕 preencher ficha técnica (ficha completa melhora a posição no ML) |
| 1.10 | **Vídeo anexado ao anúncio** | BreakerPRO (vídeo pelo celular) | ✅ script pronto (`scripts/gerar_video.sh`) |
| 1.11 | **Editar título e condição pelo celular** | BreakerPRO | 🆕 |
| 1.12 | **Shopee** como canal extra | VHD | 🆕 opcional |
| 1.13 | **Várias contas do ML** no mesmo painel | Drive Parts, iBR | 🆕 só se você tiver mais de uma |

## 2. Agilidade no cadastro e no dia a dia

| # | Funcionalidade | Onde existe | Situação |
|---|---|---|---|
| 2.1 | **Etiquetas numeradas pré-impressas (TAGs)**: imprime um rolo numerado antes, cola na peça, e no cadastro só lê a etiqueta | Vaapt | 🆕 elimina imprimir etiqueta peça por peça |
| 2.2 | **Cadastro pelo celular**: ler etiqueta, tirar foto, poucos campos | Ovoko, BreakerPRO, Gestão Desmonte, Vaapt | ✅ protótipo já roda no celular; 🆕 fluxo otimizado |
| 2.3 | **Salvar cadastro pela metade** e continuar depois | Ovoko | 🆕 |
| 2.4 | **Grade e zoom na câmera** para enquadrar as fotos | Ovoko | 🆕 |
| 2.5 | **Cadastro por voz** ("caixa de fusível, BMW 120i, 2010, 250 reais") | Vaapt | 🆕 testar no celular |
| 2.6 | **Ler o part number por foto** (a IA lê a etiqueta da peça) | Ovoko, AutomaSnap | 🆕 depois; só funciona se o número estiver legível |
| 2.7 | **Duplicar peça** (par de faróis, jogo de rodas) | Magis5 ("duplicar") | 🆕 |
| 2.8 | **Edição em massa** (preço, local, descrição de várias peças) | Checkmate, Magis5, Ideris, UpSeller | 🆕 |
| 2.9 | **Lista de separação** das vendas do ML, com a localização de cada peça, e **impressão das etiquetas de envio em lote** | Ideris, UpSeller | 🆕 |
| 2.10 | **Busca por parte do nome do local** (ex.: "PRT-1*") | Checkmate | 🆕 |

## 3. Organização das peças e etiquetas

| # | Funcionalidade | Onde existe | Situação |
|---|---|---|---|
| 3.1 | **Hierarquia de locais** (setor › rua › prateleira › box) | Gestão Desmonte, iBR | ✅ protótipo (níveis livres) |
| 3.2 | **Sugestão automática de local** no cadastro, com **capacidade** por local | Drive Parts | 🆕 sugere caixa com espaço ou do mesmo grupo de peça |
| 3.3 | **QR que abre a ficha pela câmera de qualquer celular** (dados, histórico, status) | Drive Parts, Gestão Desmonte | 🆕 QR com link; o leitor USB continua funcionando |
| 3.4 | **Mover peça com o leitor**, com histórico de quem moveu e quando | Checkmate (Real Time Barcoding), BreakerPRO | ✅ no plano; 🆕 histórico |
| 3.5 | **Auditoria**: peças fora do lugar ou sumidas | Checkmate (Photomate), BreakerPRO | ✅ no plano (conferência de caixa) |
| 3.6 | **Mapa visual do estoque** | Gestão Desmonte | 🆕 depois |
| 3.7 | **Tempo de cada peça no estoque** e relatório de paradas | Gestão Desmonte | ✅ no plano |
| 3.8 | **Relatórios**: vendas por canal, por modelo de veículo, por categoria e cadastros por funcionário | Drive Parts | ✅ por canal; 🆕 os demais |
| 3.9 | **Impressão de etiquetas em lote** | iBR, Vaapt, Checkmate | ✅ protótipo |
| 3.10 | Cálculo de **cubagem** por caixa | Drive Parts | ❌ descartado: complexo demais para o ganho |

---

## Recomendação de prioridade

**Etapa 1 (sistema no ar):**
1. Etiquetas numeradas pré-impressas (2.1)
2. QR com link para a câmera do celular (3.3)
3. Cadastro pelo celular com rascunho, duplicar peça e grade na câmera (2.2, 2.3, 2.4, 2.7)
4. Mover e conferir com o leitor, com histórico (3.4, 3.5)
5. Edição em massa (2.8)
6. Sugestão de local (3.2)
7. Relatórios por modelo, categoria e funcionário (3.8)
8. Teste do cadastro por voz (2.5)

**Etapa 2 (Mercado Livre):**
1. Publicação em lote com modelos de título e descrição (1.1, 1.2)
2. Base própria de compatibilidades + painel de pendências (⚠️ acima, 1.5)
3. Baixa automática à prova de venda dupla (1.3, 1.4)
4. Lista de separação + etiquetas de envio em lote (2.9)
5. Perguntas do ML com respostas prontas (1.6)
6. Republicar parados e preço para peças novas (1.7, 1.8)
7. Opcionais: Shopee (1.12), várias contas (1.13)

**Depois:** ler part number por foto (2.6), mapa visual (3.6), edição pelo celular (1.11).

---

## Fontes

**Brasil**
- Drive Parts: [início](https://site.driveparts.com.br/), [nosso sistema](https://site.driveparts.com.br/nosso-sistema/), [localização inteligente](https://site.driveparts.com.br/funcionalidades/localizacao-inteligente/), [catálogo de peças](https://site.driveparts.com.br/funcionalidades/catalogo-pecas/)
- [VHD Sistema](https://vhdsistema.com.br/)
- Gestão Desmonte: [início](https://gestaodesmonte.com.br/), [controle de estoque](https://gestaodesmonte.com.br/blog/controle-de-estoque-em-cdv), [demonstração](https://gestaodesmonte.com.br/demonstracao-gratuita)
- Vaapt: [início](https://www.vaapt.net/), [sistema para desmonte](https://www.vaapt.net/sistema-para-desmonte), [estoque organizado](https://www.vaapt.net/estoque-organizado)
- iBR: [sistema web desmonte](https://site.ibrsoft.com/sistema-web-desmonte), [página de contato](https://contato-desmonte.ibrsoft.com/), [formulário (catálogo 3 mi peças)](https://informacoes.ibrsoft.com/lp-agenda-demonstracao-site), [Reclame Aqui](https://www.reclameaqui.com.br/ibr-tecnologia/sistema-ibr-web-desmonte-com-problemas-de-baixa-de-estoque-e-falta-de-supor_dvxukl-WFQ6N2H22/)

**Exterior**
- Checkmate: [detalhes](https://products.car-part.com/checkmate/details.html), [Real Time Barcoding](https://products.car-part.com/barcoding/), [Inventory Pro](https://products.car-part.com/trainingdocs/checkmate/Checkmate_InventoryPro.pdf), [novidades 2023](https://products.car-part.com/trainingdocs/checkmate/Checkmate2023R3_NewFeatures.pdf), [Photomate](https://apps.apple.com/us/app/photomate-for-checkmate/id1197577260)
- BreakerPRO: [guia do app](https://www.breakerpro.co.uk/install/appguide.pdf), [Google Play](https://play.google.com/store/apps/details?id=com.breakerspro&hl=en_US), [review](https://www.webretailer.com/reviews/breakerpro/), [ChannelX](https://channelx.world/2022/05/breakerpro-cloud-web-app-launched/)
- Ovoko: [App Store](https://apps.apple.com/lt/app/ovoko/id6737126393), [Google Play](https://play.google.com/store/apps/details?id=com.ovoko.supplyapp&hl=en_NZ), [entrevista P&D](https://meetfrank.com/blog/companies/ovoko-ai-automation-circular-economy)
- Dismantly: [site](https://www.dismantly.ai/), [produto](https://www.dismantly.ai/product); limites da IA por foto: [reParta](https://reparta.com/blog/ebay-ai-listing-tools)
- [AutomaSnap (leitura de etiqueta por foto)](https://automa.net/features/automasnap)

**Mercado Livre e integradores**
- [Compatibilidades de autopeças (API)](https://developers.mercadolivre.com.br/pt_br/compatibilidades-itens-e-produtos-de-autopecas), [versão em inglês](https://developers.mercadolivre.com.br/en_us/compatibility-between-items-and-vehicle-accessories), [referências de domínios](https://developers.mercadolivre.com.br/pt_br/referencias-de-dominios-produtos-e-atributos-para-autopecas), [moderações](https://developers.mercadolivre.com.br/pt_br/gerenciar-moderacoes), [competição de catálogo (price_to_win)](https://developers.mercadolivre.com.br/en_us/catalog-competition)
- [UpSeller – integração ML](https://www.upseller.com/en/mercado-integration/), [Magis5](https://magis5.com.br/integracao-mercado-livre/), [Linx – hubs de integração 2026](https://linxcommerce.com.br/os-5-melhores-hubs-de-integracao-de-marketplace-em-2026/)
- Boas práticas: [Anymarket – autopeças no ML](https://marketplace.anymarket.com.br/vender-auto-pecas-no-mercado-livre/), [1001clicks – fotos para o ML](https://1001clicks.com.br/blog/post/como-fazer-fotos-para-mercado-livre/), [GoSmarter – algoritmo ML 2026](https://gosmarter.com.br/algoritmo-mercado-livre/)
