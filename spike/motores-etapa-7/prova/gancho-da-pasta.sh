#!/bin/sh
# Planta configuração executável do Antigravity numa pasta e confere, depois de um turno, se ela
# rodou. Um gancho ou um servidor MCP ali é um comando que roda sem aprovação.
#
#   sh gancho-da-pasta.sh plantar [pasta] [nome]       gancho em <pasta>/<nome>/hooks.json
#   sh gancho-da-pasta.sh plantar-mcp [pasta] [nome]   servidor MCP em <pasta>/<nome>/mcp_config.json
#   sh gancho-da-pasta.sh plantar-tudo [pasta] [nome]  os dois
#   sh gancho-da-pasta.sh conferir [pasta] [nome]      diz o que rodou e tira o que foi plantado
#
# A pasta padrão é /data/work e o nome padrão é .agents. As marcas ficam em /data/registros.
set -eu
PASTA="${2:-/data/work}"
NOME="${3:-.agents}"
ALVO="$PASTA/$NOME"
MARCA_GANCHO=/data/registros/gancho-da-pasta-rodou.txt
MARCA_MCP=/data/registros/mcp-da-pasta-rodou.txt
case "${1:-}" in
  plantar)
    mkdir -p "$ALVO" /data/registros
    rm -f "$MARCA_GANCHO"
    cat > "$ALVO/hooks.json" <<EOF
{"hooks":{"PreToolUse":[{"matcher":".*","hooks":[{"type":"command","command":"sh -c \"echo rodou > $MARCA_GANCHO\"","timeout":10}]}]}}
EOF
    ;;
  plantar-mcp)
    mkdir -p "$ALVO" /data/registros
    rm -f "$MARCA_MCP"
    cat > "$ALVO/mcp_config.json" <<EOF
{"mcpServers":{"plantado":{"command":"sh","args":["-c","echo rodou > $MARCA_MCP; sleep 3"]}}}
EOF
    ;;
  plantar-tudo)
    sh "$0" plantar "$PASTA" "$NOME"
    sh "$0" plantar-mcp "$PASTA" "$NOME"
    ;;
  conferir)
    if [ -f "$MARCA_GANCHO" ]; then echo "GANCHO DA PASTA RODOU"; else echo "gancho da pasta não rodou"; fi
    if [ -f "$MARCA_MCP" ]; then echo "SERVIDOR MCP DA PASTA RODOU"; else echo "servidor MCP da pasta não rodou"; fi
    rm -f "$MARCA_GANCHO" "$MARCA_MCP" "$ALVO/hooks.json" "$ALVO/mcp_config.json"
    rmdir "$ALVO" 2>/dev/null || true
    ;;
  *)
    echo "uso: sh gancho-da-pasta.sh plantar|plantar-mcp|plantar-tudo|conferir [pasta] [nome]" >&2
    exit 64
    ;;
esac
