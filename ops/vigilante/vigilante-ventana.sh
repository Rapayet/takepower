#!/bin/sh
# vigilante-ventana.sh - abre una VENTANA DE MANTENIMIENTO: durante N minutos el vigilante tolera salidas sin explicar hasta un maximo de sats
# (por ejemplo, cuando vas a retirar fondos a mano). Pasada la ventana o superado el maximo, vuelve a frenar.
#   uso:  vigilante-ventana.sh <minutos> <max_sats> "nota"      |   vigilante-ventana.sh cerrar
F="${WINDOW_FILE:-/opt/fondo/vigilante/ventana.txt}"
if [ "$1" = "cerrar" ]; then rm -f "$F" && echo "ventana cerrada"; exit 0; fi
case "$1:$2" in
  ''|*[!0-9:]*|:*|*:) echo "uso: $0 <minutos> <max_sats> \"nota\"   |   $0 cerrar"; exit 1;;
esac
MIN="$1"; MAX="$2"; shift 2
[ "$MIN" -ge 1 ] && [ "$MIN" -le 240 ] || { echo "los minutos deben estar entre 1 y 240"; exit 1; }
EXP=$(( $(date +%s) + MIN * 60 ))
mkdir -p "$(dirname "$F")"
printf '%s %s %s\n' "$EXP" "$MAX" "$*" > "$F"
chmod 600 "$F"
echo "ventana abierta hasta $(date -d "@$EXP" '+%F %T %Z'): se toleran salidas sin explicar de hasta $MAX sats en total"
