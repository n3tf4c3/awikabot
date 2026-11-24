#!/bin/sh
# Backup do awikabot, rodado no host do servidor, com o servidor no ar.
#
#   deploy/backup.sh <pasta-de-destino>
#
# Gera awikabot-<data>.tar e o .sha256 dele, com:
#   - o banco, copiado inteiro e coerente pelo comando `backup` do servidor;
#   - as pastas de trabalho dos bots;
#   - as conversas do motor, para os bots lembrarem depois de restaurados.
# O login do motor nunca entra no arquivo.
#
# O arquivo leva conversas e arquivos dos bots: cifre antes de tirá-lo do host.
set -eu

[ $# -eq 1 ] || { echo "uso: $0 <pasta-de-destino>" >&2; exit 64; }
destino=$1
aqui=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# Outro arquivo de compose, ou um a mais, entra por COMPOSE_FILE, como no próprio Docker Compose.
export COMPOSE_FILE="${COMPOSE_FILE:-$aqui/compose.yaml}"
compose() { docker compose "$@"; }

carimbo=$(date -u +%Y%m%dT%H%M%SZ)
nome="awikabot-$carimbo.tar"
copia="backup/awikabot-$carimbo.db"

umask 077
mkdir -p "$destino"
[ ! -e "$destino/$nome" ] || { echo "já existe: $destino/$nome" >&2; exit 1; }

# Desfaz só o que este script criou: a cópia do banco no volume e o arquivo pela metade.
limpar() {
  compose exec -T server rm -f "/data/$copia" </dev/null >/dev/null 2>&1 || true
  rm -f "$destino/$nome.parcial"
}
trap limpar EXIT

compose exec -T server node /app/server.mjs backup "/data/$copia" </dev/null

itens=$copia
for pasta in trabalho claude/projects; do
  if compose exec -T server test -d "/data/$pasta" </dev/null; then itens="$itens $pasta"; fi
done

# No arquivo, o banco já sai com o nome que o servidor espera encontrar.
estado=0
# shellcheck disable=SC2086
compose exec -T server tar -C /data --transform "s|^$copia\$|awikabot.db|" -cf - $itens </dev/null >"$destino/$nome.parcial" || estado=$?
# O tar sai com 1 quando um arquivo muda durante a leitura, o que acontece com um bot trabalhando.
if [ "$estado" -gt 1 ]; then
  echo "o tar falhou com código $estado; nenhum backup foi gravado" >&2
  exit 1
fi
[ "$estado" -eq 0 ] || echo "aviso: algum arquivo de bot mudou durante a cópia; o banco não é afetado" >&2

mv "$destino/$nome.parcial" "$destino/$nome"
(cd "$destino" && sha256sum "$nome" >"$nome.sha256")
echo "Backup gravado em $destino/$nome"
