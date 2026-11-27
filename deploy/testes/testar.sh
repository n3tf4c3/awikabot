#!/bin/sh
# Testa deploy/backup.sh e deploy/restaurar.sh com um `docker` de mentira, um defeito por vez.
#
#   sh deploy/testes/testar.sh
#
# Não usa Docker nem toca em volume de verdade: tudo acontece numa pasta temporária criada aqui e
# apagada no fim. Sai com 0 quando todos os casos passam. AWIKA_DEPLOY aponta outra pasta com os
# dois scripts, para rodar os mesmos casos contra uma versão anterior deles.
set -eu

aqui=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
scripts=${AWIKA_DEPLOY:-$aqui/..}

raiz=$(mktemp -d)
trap 'rm -rf "$raiz"' EXIT
mkdir "$raiz/bin" "$raiz/relogio-parado"
cp "$aqui/docker-de-mentira.sh" "$raiz/bin/docker"
chmod +x "$raiz/bin/docker"
# Um relógio que não anda, para duas execuções caírem no mesmo segundo.
printf '#!/bin/sh\necho 20260101T000000Z\n' >"$raiz/relogio-parado/date"
chmod +x "$raiz/relogio-parado/date"
PATH="$raiz/bin:$PATH"
export PATH
# Os scripts recebem um arquivo de compose qualquer: o docker de mentira não o lê.
export COMPOSE_FILE="$raiz/compose-de-mentira.yaml"

casos=0
falhas=0
conferir() {
  casos=$((casos + 1))
  if [ "$2" = sim ]; then
    echo "ok      $1"
  else
    falhas=$((falhas + 1))
    echo "FALHOU  $1"
    sed 's/^/        | /' "$raiz/saida"
  fi
}
se() {
  if "$@" >/dev/null 2>&1; then echo sim; else echo nao; fi
}
nao() {
  ! "$@"
}
# sim quando todas as condições recebidas são "sim".
todas() {
  for condicao in "$@"; do
    [ "$condicao" = sim ] || { echo nao; return; }
  done
  echo sim
}

volume=0
usar_volume() {
  FALSO_DADOS=$dados
  FALSO_REGISTRO="$raiz/registro-$volume"
  : >"$FALSO_REGISTRO"
  export FALSO_DADOS FALSO_REGISTRO
}
# Um volume com um bot e uma conversa do Claude Code; sem conversa do Codex, que é a pasta ausente.
novo_volume() {
  volume=$((volume + 1))
  dados="$raiz/dados-$volume"
  destino="$raiz/destino-$volume"
  mkdir -p "$dados/trabalho/bot1" "$dados/claude/projects/p1" "$destino"
  echo "arquivo do bot $volume" >"$dados/trabalho/bot1/notas.txt"
  echo "conversa do bot" >"$dados/claude/projects/p1/conversa.jsonl"
  usar_volume
}
fazer_backup() {
  estado=0
  FALSO_FALHA=$1 sh "$scripts/backup.sh" "$destino" </dev/null >"$raiz/saida" 2>&1 || estado=$?
}
vazio() {
  [ -z "$(ls -A "$1")" ]
}
sem_copia_no_volume() {
  [ ! -d "$dados/backup" ] || vazio "$dados/backup"
}
# A pasta tem um arquivo de backup e o .sha256 dele, e mais nada; e os dois conferem.
um_backup_bom_em() {
  [ "$(ls -A "$1" | wc -l)" -eq 2 ] && (cd "$1" && sha256sum -c ./*.sha256 >/dev/null 2>&1)
}

echo "== backup.sh"

novo_volume
fazer_backup ''
tar_bom=$(ls "$destino"/*.tar 2>/dev/null | head -n 1)
conferir "sem defeito: sai com 0 e grava o arquivo e o .sha256, que confere" "$(todas "$(se [ "$estado" -eq 0 ])" "$(se um_backup_bom_em "$destino")")"
tar -tf "$tar_bom" >"$raiz/lista" 2>/dev/null || true
conferir "sem defeito: o arquivo traz o banco, o bot e a conversa" \
  "$(todas "$(se grep -qxF awikabot.db "$raiz/lista")" "$(se grep -qxF trabalho/bot1/notas.txt "$raiz/lista")" "$(se grep -qxF claude/projects/p1/conversa.jsonl "$raiz/lista")")"
conferir "sem defeito: o banco de dentro do arquivo é a cópia do servidor" "$(se [ "$(tar -xOf "$tar_bom" awikabot.db)" = "banco de mentira" ])"
conferir "sem defeito: a cópia do banco não fica no volume" "$(se sem_copia_no_volume)"
mkdir "$raiz/bom"
cp "$tar_bom" "$tar_bom.sha256" "$raiz/bom/"
tar_bom="$raiz/bom/$(basename "$tar_bom")"

novo_volume
fazer_backup arquivo-mudou
conferir "arquivo de bot muda durante a leitura: grava o backup e avisa" \
  "$(todas "$(se [ "$estado" -eq 0 ])" "$(se um_backup_bom_em "$destino")" "$(se grep -q '^aviso:' "$raiz/saida")")"

# Cada defeito, com o trecho da mensagem que mostra qual conferência o pegou.
while IFS='|' read -r defeito mensagem; do
  novo_volume
  fazer_backup "$defeito"
  conferir "$defeito: sai com erro, sem arquivo nem .sha256 no destino e sem cópia no volume" \
    "$(todas "$(se [ "$estado" -ne 0 ])" "$(se vazio "$destino")" "$(se sem_copia_no_volume)")"
  conferir "$defeito: diz \"$mensagem\" e que nenhum backup foi gravado" \
    "$(todas "$(se grep -qF "$mensagem" "$raiz/saida")" "$(se grep -qF 'nenhum backup foi gravado' "$raiz/saida")")"
done <<'DEFEITOS'
copia-do-banco|o servidor não copiou o banco
sem-sha256|o servidor não informou o sha256 da cópia do banco
consulta|a consulta às pastas do volume falhou
consulta-pela-metade|a consulta às pastas do volume voltou incompleta
empacotador-nao-roda|o empacotamento não chegou ao fim
tar-falha|o tar falhou com código 2
fluxo-cortado|o arquivo gerado não
sem-banco|o arquivo gerado não traz awikabot.db
banco-trocado|o banco de dentro do arquivo não é a cópia que o servidor conferiu
sem-pasta-esperada|o arquivo gerado não traz trabalho
DEFEITOS

echo "== backup.sh, duas execuções no mesmo segundo"

# A primeira execução fica parada no empacotamento, já com a cópia do banco no volume, enquanto a
# segunda roda inteira. Depois a primeira é solta.
duas_execucoes() {
  destino_da_primeira=$1
  destino_da_segunda=$2
  libera="$raiz/libera-$volume"
  (
    estado=0
    PATH="$raiz/relogio-parado:$PATH" FALSO_PAUSA=$libera FALSO_FALHA='' sh "$scripts/backup.sh" "$destino_da_primeira" </dev/null >"$raiz/saida-da-primeira" 2>&1 || estado=$?
    echo "$estado" >"$raiz/estado-da-primeira"
  ) &
  voltas=0
  while ! grep -q '^exec empacotar$' "$FALSO_REGISTRO" && [ "$voltas" -lt 200 ]; do
    sleep 0.1
    voltas=$((voltas + 1))
  done
  estado_da_segunda=0
  PATH="$raiz/relogio-parado:$PATH" FALSO_FALHA='' sh "$scripts/backup.sh" "$destino_da_segunda" </dev/null >"$raiz/saida-da-segunda" 2>&1 || estado_da_segunda=$?
  : >"$libera"
  wait
  estado_da_primeira=$(cat "$raiz/estado-da-primeira")
  cat "$raiz/saida-da-primeira" "$raiz/saida-da-segunda" >"$raiz/saida"
}

novo_volume
mkdir "$destino-b"
duas_execucoes "$destino" "$destino-b"
conferir "destinos diferentes: as duas gravam o backup, cada uma com a sua cópia do banco" \
  "$(todas "$(se [ "$estado_da_primeira" -eq 0 ])" "$(se [ "$estado_da_segunda" -eq 0 ])" "$(se um_backup_bom_em "$destino")" "$(se um_backup_bom_em "$destino-b")")"
conferir "destinos diferentes: nenhuma cópia do banco fica no volume" "$(se sem_copia_no_volume)"

novo_volume
duas_execucoes "$destino" "$destino"
conferir "mesmo destino: a que termina primeiro grava o backup, e a outra para sem trocar nem apagar o dela" \
  "$(todas "$(se [ "$estado_da_segunda" -eq 0 ])" "$(se [ "$estado_da_primeira" -ne 0 ])" "$(se um_backup_bom_em "$destino")" "$(se grep -qF 'já existe um backup com este nome' "$raiz/saida-da-primeira")")"
conferir "mesmo destino: nenhuma cópia do banco fica no volume" "$(se sem_copia_no_volume)"

echo "== restaurar.sh"

# Um volume novo, sem dados, para receber um backup.
novo_destino_de_restauracao() {
  volume=$((volume + 1))
  dados="$raiz/dados-$volume"
  mkdir -p "$dados"
  usar_volume
}
restaurar() {
  estado=0
  FALSO_FALHA=$1 sh "$scripts/restaurar.sh" "${2:-$tar_bom}" </dev/null >"$raiz/saida" 2>&1 || estado=$?
}
linha_de() {
  grep -n "^$1\$" "$FALSO_REGISTRO" | head -n 1 | cut -d: -f1
}
# A ordem que protege o volume: extrair à parte, conferir o banco, revogar ainda à parte, e só então pôr no lugar.
na_ordem() {
  [ "$(linha_de 'run extrair')" -lt "$(linha_de 'run conferir-banco')" ] \
    && [ "$(linha_de 'run conferir-banco')" -lt "$(linha_de 'run revogar-todos em=pasta-a-parte banco=sim')" ] \
    && [ "$(linha_de 'run revogar-todos em=pasta-a-parte banco=sim')" -lt "$(linha_de 'run promover')" ]
}
restaurado() {
  [ "$(cat "$dados/awikabot.db")" = "banco de mentira" ] && [ -f "$dados/trabalho/bot1/notas.txt" ] && [ -f "$dados/claude/projects/p1/conversa.jsonl" ]
}
sem_pasta_a_parte() {
  [ -z "$(ls -A "$dados" | grep '^\.restaurando-' || true)" ]
}
# Nada do backup chegou ao lugar, e a pasta à parte não ficou.
volume_como_estava() {
  [ ! -e "$dados/awikabot.db" ] && [ ! -e "$dados/trabalho/bot1/notas.txt" ] && [ ! -e "$dados/claude/projects/p1" ] && sem_pasta_a_parte
}
volume_nao_foi_aberto() {
  nao grep -q '^run' "$FALSO_REGISTRO"
}

novo_destino_de_restauracao
restaurar ''
conferir "sem defeito: sai com 0, o volume recebe o banco, o bot e a conversa, e a pasta à parte não fica" \
  "$(todas "$(se [ "$estado" -eq 0 ])" "$(se restaurado)" "$(se sem_pasta_a_parte)")"
conferir "sem defeito: extrai à parte, confere o banco, revoga os aparelhos e só então põe no lugar, e diz isso" \
  "$(todas "$(se na_ordem)" "$(se grep -q 'foram revogados' "$raiz/saida")")"

# O volume já tem o login do motor, que não vem no backup e tem de ficar.
novo_destino_de_restauracao
mkdir -p "$dados/claude"
echo "login do motor" >"$dados/claude/.credentials.json"
restaurar extracao-interrompida
conferir "a extração falha no meio: sai com erro, nada chega ao lugar e o login do motor fica" \
  "$(todas "$(se [ "$estado" -ne 0 ])" "$(se volume_como_estava)" "$(se [ "$(cat "$dados/claude/.credentials.json")" = "login do motor" ])")"
restaurar ''
conferir "depois da extração que falhou, a mesma restauração passa no mesmo volume" \
  "$(todas "$(se [ "$estado" -eq 0 ])" "$(se restaurado)" "$(se [ "$(cat "$dados/claude/.credentials.json")" = "login do motor" ])")"

novo_destino_de_restauracao
restaurar banco-corrompido
conferir "o banco extraído não passa na conferência: sai com erro e nada chega ao lugar" \
  "$(todas "$(se [ "$estado" -ne 0 ])" "$(se volume_como_estava)" "$(se nao grep -q '^run promover$' "$FALSO_REGISTRO")")"

novo_destino_de_restauracao
restaurar revogar
conferir "a revogação falha: sai com erro, o banco não chega ao lugar e não diz \"Restaurado\"" \
  "$(todas "$(se [ "$estado" -ne 0 ])" "$(se volume_como_estava)" "$(se grep -q 'revogar os aparelhos' "$raiz/saida")" "$(se nao grep -q '^Restaurado' "$raiz/saida")")"

novo_destino_de_restauracao
restaurar promocao-em-conflito
conferir "um item aparece no volume na hora da troca: desfaz o que já tinha ido e não põe o banco" \
  "$(todas "$(se [ "$estado" -ne 0 ])" "$(se [ ! -e "$dados/awikabot.db" ])" "$(se [ ! -e "$dados/claude/projects/p1" ])" "$(se [ "$(cat "$dados/trabalho/bot1")" = "de outra origem" ])" "$(se sem_pasta_a_parte)")"

# Um segundo backup, de outro volume, com outro conteúdo.
novo_volume
fazer_backup ''
outro_tar=$(ls "$destino"/*.tar | head -n 1)

mkdir "$raiz/trocado"
cp "$tar_bom" "$tar_bom.sha256" "$raiz/trocado/"
cp "$outro_tar" "$raiz/trocado/escolhido.tar"
cp "$tar_bom.sha256" "$raiz/trocado/escolhido.tar.sha256"
novo_destino_de_restauracao
restaurar '' "$raiz/trocado/escolhido.tar"
conferir ".sha256 que confere outro arquivo da mesma pasta: recusa antes de abrir o volume" \
  "$(todas "$(se [ "$estado" -ne 0 ])" "$(se grep -q 'não confere com o .sha256' "$raiz/saida")" "$(se volume_nao_foi_aberto)" "$(se vazio "$dados")")"

mkdir "$raiz/renomeado"
cp "$tar_bom" "$raiz/renomeado/outro-nome.tar"
cp "$tar_bom.sha256" "$raiz/renomeado/outro-nome.tar.sha256"
novo_destino_de_restauracao
restaurar '' "$raiz/renomeado/outro-nome.tar"
conferir "backup renomeado junto com o .sha256: confere pelos bytes e restaura" "$(todas "$(se [ "$estado" -eq 0 ])" "$(se restaurado)")"

mkdir "$raiz/duas-linhas"
cp "$tar_bom" "$raiz/duas-linhas/a.tar"
cat "$tar_bom.sha256" "$tar_bom.sha256" >"$raiz/duas-linhas/a.tar.sha256"
novo_destino_de_restauracao
restaurar '' "$raiz/duas-linhas/a.tar"
conferir ".sha256 com mais de uma linha: recusa antes de abrir o volume" "$(todas "$(se [ "$estado" -ne 0 ])" "$(se volume_nao_foi_aberto)")"

mkdir "$raiz/cortado"
head -c 1300 "$tar_bom" >"$raiz/cortado/no-meio.tar"
head -c 2048 "$tar_bom" >"$raiz/cortado/no-limite.tar"
for cortado in no-meio no-limite; do
  novo_destino_de_restauracao
  restaurar '' "$raiz/cortado/$cortado.tar"
  conferir "arquivo cortado ($cortado de um membro): recusa na listagem, antes de abrir o volume" \
    "$(todas "$(se [ "$estado" -ne 0 ])" "$(se volume_nao_foi_aberto)" "$(se vazio "$dados")")"
done

novo_destino_de_restauracao
FALSO_NO_AR=1
export FALSO_NO_AR
restaurar ''
unset FALSO_NO_AR
conferir "servidor no ar: recusa sem tocar no volume" "$(todas "$(se [ "$estado" -ne 0 ])" "$(se vazio "$dados")")"

novo_destino_de_restauracao
echo "banco que já estava lá" >"$dados/awikabot.db"
restaurar ''
conferir "volume com dados: recusa, não troca o banco, não extrai nem revoga nada" \
  "$(todas "$(se [ "$estado" -ne 0 ])" "$(se [ "$(cat "$dados/awikabot.db")" = "banco que já estava lá" ])" "$(se nao grep -q 'revogar-todos\|run extrair\|run tar' "$FALSO_REGISTRO")" "$(se sem_pasta_a_parte)")"

echo
if [ "$falhas" -eq 0 ]; then
  echo "Passaram os $casos casos."
else
  echo "Falharam $falhas de $casos casos."
  exit 1
fi
