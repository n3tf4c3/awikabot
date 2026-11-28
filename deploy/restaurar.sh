#!/bin/sh
# Restaura um backup do awikabot, rodado no host, com o servidor parado.
#
#   deploy/restaurar.sh <awikabot-<data>.tar>
#
# Só restaura num volume que ainda não tem o banco nem as pastas de bots e as
# conversas do motor que vêm no arquivo: nunca escreve por cima de um servidor com
# dados. O volume pode já ter o login dos motores, que não vem no backup.
#
# O arquivo é extraído e conferido numa pasta à parte, dentro do volume, e só depois
# vai para o lugar. Se a extração ou uma conferência falha, o volume fica como estava
# e a restauração pode ser tentada de novo.
#
# Uma restauração por volume: da conferência de que o volume está livre até o fim da
# troca para o lugar, esta execução segura uma trava do volume, e outra que chega no
# meio é recusada sem tocar em nada. A trava se solta sozinha quando esta execução
# termina, mesmo morta à força.
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
# Um contêiner novo do serviço, com o volume, sem subir o servidor. Ele não herda a ponta da trava
# (o descritor 8): só esta execução a segura.
no_volume() { compose run --rm -T --no-deps "$@" 8>&-; }

recusar() {
  echo "$1; nada foi restaurado" >&2
  exit 1
}

# A pasta à parte, dentro do volume, onde o arquivo é extraído e conferido. Só esta execução a usa.
area=".restaurando-$(date -u +%Y%m%dT%H%M%SZ)-$$"
area_no_volume=nao
anotacoes=
trava=
# Desfaz só o que esta execução criou: a pasta à parte no volume, a trava e as anotações no host.
# A pasta sai antes de a trava se soltar, para a execução seguinte não a ver como sobra.
limpar() {
  [ "$area_no_volume" = nao ] || no_volume --entrypoint rm server -rf "/data/$area" </dev/null >/dev/null 2>&1 || true
  if [ -n "$trava" ]; then
    exec 8>&-
    wait "$trava" 2>/dev/null || true
  fi
  [ -z "$anotacoes" ] || rm -rf "$anotacoes"
}
trap limpar EXIT
anotacoes=$(mktemp -d)
lista="$anotacoes/lista"

# O .sha256 vale pelos bytes do arquivo escolhido, não pelo nome escrito dentro dele: o nome
# poderia apontar para outro arquivo da mesma pasta, e o escolhido passaria sem conferência.
if [ -f "$arquivo.sha256" ]; then
  [ "$(grep -c '' "$arquivo.sha256")" -eq 1 ] || recusar "o .sha256 do arquivo não tem exatamente uma linha"
  esperado=$(sed -n 's/^\([0-9a-f]\{64\}\) [ *].*$/\1/p' "$arquivo.sha256")
  [ -n "$esperado" ] || recusar "o .sha256 do arquivo não tem o formato esperado"
  obtido=$(sha256sum <"$arquivo" | cut -c1-64)
  [ "$obtido" = "$esperado" ] || recusar "o arquivo não confere com o .sha256 dele"
else
  echo "aviso: sem $arquivo.sha256; a integridade do arquivo não foi conferida" >&2
fi

# O arquivo é listado uma vez, até o fim, e tem de terminar com a marca de fim do tar: uma listagem
# que falha no meio não pode passar por arquivo com poucas entradas.
tar -tf "$arquivo" >"$lista" 2>/dev/null || recusar "o arquivo não é um tar legível até o fim"
[ "$(tail -c 1024 "$arquivo" | tr -d '\000' | wc -c)" -eq 0 ] || recusar "o arquivo não termina com a marca de fim do tar"

# O arquivo só pode trazer o que o backup.sh põe nele. Qualquer outra entrada, como um
# arquivo de configuração do motor, faz a restauração ser recusada antes de tocar no volume.
estranhas=$(awk '
  $0 ~ /(^|\/)\.\.(\/|$)/ { print; next }
  $0 == "awikabot.db" || $0 == "trabalho" || index($0, "trabalho/") == 1 { next }
  $0 == "claude/projects" || index($0, "claude/projects/") == 1 { next }
  $0 == "codex/sessions" || index($0, "codex/sessions/") == 1 { next }
  { print }
' "$lista" | head -n 3)
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
itens=$(awk -F/ '
  $1 == "awikabot.db" { print $1 }
  $1 == "trabalho" && $2 != "" { print $1 "/" $2 }
  $1 == "claude" && $2 == "projects" && $3 != "" { print $1 "/" $2 "/" $3 }
  $1 == "codex" && $2 == "sessions" && NF > 3 && $NF != "" { print }
' "$lista" | sort -u)
printf '%s\n' "$itens" | grep -qx 'awikabot.db' || { echo "o arquivo não tem o banco; não parece um backup do awikabot" >&2; exit 1; }

# A trava do volume. Sem ela, duas restaurações passam juntas pela conferência de que o volume está
# livre, e cada item vai para o lugar vindo de uma cópia diferente. Um contêiner segura o flock num
# arquivo do volume enquanto a entrada dele estiver aberta. A entrada é um cano comum, que o Docker de
# qualquer sistema lê até o fim (um FIFO dado direto ao docker.exe do Windows chega a ele já no fim);
# quem escreve nele é um `cat` que só termina quando esta execução fecha o descritor 8. A trava é do
# sistema: quando esta execução termina, mesmo morta à força, o `cat` sai, a entrada se fecha, o
# contêiner sai e a trava se solta, sem nada para alguém apagar à mão. O health check da imagem também
# roda nele, que vive a restauração inteira: com a pasta de dados no /tmp do próprio contêiner, a vigia
# anota as falhas lá, e não no volume.
# shellcheck disable=SC2016
travar='exec 9>>/data/.restaurar.trava || exit 1
flock -n 9 || { echo ocupada; exit 0; }
echo travada
exec cat >/dev/null'
mkfifo "$anotacoes/trava-viva" "$anotacoes/trava-saida"
cat "$anotacoes/trava-viva" | no_volume -e AWIKA_DADOS=/tmp --entrypoint sh server -c "$travar" >"$anotacoes/trava-saida" &
trava=$!
exec 8>"$anotacoes/trava-viva"
situacao=
read -r situacao <"$anotacoes/trava-saida" || true
case "$situacao" in
  travada) ;;
  ocupada) recusar "outra restauração está rodando neste volume" ;;
  *) recusar "não foi possível travar o volume para a restauração" ;;
esac

# shellcheck disable=SC2016
livre='while IFS= read -r item; do [ ! -e "/data/$item" ] || exit 1; done
for sobra in /data/.restaurando-*; do
  [ ! -e "$sobra" ] || echo "aviso: o volume tem a sobra de uma restauração interrompida: $sobra" >&2
done'
if ! printf '%s\n' "$itens" | no_volume --entrypoint sh server -c "$livre"; then
  echo "o volume já tem o banco, uma pasta de bot ou uma conversa do motor deste backup; restaure só num volume sem esses dados" >&2
  exit 1
fi

# A extração vai para a pasta à parte. Uma falha de leitura ou de espaço no meio dela não deixa
# nada no lugar do banco nem das pastas dos bots.
membros=$(awk -F/ '$1 == "awikabot.db" || $1 == "trabalho" { print $1 } $1 == "claude" { print "claude/projects" } $1 == "codex" { print "codex/sessions" }' "$lista" | sort -u)
area_no_volume=sim
# shellcheck disable=SC2016
extrair='area=$1; shift; mkdir "/data/$area" && exec tar -C "/data/$area" -xf - "$@"'
# shellcheck disable=SC2086
no_volume --entrypoint sh server -c "$extrair" sh "$area" $membros <"$arquivo" \
  || recusar "a extração do arquivo falhou, e o volume ficou como estava"

# O banco extraído é aberto e conferido inteiro antes de ir para o lugar.
no_volume server conferir-banco "/data/$area/awikabot.db" </dev/null \
  || recusar "o banco do arquivo não passou na conferência, e o volume ficou como estava"

# O backup traz os aparelhos pareados como estavam no dia da cópia: um aparelho revogado depois
# dela voltaria a entrar com o token antigo. Não há registro das revogações fora do banco, então
# todos saem, ainda na pasta à parte: o banco só chega ao lugar já sem aparelho ativo.
no_volume -e "AWIKA_DADOS=/data/$area" server revogar-todos </dev/null \
  || recusar "não foi possível revogar os aparelhos do backup, e o volume ficou como estava"

# A troca para o lugar é só de nome, dentro do mesmo volume, com o banco por último. Se um item
# não puder ir, os que já foram voltam para a pasta à parte.
# shellcheck disable=SC2016
promover='cd "/data/$1" || exit 1
[ ! -s awikabot.db-wal ] || { echo "o banco extraído ficou com gravação pendente" >&2; exit 1; }
rm -f awikabot.db-wal awikabot.db-shm
: >.movidos
desfazer() {
  while IFS= read -r feito; do mv "/data/$feito" "/data/$1/$feito"; done <.movidos
  exit 1
}
while IFS= read -r item; do
  [ -e "$item" ] || { echo "falta no que foi extraído: $item" >&2; desfazer "$1"; }
  [ ! -e "/data/$item" ] || { echo "apareceu no volume durante a restauração: $item" >&2; desfazer "$1"; }
  { mkdir -p "/data/$(dirname "$item")" && mv "$item" "/data/$item"; } || desfazer "$1"
  printf "%s\n" "$item" >>.movidos
done
rm -f .movidos'
{ printf '%s\n' "$itens" | grep -vxF 'awikabot.db' || true; echo 'awikabot.db'; } \
  | no_volume --entrypoint sh server -c "$promover" sh "$area" \
  || recusar "a troca para o lugar falhou e foi desfeita, e o volume ficou como estava"

echo "Restaurado. Os aparelhos pareados no backup foram revogados: depois de subir o servidor, pareie cada um de novo (comando parear)."
echo "Se o volume é novo, faça o login do motor (ver deploy/compose.yaml) antes de subir o servidor."
