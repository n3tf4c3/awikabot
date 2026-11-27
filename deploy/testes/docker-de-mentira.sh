#!/bin/sh
# Um `docker` de mentira, para testar deploy/backup.sh e deploy/restaurar.sh sem contêiner.
# Só é usado por deploy/testes/testar.sh, que o põe no PATH com o nome `docker`.
#
# Atende só ao que os dois scripts pedem ao `docker compose`: `exec`, `run` e `ps` no serviço
# `server`. O volume do contêiner, /data, vira a pasta de FALSO_DADOS. O comando `backup` do
# servidor é imitado por um arquivo de texto. Cada chamada fica anotada em FALSO_REGISTRO.
#
# FALSO_FALHA escolhe um defeito por vez; FALSO_NO_AR faz o servidor parecer no ar.
set -eu

dados=${FALSO_DADOS:?defina FALSO_DADOS}
registro=${FALSO_REGISTRO:?defina FALSO_REGISTRO}
falha=${FALSO_FALHA:-}

anotar() {
  printf '%s\n' "$1" >>"$registro"
}

[ "${1:-}" = compose ] || { echo "docker de mentira: só atende a \"compose\"" >&2; exit 125; }
shift
sub=${1:-}
[ $# -eq 0 ] || shift

# O empacotamento, na forma que o backup.sh usa: sh -c <roteiro> sh <transformação> <cópia> <pastas...>.
empacotar() {
  anotar "exec empacotar"
  case "$falha" in
    # O compose falha antes de o tar começar, com o mesmo código 1 de "arquivo mudou durante a leitura".
    empacotador-nao-roda) exit 1 ;;
    tar-falha)
      echo "tar: erro de mentira" >&2
      echo "awikabot-tar-saiu:2" >&2
      exit 2
      ;;
    # O tar termina bem, mas só o começo do arquivo chega ao host.
    fluxo-cortado) "$@" | head -c 2048 ;;
    # O tar avisa que um arquivo mudou durante a leitura: código 1, com o arquivo inteiro.
    arquivo-mudou)
      "$@" 2>"$registro.erros"
      sed 's/^awikabot-tar-saiu:0$/awikabot-tar-saiu:1/' "$registro.erros" >&2
      exit 1
      ;;
    # O banco muda entre a conferência do servidor e o empacotamento.
    banco-trocado)
      echo "adulterado" >>"$dados/$6"
      "$@"
      ;;
    # Um tar inteiro e bem terminado, mas sem o banco.
    sem-banco)
      tar -C "$dados" -cf - trabalho
      echo "awikabot-tar-saiu:0" >&2
      ;;
    # Um tar inteiro, só com o banco: falta uma pasta que existe no volume.
    sem-pasta-esperada) "$1" "$2" "$3" "$4" "$5" "$6" ;;
    *) "$@" ;;
  esac
}

case "$sub" in
  ps)
    anotar "ps"
    [ -z "${FALSO_NO_AR:-}" ] || echo 0123456789ab
    ;;

  exec | run)
    entrada=
    while [ "${1:-}" != server ]; do
      if [ "$1" = --entrypoint ]; then
        entrada=$2
        shift
      fi
      shift
    done
    shift

    # Troca /data pela pasta do teste em cada argumento.
    faltam=$#
    while [ "$faltam" -gt 0 ]; do
      argumento=$1
      shift
      set -- "$@" "$(printf '%s' "$argumento" | sed "s|/data|$dados|g")"
      faltam=$((faltam - 1))
    done

    if [ "$sub" = run ] && [ -n "$entrada" ]; then
      anotar "run $entrada"
      "$entrada" "$@"
    elif [ "$sub" = run ]; then
      case "${1:-}" in
        revogar-todos)
          if [ -e "$dados/awikabot.db" ]; then anotar "run revogar-todos banco=sim"; else anotar "run revogar-todos banco=nao"; fi
          [ "$falha" != revogar ] || { echo "erro de mentira ao revogar" >&2; exit 1; }
          echo "1 aparelho(s) revogado(s)."
          ;;
        *) echo "docker de mentira: comando do servidor desconhecido: ${1:-}" >&2; exit 125 ;;
      esac
    else
      case "$1" in
        node)
          # node /app/server.mjs backup <destino>
          [ "${3:-}" = backup ] || { echo "docker de mentira: comando do servidor desconhecido: ${3:-}" >&2; exit 125; }
          anotar "exec backup"
          [ "$falha" != copia-do-banco ] || { echo "Backup não concluído: erro de mentira" >&2; exit 1; }
          mkdir -p "$(dirname "$4")"
          printf 'banco de mentira\n' >"$4"
          echo "Backup gravado em $4"
          [ "$falha" = sem-sha256 ] || echo "17 bytes, sha256 $(sha256sum "$4" | cut -c1-64)"
          ;;
        # A forma antiga do backup.sh: o tar chamado direto, sem dizer com que código terminou.
        tar)
          anotar "exec empacotar"
          case "$falha" in
            empacotador-nao-roda) exit 1 ;;
            fluxo-cortado) "$@" | head -c 2048 ;;
            *) "$@" ;;
          esac
          ;;
        sh)
          case "${3:-}" in
            *awikabot-tar-saiu*) empacotar "$@" ;;
            *'echo fim'*)
              anotar "exec consulta"
              case "$falha" in
                consulta) exit 1 ;;
                consulta-pela-metade) "$@" | head -n 1 ;;
                *) "$@" ;;
              esac
              ;;
            *) "$@" ;;
          esac
          ;;
        test)
          # A forma antiga da consulta: uma falha do compose tem o mesmo código de pasta ausente.
          [ "$falha" != consulta ] || exit 1
          "$@"
          ;;
        *) "$@" ;;
      esac
    fi
    ;;

  *)
    echo "docker de mentira: subcomando desconhecido: $sub" >&2
    exit 125
    ;;
esac
