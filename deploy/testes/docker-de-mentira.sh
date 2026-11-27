#!/bin/sh
# Um `docker` de mentira, para testar deploy/backup.sh e deploy/restaurar.sh sem contêiner.
# Só é usado por deploy/testes/testar.sh, que o põe no PATH com o nome `docker`.
#
# Atende só ao que os dois scripts pedem ao `docker compose`: `exec`, `run` e `ps` no serviço
# `server`. O volume do contêiner, /data, vira a pasta de FALSO_DADOS. Os comandos do servidor
# (`backup`, `conferir-banco`, `revogar-todos`) são imitados: o banco é um arquivo de texto.
# Cada chamada fica anotada em FALSO_REGISTRO.
#
# FALSO_FALHA escolhe um defeito por vez; FALSO_NO_AR faz o servidor parecer no ar; FALSO_PAUSA
# segura o empacotamento até o arquivo indicado existir, para o teste de duas execuções juntas.
set -eu

dados=${FALSO_DADOS:?defina FALSO_DADOS}
registro=${FALSO_REGISTRO:?defina FALSO_REGISTRO}
falha=${FALSO_FALHA:-}
BANCO_DE_MENTIRA='banco de mentira'

anotar() {
  printf '%s\n' "$1" >>"$registro"
}

# Troca /data, o volume dentro do contêiner, pela pasta do teste.
no_teste() {
  printf '%s' "$1" | sed "s|/data|$dados|g"
}

esperar_a_liberacao() {
  [ -n "${FALSO_PAUSA:-}" ] || return 0
  voltas=0
  while [ ! -e "$FALSO_PAUSA" ] && [ "$voltas" -lt 300 ]; do
    sleep 0.1
    voltas=$((voltas + 1))
  done
}

[ "${1:-}" = compose ] || { echo "docker de mentira: só atende a \"compose\"" >&2; exit 125; }
shift
sub=${1:-}
[ $# -eq 0 ] || shift

# O empacotamento, na forma que o backup.sh usa: sh -c <roteiro> sh <transformação> <cópia> <pastas...>.
empacotar() {
  anotar "exec empacotar"
  esperar_a_liberacao
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
    pasta_de_dados=$dados
    while [ "${1:-}" != server ]; do
      case "$1" in
        --entrypoint)
          entrada=$2
          shift
          ;;
        -e)
          # Só AWIKA_DADOS interessa: é para onde o comando do servidor olha.
          case "$2" in AWIKA_DADOS=*) pasta_de_dados=$(no_teste "${2#AWIKA_DADOS=}") ;; esac
          shift
          ;;
      esac
      shift
    done
    shift

    faltam=$#
    while [ "$faltam" -gt 0 ]; do
      argumento=$1
      shift
      set -- "$@" "$(no_teste "$argumento")"
      faltam=$((faltam - 1))
    done

    if [ "$sub" = run ] && [ "$entrada" = sh ]; then
      # run --entrypoint sh server -c <roteiro> [sh <argumentos...>]
      case "${2:-}" in
        *'tar -C'*)
          anotar "run extrair"
          # A leitura do arquivo falha no meio de um membro, depois de o banco já ter saído.
          if [ "$falha" = extracao-interrompida ]; then head -c 1300 | sh "$@"; else sh "$@"; fi
          ;;
        *.movidos*)
          anotar "run promover"
          if [ "$falha" = promocao-em-conflito ]; then
            # Outra coisa põe uma pasta de bot no volume depois da conferência de que ele estava livre.
            mkdir -p "$dados/trabalho"
            echo "de outra origem" >"$dados/trabalho/bot1"
          fi
          sh "$@"
          ;;
        *)
          anotar "run conferir-volume"
          sh "$@"
          ;;
      esac
    elif [ "$sub" = run ] && [ "$entrada" = tar ]; then
      # A forma antiga do restaurar.sh: o tar extrai direto no volume.
      anotar "run tar"
      if [ "$falha" = extracao-interrompida ]; then head -c 1300 | tar "$@"; else tar "$@"; fi
    elif [ "$sub" = run ] && [ -n "$entrada" ]; then
      anotar "run $entrada"
      "$entrada" "$@"
    elif [ "$sub" = run ]; then
      onde=volume
      [ "$pasta_de_dados" = "$dados" ] || onde=pasta-a-parte
      case "${1:-}" in
        conferir-banco)
          anotar "run conferir-banco"
          [ "$falha" != banco-corrompido ] || { echo "O banco não passou na conferência de integridade." >&2; exit 1; }
          [ "$(cat "$2" 2>/dev/null)" = "$BANCO_DE_MENTIRA" ] || { echo "O arquivo não é um banco íntegro." >&2; exit 1; }
          echo "Banco íntegro: de mentira"
          ;;
        revogar-todos)
          if [ -e "$pasta_de_dados/awikabot.db" ]; then anotar "run revogar-todos em=$onde banco=sim"; else anotar "run revogar-todos em=$onde banco=nao"; fi
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
          # Como o servidor: nunca escreve por cima de um arquivo que já existe.
          mkdir -p "$(dirname "$4")"
          (set -C; printf '%s\n' "$BANCO_DE_MENTIRA" >"$4") 2>/dev/null || { echo "O arquivo de destino já existe; escolha um nome novo." >&2; exit 1; }
          echo "Backup gravado em $4"
          [ "$falha" = sem-sha256 ] || echo "17 bytes, sha256 $(sha256sum "$4" | cut -c1-64)"
          ;;
        # A forma antiga do backup.sh: o tar chamado direto, sem dizer com que código terminou.
        tar)
          anotar "exec empacotar"
          esperar_a_liberacao
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
