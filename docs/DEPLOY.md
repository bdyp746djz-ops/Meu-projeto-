# Publicar o sistema na Cloudflare (Etapa 1)

Pré-requisitos: conta na Cloudflare (grátis) e Node.js instalado. Faça no computador.

## 1. Instalar e entrar
```bash
npm install
npx wrangler login      # abre o navegador para autorizar a sua conta Cloudflare
```

## 2. Criar o banco (D1) e o bucket de fotos (R2)
```bash
npx wrangler d1 create rafa-desmanche
# copie o database_id que aparecer e cole em wrangler.toml (campo database_id)

npx wrangler r2 bucket create rafa-fotos
```

## 3. Criar as tabelas
```bash
npm run db:init         # roda migrations/0001_init.sql no banco remoto
```

## 4. Definir a chave de sessão (senha interna do sistema)
```bash
npx wrangler secret put SESSION_SECRET
# cole um texto longo e aleatório quando pedir
```

## 5. Publicar
```bash
npm run deploy
```
No fim aparece o endereço (algo como `https://rafa-busca-pecas.SEU-SUBDOMINIO.workers.dev`).

## 6. Primeiro acesso
Abra o endereço, clique em **"Primeiro acesso? Criar administrador"**, defina seu login e senha. Pronto.

---

### Observações
- As fotos ficam no R2 (10 GB grátis); o banco no D1 (5 GB grátis).
- `SESSION_SECRET` nunca vai para o Git — fica só como secret na Cloudflare.
- Backup: `npx wrangler d1 export rafa-desmanche --remote --output backup.sql` (dá para agendar).
- Etapa 2 (Mercado Livre) entra depois, com o app de desenvolvedor e a autorização da sua conta.
