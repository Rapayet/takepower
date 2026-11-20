#!/bin/sh
# vigilante-permitir.sh - anota un hash de pago (o un txid de una salida on-chain) ANTES de hacerlo, para que el vigilante lo de por explicado.
# Lo usan los scripts de operacion (por ejemplo njalla-pay) justo antes de pagar.
#   uso:  vigilante-permitir.sh <hash-o-txid de 64 caracteres hex> "nota"
F="${ALLOW_FILE:-/opt/fondo/vigilante/permitidos.txt}"
H="${1:-}"; [ $# -gt 0 ] && shift
case "$H" in
  *[!0-9a-f]*|'') echo "el primer argumento debe ser un hash de 64 caracteres hexadecimales en minuscula"; exit 1;;
esac
[ "${#H}" -eq 64 ] || { echo "el hash debe tener 64 caracteres (tiene ${#H})"; exit 1; }
mkdir -p "$(dirname "$F")"
printf '%s %s %s\n' "$H" "$(date -u +%FT%TZ)" "$*" >> "$F"
chmod 600 "$F"
echo "anotado: ${H%????????????????????????????????????????????????????}..."
