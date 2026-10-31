# Scripts

## gerar_video.sh – vídeo de anúncio a partir das fotos

```bash
./scripts/gerar_video.sh -t "Caixa Filtro Ar BMW 118i 120i 2008/11" -p "R$ 300,00" \
  -l "Rafa Busca Peças" -o caixa-filtro.mp4 foto1.jpg foto2.jpg foto3.jpg
```

| Opção | O que faz | Padrão |
|---|---|---|
| `-t` | Título (faixa de baixo) | sem título |
| `-p` | Preço (amarelo) | sem preço |
| `-l` | Nome da loja (topo) | sem nome |
| `-f` | `vertical` (1080×1920), `quadrado` ou `horizontal` | vertical |
| `-d` | Segundos por foto | 3 |
| `-o` | Arquivo de saída | video.mp4 |

Cada foto ganha fundo branco, zoom lento e transição suave. Saída MP4 (H.264), pronta para celular e Mercado Livre.
Requer `ffmpeg`.
