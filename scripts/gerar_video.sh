#!/usr/bin/env bash
# Gera um vídeo curto de anúncio a partir das fotos da peça.
# Cada foto ganha fundo branco, zoom lento e transição suave; o título
# e o preço aparecem numa faixa na parte de baixo.
#
# Uso:
#   ./scripts/gerar_video.sh -t "Caixa Filtro Ar BMW 120i 2008/11" [-p "R$ 300"] \
#       [-l "Rafa Busca Peças"] [-f vertical|quadrado|horizontal] [-d 3] \
#       [-o video.mp4] foto1.jpg foto2.jpg ...
#
# Requer: ffmpeg (com libx264 e drawtext).
set -euo pipefail

TITULO=""; PRECO=""; LOJA=""; FORMATO="vertical"; DUR=3; SAIDA="video.mp4"
TRANS=0.5; FPS=30

uso() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

while getopts "t:p:l:f:d:o:h" opt; do
  case $opt in
    t) TITULO=$OPTARG ;; p) PRECO=$OPTARG ;; l) LOJA=$OPTARG ;;
    f) FORMATO=$OPTARG ;; d) DUR=$OPTARG ;; o) SAIDA=$OPTARG ;; *) uso ;;
  esac
done
shift $((OPTIND-1))
[ $# -ge 1 ] || { echo "Erro: informe pelo menos uma foto." >&2; uso; }
command -v ffmpeg >/dev/null || { echo "Erro: ffmpeg não encontrado." >&2; exit 1; }

case $FORMATO in
  vertical)   W=1080; H=1920 ;;
  quadrado)   W=1080; H=1080 ;;
  horizontal) W=1920; H=1080 ;;
  *) echo "Erro: formato deve ser vertical, quadrado ou horizontal." >&2; exit 1 ;;
esac

# Fonte: tenta DejaVu (Linux), depois Arial (macOS/Windows).
FONTE=""
for f in /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf \
         /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf \
         /Library/Fonts/Arial\ Bold.ttf /System/Library/Fonts/Supplemental/Arial\ Bold.ttf \
         /c/Windows/Fonts/arialbd.ttf; do
  [ -f "$f" ] && { FONTE=$f; break; }
done

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
FRAMES=$(awk "BEGIN{print int($DUR*$FPS)}")
N=$#

# Se houver título/preço, a foto fica acima da faixa de texto (e abaixo do nome da loja).
BARRA=$((H/5)); TOPO=0; AREA=$H
[ -n "$TITULO$PRECO" ] && AREA=$((H-BARRA))
[ -n "$LOJA" ] && TOPO=$((H/12)) && AREA=$((AREA-TOPO))

ARGS=(); FILTRO=""; i=0
for foto in "$@"; do
  [ -f "$foto" ] || { echo "Erro: foto não encontrada: $foto" >&2; exit 1; }
  ARGS+=(-i "$foto")
  # Encaixa a foto no quadro com fundo branco (2x para o zoom não tremer),
  # depois aplica zoom lento até 8%.
  FILTRO+="[$i:v]scale=$((W*2*95/100)):$((AREA*2*95/100)):force_original_aspect_ratio=decrease,"
  FILTRO+="pad=$((W*2)):$((H*2)):(ow-iw)/2:$((TOPO*2))+($((AREA*2))-ih)/2:color=white,setsar=1,"
  FILTRO+="zoompan=z='min(zoom+0.0006,1.08)':d=$FRAMES:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=$FPS,"
  FILTRO+="format=yuv420p,setpts=PTS-STARTPTS[v$i];"
  i=$((i+1))
done

# Transições entre as fotos.
ULT="v0"
for ((k=1; k<N; k++)); do
  OFF=$(awk "BEGIN{print $k*($DUR-$TRANS)}")
  FILTRO+="[$ULT][v$k]xfade=transition=fade:duration=$TRANS:offset=$OFF[x$k];"
  ULT="x$k"
done

# Textos (via arquivo para não ter problema com acentos e aspas).
TXT=""
if [ -n "$FONTE" ]; then
  FS_T=$((W/22)); FS_P=$((W/14)); FS_L=$((W/30))
  TXT+="null"
  [ -n "$TITULO$PRECO" ] && TXT+=",drawbox=x=0:y=ih-$BARRA:w=iw:h=$BARRA:color=0x1d1f23:t=fill"
  if [ -n "$TITULO" ]; then
    printf '%s' "$TITULO" | fold -s -w 34 > "$TMP/titulo.txt"
    TXT+=",drawtext=fontfile='$FONTE':textfile='$TMP/titulo.txt':fontcolor=white:fontsize=$FS_T:line_spacing=8:x=(w-text_w)/2:y=h-$BARRA+$((BARRA/8))"
  fi
  if [ -n "$PRECO" ]; then
    printf '%s' "$PRECO" > "$TMP/preco.txt"
    TXT+=",drawtext=fontfile='$FONTE':textfile='$TMP/preco.txt':fontcolor=0xffe600:fontsize=$FS_P:x=(w-text_w)/2:y=h-$((BARRA/8))-text_h"
  fi
  if [ -n "$LOJA" ]; then
    printf '%s' "$LOJA" > "$TMP/loja.txt"
    TXT+=",drawtext=fontfile='$FONTE':textfile='$TMP/loja.txt':fontcolor=white:fontsize=$FS_L:box=1:boxcolor=0xc62828@0.9:boxborderw=18:x=(w-text_w)/2:y=$((H/30))"
  fi
elif [ -n "$TITULO$PRECO$LOJA" ]; then
  echo "Aviso: nenhuma fonte encontrada; o vídeo sai sem texto." >&2
fi

if [ -n "$TXT" ]; then FILTRO+="[$ULT]$TXT[final]"; else FILTRO+="[$ULT]null[final]"; fi

ffmpeg -hide_banner -loglevel error -y "${ARGS[@]}" -filter_complex "$FILTRO" \
  -map "[final]" -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p \
  -r $FPS -movflags +faststart "$SAIDA"

TOTAL=$(awk "BEGIN{print $N*$DUR-($N-1)*$TRANS}")
echo "Vídeo gerado: $SAIDA (${W}x${H}, ${TOTAL}s, $N foto(s))"
