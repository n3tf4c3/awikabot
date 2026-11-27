#!/bin/sh
# Backup do awikabot, rodado no host do servidor, com o servidor no ar.
#
#   deploy/backup.sh <pasta-de-destino>
#
# Gera awikabot-<data>.tar e o .sha256 dele, com:
#   - o banco, copiado inteiro e coerente pelo comando `backup` do servidor;
#   - as pastas de trabalho dos bots;
#   - as conversas de cada motor (Claude Code e Codex), para os bots lembrarem depois de restaurados.
# O login dos motores nunca entra no arquivo: nem claude/.credentials.json nem codex/auth.json.
#
# O arquivo só ganha o nome final depois de conferido: o tar terminou, o arquivo é lido até o fim,
# traz o que devia e o banco dentro dele é a cópia que o servidor conferiu. Se qualquer passo
# falha, não fica arquivo nem .sha256.
#
# Duas execuções ao mesmo tempo não mexem uma na outra: cada uma tem a sua cópia do banco no
# volume e a sua pasta de trabalho no destino, e o nome final nunca troca um arquivo que já existe.
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
# O nome da cópia no volume leva o número deste processo: duas execuções no mesmo segundo, até
# com destinos diferentes, não disputam o mesmo arquivo.
copia="backup/awikabot-$carimbo-$$.db"

umask 077
mkdir -p "$destino"
for existente in "$destino/$nome" "$destino/$nome.sha256"; do
  [ ! -e "$existente" ] || { echo "já existe: $existente" >&2; exit 1; }
done

falhar() {
  echo "$1; nenhum backup foi gravado" >&2
  exit 1
}

# Desfaz só o que esta execução criou: a cópia do banco no volume, depois de o servidor a ter
# gravado, e a pasta de trabalho no destino. A cópia que o servidor recusou gravar é de outra execução.
copia_no_volume=nao
area=
limpar() {
  [ "$copia_no_volume" = nao ] || compose exec -T server rm -f "/data/$copia" </dev/null >/dev/null 2>&1 || true
  [ -z "$area" ] || rm -rf "$area"
}
trap limpar EXIT

# Tudo o que fica pela metade mora numa pasta só desta execução, ao lado do destino.
area=$(mktemp -d "$destino/.awikabot-backup.XXXXXX")
parcial="$area/arquivo.tar"

# Dá o nome final sem trocar o que já existe. O link nasce inteiro ou falha; onde o sistema de
# arquivos não tem link, uma cópia que só cria arquivo novo.
publicar() {
  if ln "$1" "$2" 2>/dev/null; then return 0; fi
  [ ! -e "$2" ] || return 1
  if (set -C; : >"$2") 2>/dev/null; then
    cat "$1" >"$2" || { rm -f "$2"; return 1; }
  else
    return 1
  fi
}

# A cópia do banco, que o servidor abre e confere. O sha256 que ele informa é o que o banco de
# dentro do arquivo final tem de ter.
relato=$(compose exec -T server node /app/server.mjs backup "/data/$copia" </dev/null) || falhar "o servidor não copiou o banco"
copia_no_volume=sim
printf '%s\n' "$relato"
banco_esperado=$(printf '%s\n' "$relato" | sed -n 's/.*sha256 \([0-9a-f]\{64\}\).*/\1/p' | head -n 1)
[ -n "$banco_esperado" ] || falhar "o servidor não informou o sha256 da cópia do banco"

# Quais pastas existem no volume. A resposta tem de vir inteira, com uma linha por pasta e a marca
# do fim: uma falha na consulta ao contêiner não pode passar por pasta ausente.
pastas='trabalho claude/projects codex/sessions'
# shellcheck disable=SC2016
consulta='for pasta in "$@"; do if [ -d "/data/$pasta" ]; then echo "tem $pasta"; else echo "sem $pasta"; fi; done; echo fim'
# shellcheck disable=SC2086
resposta=$(compose exec -T server sh -c "$consulta" sh $pastas </dev/null) || falhar "a consulta às pastas do volume falhou"
printf '%s\n' "$resposta" | grep -qxF 'fim' || falhar "a consulta às pastas do volume voltou incompleta"
itens=$copia
esperados=awikabot.db
for pasta in $pastas; do
  if printf '%s\n' "$resposta" | grep -qxF "tem $pasta"; then
    itens="$itens $pasta"
    esperados="$esperados $pasta"
  elif ! printf '%s\n' "$resposta" | grep -qxF "sem $pasta"; then
    falhar "a consulta às pastas do volume não disse se existe $pasta"
  fi
done

# No arquivo, o banco já sai com o nome que o servidor espera encontrar. O empacotador diz, pela
# saída de erro, com que código o tar terminou: sem essa linha, o tar nem chegou a rodar ou foi
# interrompido, e o código 1 do compose não é o "arquivo mudou durante a leitura" do tar.
# shellcheck disable=SC2016
empacotar='transformacao=$1; shift; estado=0; tar -C /data --transform "$transformacao" -cf - "$@" || estado=$?; echo "awikabot-tar-saiu:$estado" >&2; exit "$estado"'
estado=0
# shellcheck disable=SC2086
compose exec -T server sh -c "$empacotar" sh "s|^$copia\$|awikabot.db|" $itens </dev/null >"$parcial" 2>"$parcial.erros" || estado=$?
grep -v '^awikabot-tar-saiu:' "$parcial.erros" >&2 || true
relatado=$(sed -n 's/^awikabot-tar-saiu:\([0-9][0-9]*\).*/\1/p' "$parcial.erros" | tail -n 1)
[ -n "$relatado" ] || falhar "o empacotamento não chegou ao fim (código $estado)"
# O tar sai com 1 quando um arquivo muda durante a leitura, o que acontece com um bot trabalhando.
[ "$relatado" -le 1 ] || falhar "o tar falhou com código $relatado"
[ "$estado" -eq "$relatado" ] || falhar "o empacotamento terminou com código $estado, e o tar com $relatado"
[ "$relatado" -eq 0 ] || echo "aviso: algum arquivo de bot mudou durante a cópia; o banco não é afetado" >&2

# O que chegou ao host: lido até o fim, terminado pela marca de fim do tar, com o banco que o
# servidor conferiu e com cada pasta que existe no volume.
tar -tf "$parcial" >"$parcial.lista" 2>/dev/null || falhar "o arquivo gerado não é um tar legível até o fim"
[ "$(tail -c 1024 "$parcial" | tr -d '\000' | wc -c)" -eq 0 ] || falhar "o arquivo gerado não termina com a marca de fim do tar"
for membro in $esperados; do
  grep -qxF -e "$membro" -e "$membro/" "$parcial.lista" || falhar "o arquivo gerado não traz $membro"
done
banco_obtido=$(tar -xOf "$parcial" awikabot.db 2>/dev/null | sha256sum | cut -c1-64)
[ "$banco_obtido" = "$banco_esperado" ] || falhar "o banco de dentro do arquivo não é a cópia que o servidor conferiu"

# O .sha256 sai dos mesmos bytes conferidos e entra antes do arquivo: um .sha256 sozinho não passa por backup.
resumo=$(sha256sum "$parcial" | cut -c1-64)
printf '%s  %s\n' "$resumo" "$nome" >"$parcial.sha256"
# Se outra execução já gravou um backup com este nome, esta para aqui, sem tocar no dela.
publicar "$parcial.sha256" "$destino/$nome.sha256" || falhar "já existe um backup com este nome em $destino"
publicar "$parcial" "$destino/$nome" || { rm -f "$destino/$nome.sha256"; falhar "o arquivo conferido não pôde ganhar o nome final"; }
echo "Backup gravado em $destino/$nome"
