#!/bin/sh
# Restaura um backup do awikabot, rodado no host, com o servidor parado.
#
#   deploy/restaurar.sh <awikabot-<data>.tar>
#
# Só restaura num volume que ainda não tem o banco nem as pastas de bots e as
# conversas do motor que vêm no arquivo: nunca escreve por cima de um servidor com
# dados. O volume pode já ter o login dos motores, que não vem no backup.
#
# Todo aparelho pareado no backup sai revogado: o arquivo não sabe quem foi revogado
# depois da cópia. Cada aparelho pareia de novo, com o comando `parear`.
#
# Para ensaiar ao lado do servidor de verdade, use outro projeto:
#   COMPOSE_PROJECT_NAME=awikabot-ensaio AWIKA_SUBREDE=172.28.0.0/16 AWIKA_PORTA_HOST=8799 \
#     deploy/restaurar.sh <arquivo.tar>
set -eu

[ $# -eq 1 ] || { echo "uso: $0 <arquivo.tar>" >&2; exit 64; }
arquivo=$1
[ -f "$arquivo" ] || { echo "arquivo não encontrado: $arquivo" >&2; exit 66; }
aqui=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# Outro arquivo de compose, ou um a mais, entra por COMPOSE_FILE, como no próprio Docker Compose.
export COMPOSE_FILE="${COMPOSE_FILE:-$aqui/compose.yaml}"
compose() { docker compose "$@"; }

if [ -f "$arquivo.sha256" ]; then
  (cd "$(dirname -- "$arquivo")" && sha256sum -c "$(basename -- "$arquivo").sha256" >/dev/null) \
    || { echo "o arquivo não confere com o .sha256 dele" >&2; exit 1; }
else
  echo "aviso: sem $arquivo.sha256; a integridade do arquivo não foi conferida" >&2
fi

# O arquivo só pode trazer o que o backup.sh põe nele. Qualquer outra entrada, como um
# arquivo de configuração do motor, faz a restauração ser recusada antes de tocar no volume.
estranhas=$(tar -tf "$arquivo" | awk '
  $0 ~ /(^|\/)\.\.(\/|$)/ { print; next }
  $0 == "awikabot.db" || $0 == "trabalho" || index($0, "trabalho/") == 1 { next }
  $0 == "claude/projects" || index($0, "claude/projects/") == 1 { next }
  $0 == "codex/sessions" || index($0, "codex/sessions/") == 1 { next }
  { print }
' | head -n 3)
if [ -n "$estranhas" ]; then
  echo "o arquivo traz entradas que um backup do awikabot não tem; nada foi restaurado. Primeiras:" >&2
  printf '%s\n' "$estranhas" >&2
  exit 1
fi

if compose ps -q server </dev/null | grep -q .; then
  echo "o servidor deste projeto está no ar; pare-o antes de restaurar" >&2
  exit 1
fi

# O que o arquivo traz, no nível que identifica cada coisa: o banco, a pasta de cada bot e a
# conversa de cada bot (no Codex, cada arquivo de conversa). Se qualquer um já existe no volume,
# nada é restaurado.
itens=$(tar -tf "$arquivo" | awk -F/ '
  $1 == "awikabot.db" { print $1 }
  $1 == "trabalho" && $2 != "" { print $1 "/" $2 }
  $1 == "claude" && $2 == "projects" && $3 != "" { print $1 "/" $2 "/" $3 }
  $1 == "codex" && $2 == "sessions" && NF > 3 && $NF != "" { print }
' | sort -u)
printf '%s\n' "$itens" | grep -qx 'awikabot.db' || { echo "o arquivo não tem o banco; não parece um backup do awikabot" >&2; exit 1; }

# shellcheck disable=SC2016
livre='while IFS= read -r item; do [ ! -e "/data/$item" ] || exit 1; done'
if ! printf '%s\n' "$itens" | compose run --rm -T --no-deps --entrypoint sh server -c "$livre"; then
  echo "o volume já tem o banco, uma pasta de bot ou uma conversa do motor deste backup; restaure só num volume sem esses dados" >&2
  exit 1
fi

# Do momento em que o banco entra no volume até a revogação passar, o volume guarda aparelhos que
# podem já ter sido revogados no servidor de origem. Se o script parar nesse intervalo, avisa.
revogar='docker compose run --rm --no-deps server revogar-todos'
banco_no_volume=nao
aparelhos_revogados=nao
avisar() {
  if [ "$banco_no_volume" = sim ] && [ "$aparelhos_revogados" = nao ]; then
    echo "ATENÇÃO: o volume pode ter recebido o banco do backup, e os aparelhos pareados nele ainda valem." >&2
    echo "Não suba o servidor antes de rodar, com o mesmo projeto e o mesmo arquivo de compose: $revogar" >&2
  fi
}
trap avisar EXIT

# -k: se, apesar da conferência, algum arquivo já existir, o tar para em vez de trocá-lo.
membros=$(tar -tf "$arquivo" | awk -F/ '$1 == "awikabot.db" || $1 == "trabalho" { print $1 } $1 == "claude" { print "claude/projects" } $1 == "codex" { print "codex/sessions" }' | sort -u)
banco_no_volume=sim
# shellcheck disable=SC2086
compose run --rm -T --no-deps --entrypoint tar server -C /data -k -xf - $membros <"$arquivo"

# O backup traz os aparelhos pareados como estavam no dia da cópia: um aparelho revogado depois
# dela voltaria a entrar com o token antigo. Não há registro das revogações fora do banco, então
# todos saem antes de o servidor subir, e cada aparelho pareia de novo.
compose run --rm -T --no-deps server revogar-todos </dev/null
aparelhos_revogados=sim

echo "Restaurado. Os aparelhos pareados no backup foram revogados: depois de subir o servidor, pareie cada um de novo (comando parear)."
echo "Se o volume é novo, faça o login do motor (ver deploy/compose.yaml) antes de subir o servidor."
