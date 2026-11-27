# Imagem do servidor do awikabot. Contexto de build: a raiz do repositório.
#   docker build -f apps/server/Dockerfile -t awikabot-server .

# A imagem base é fixada por versão e por digest: trocar os dois juntos, nas duas linhas FROM.
# O build roda na arquitetura de quem constrói: a saída é um arquivo JavaScript,
# igual para amd64 e arm64.
FROM --platform=$BUILDPLATFORM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo
RUN corepack enable

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/mobile/package.json apps/mobile/package.json
RUN pnpm install --frozen-lockfile --filter @awikabot/server...

COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/server apps/server
RUN pnpm --filter @awikabot/server build

FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

# Os motores: o Claude Code como a Anthropic publica, o Codex como a OpenAI publica e, mais abaixo,
# o Antigravity como o Google publica, cada um em versão fixa e sem modificação. O driver de cada
# um é testado contra a versão daqui.
ARG CLAUDE_CODE_VERSION=2.1.330
ARG CODEX_VERSION=0.172.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} @openai/codex@${CODEX_VERSION} \
 && npm cache clean --force \
 && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin awikabot \
 && mkdir /data \
 && chown awikabot:awikabot /data

# O Antigravity não é pacote do npm. O binário vem do endereço da versão, o mesmo que o instalador
# oficial lê no manifesto dele, e o SHA-512 de cada arquitetura é conferido aqui: trocar de versão
# é trocar o endereço e as duas somas juntos. Ele fica em /usr/local/bin, do root, onde o
# atualizador dele não consegue gravar. O motor ainda não está pronto no catálogo: só um servidor
# que o põe em AWIKA_MOTORES_EM_PROVA cria bot nele.
ARG AGY_VERSION=1.5.18-6386224290725888
ARG AGY_SHA512_AMD64=ef379ec869719112f696e8c7cfddf776618712e58fc38e53df80801d6528abb4677782c7c8778f9c09c9123fa44c2c32675d228c06f2a8f7a8f4214e75f5bb26
ARG AGY_SHA512_ARM64=6c59cbce5a7632083dd4ef594296e52ce0abdc12f8b4ecb55523e093748cf178f8f8383d7e51e9ed7859ea6e46c83a43a7b46364b0e033dd13afb24d6bfbe4c8
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) pacote="linux-x64/cli_linux_x64.tar.gz"; soma="$AGY_SHA512_AMD64" ;; \
      arm64) pacote="linux-arm/cli_linux_arm64.tar.gz"; soma="$AGY_SHA512_ARM64" ;; \
      *) echo "sem Antigravity para a arquitetura $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && node -e 'fetch(process.argv[1]).then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.arrayBuffer(); }).then((b) => require("node:fs").writeFileSync("/tmp/agy.tar.gz", Buffer.from(b)))' \
      "https://storage.googleapis.com/antigravity-public/antigravity-cli/${AGY_VERSION}/${pacote}" \
 && echo "${soma}  /tmp/agy.tar.gz" | sha512sum -c - \
 && tar -xzf /tmp/agy.tar.gz -C /tmp antigravity \
 && install -m 0755 -o root -g root /tmp/antigravity /usr/local/bin/agy \
 && rm -f /tmp/agy.tar.gz /tmp/antigravity

# /data é o volume: banco, pastas de trabalho dos bots, login e conversas de cada motor. O
# Antigravity guarda os dele em ~/.gemini, que aqui é /data/.gemini, e as pastas de sessão dos bots
# dele ficam em /data/antigravity.
# O resto do sistema de arquivos é somente leitura; a versão dos motores não muda sozinha.
ENV NODE_ENV=production \
    AWIKA_HOST=0.0.0.0 \
    AWIKA_PORTA=8790 \
    AWIKA_DADOS=/data \
    AWIKA_GANCHO=gerenciado \
    HOME=/data \
    CLAUDE_CONFIG_DIR=/data/claude \
    CODEX_HOME=/data/codex \
    DISABLE_AUTOUPDATER=1 \
    SHELL=/bin/bash

COPY --from=build /repo/apps/server/dist/server.mjs /app/server.mjs
# O gancho de aprovação fica na configuração gerenciada do motor, fora do volume: nada do que
# um bot grave consegue desligá-lo, e ganchos de outras origens ficam bloqueados.
RUN mkdir -p /etc/claude-code \
 && node /app/server.mjs configuracao-do-motor > /etc/claude-code/managed-settings.json
# A configuração do Codex mora no mesmo lugar: sem ela, o bot dele pesquisaria na web e usaria os
# conectores da conta sem cartão. Os requisitos impedem afrouxar a caixa de areia e a aprovação.
RUN mkdir -p /etc/codex \
 && node /app/server.mjs configuracao-do-codex configuracao > /etc/codex/managed_config.toml \
 && node /app/server.mjs configuracao-do-codex requisitos > /etc/codex/requirements.toml
USER awikabot
VOLUME /data
EXPOSE 8790
# A conferência de saúde também vigia: na terceira falha seguida ela derruba o servidor
# travado, e a política de reinício do contêiner o levanta de novo.
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD ["node", "/app/server.mjs", "saude", "--reiniciar"]
ENTRYPOINT ["node", "/app/server.mjs"]
CMD ["servir"]
