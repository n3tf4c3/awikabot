#!/bin/sh
# Guarda a chave da API do Gemini no volume da prova, digitada por quem é dono dela, sem eco e sem
# passar por argumento, histórico do terminal ou arquivo do repositório. A prova só a entrega ao
# processo do agy, pelo ambiente. O "docker compose down -v" apaga.
set -eu
DESTINO=/data/segredos/gemini-api-key
umask 077
mkdir -p /data/segredos
printf 'Cole a chave da API do Gemini e aperte Enter (nada aparece na tela): '
stty -echo
trap 'stty echo' EXIT
IFS= read -r CHAVE
stty echo
printf '\n'
if [ -z "$CHAVE" ]; then
  echo 'Nenhuma chave lida; nada foi gravado.' >&2
  exit 1
fi
printf '%s' "$CHAVE" > "$DESTINO"
echo "Chave guardada em $DESTINO, dentro do volume (${#CHAVE} caracteres)."
