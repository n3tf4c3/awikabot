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
mkdir "$raiz/bin"
cp "$aqui/docker-de-mentira.sh" "$raiz/bin/docker"
chmod +x "$raiz/bin/docker"
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
# sim quando todas as condições recebidas são "sim".
todas() {
  for condicao in "$@"; do
    [ "$condicao" = sim ] || { echo nao; return; }
  done
  echo sim
}

volume=0
# Um volume com um bot e uma conversa do Claude Code; sem conversa do Codex, que é a pasta ausente.
novo_volume() {
  volume=$((volume + 1))
  dados="$raiz/dados-$volume"
  destino="$raiz/destino-$volume"
  mkdir -p "$dados/trabalho/bot1" "$dados/claude/projects/p1" "$destino"
  echo "arquivo do bot" >"$dados/trabalho/bot1/notas.txt"
  echo "conversa do bot" >"$dados/claude/projects/p1/conversa.jsonl"
  FALSO_DADOS=$dados
  FALSO_REGISTRO="$raiz/registro-$volume"
  : >"$FALSO_REGISTRO"
  export FALSO_DADOS FALSO_REGISTRO
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

echo "== backup.sh"

novo_volume
fazer_backup ''
tar_bom=$(ls "$destino"/*.tar 2>/dev/null | head -n 1)
conferir "sem defeito: sai com 0 e grava o arquivo e o .sha256" \
  "$(todas "$(se [ "$estado" -eq 0 ])" "$(se [ -f "$tar_bom" ])" "$(se [ -f "$tar_bom.sha256" ])" "$(se [ "$(ls -A "$destino" | wc -l)" -eq 2 ])")"
conferir "sem defeito: o .sha256 confere com o arquivo" "$(se sh -c 'cd "$1" && sha256sum -c "$(basename "$2").sha256"' sh "$destino" "$tar_bom")"
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
  "$(todas "$(se [ "$estado" -eq 0 ])" "$(se [ "$(ls -A "$destino" | wc -l)" -eq 2 ])" "$(se grep -q '^aviso:' "$raiz/saida")")"

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

echo "== restaurar.sh"

# Um volume novo, sem dados, para receber o backup bom.
novo_destino_de_restauracao() {
  volume=$((volume + 1))
  dados="$raiz/dados-$volume"
  mkdir -p "$dados"
  FALSO_DADOS=$dados
  FALSO_REGISTRO="$raiz/registro-$volume"
  : >"$FALSO_REGISTRO"
  export FALSO_DADOS FALSO_REGISTRO
}
restaurar() {
  estado=0
  FALSO_FALHA=$1 sh "$scripts/restaurar.sh" "$tar_bom" </dev/null >"$raiz/saida" 2>&1 || estado=$?
}
revogou_depois_de_extrair() {
  [ "$(grep -n '^run tar$' "$FALSO_REGISTRO" | cut -d: -f1)" -lt "$(grep -n '^run revogar-todos banco=sim$' "$FALSO_REGISTRO" | cut -d: -f1)" ]
}

novo_destino_de_restauracao
restaurar ''
conferir "sem defeito: sai com 0 e o volume recebe o banco, o bot e a conversa" \
  "$(todas "$(se [ "$estado" -eq 0 ])" "$(se [ -f "$dados/awikabot.db" ])" "$(se [ -f "$dados/trabalho/bot1/notas.txt" ])" "$(se [ -f "$dados/claude/projects/p1/conversa.jsonl" ])")"
conferir "sem defeito: revoga todos os aparelhos depois de pôr o banco no volume, e diz isso" \
  "$(todas "$(se revogou_depois_de_extrair)" "$(se grep -q 'foram revogados' "$raiz/saida")")"

novo_destino_de_restauracao
restaurar revogar
conferir "a revogação falha: sai com erro e avisa para não subir o servidor antes de revogar" \
  "$(todas "$(se [ "$estado" -ne 0 ])" "$(se grep -q '^ATENÇÃO' "$raiz/saida")" "$(se grep -q 'revogar-todos' "$raiz/saida")" "$(se sh -c '! grep -q "^Restaurado" "$1"' sh "$raiz/saida")")"

novo_destino_de_restauracao
FALSO_NO_AR=1
export FALSO_NO_AR
restaurar ''
unset FALSO_NO_AR
conferir "servidor no ar: recusa sem tocar no volume e sem o aviso da revogação" \
  "$(todas "$(se [ "$estado" -ne 0 ])" "$(se vazio "$dados")" "$(se sh -c '! grep -q "^ATENÇÃO" "$1"' sh "$raiz/saida")")"

novo_destino_de_restauracao
echo "banco que já estava lá" >"$dados/awikabot.db"
restaurar ''
conferir "volume com dados: recusa, não troca o banco e não revoga nada" \
  "$(todas "$(se [ "$estado" -ne 0 ])" "$(se [ "$(cat "$dados/awikabot.db")" = "banco que já estava lá" ])" "$(se sh -c '! grep -q "revogar-todos" "$1"' sh "$FALSO_REGISTRO")")"

echo
if [ "$falhas" -eq 0 ]; then
  echo "Passaram os $casos casos."
else
  echo "Falharam $falhas de $casos casos."
  exit 1
fi
