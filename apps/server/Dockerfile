# Imagem do servidor do awikabot. Contexto de build: a raiz do repositório.
#   docker build -f apps/server/Dockerfile -t awikabot-server .

# O build roda na arquitetura de quem constrói: a saída é um arquivo JavaScript,
# igual para amd64 e arm64.
FROM --platform=$BUILDPLATFORM node:24.22.3-bookworm-slim AS build
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

FROM node:24.22.3-bookworm-slim

# O motor: o Claude Code como a Anthropic publica, em versão fixa e sem modificação.
ARG CLAUDE_CODE_VERSION=2.1.330
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force \
 && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin awikabot \
 && mkdir /data \
 && chown awikabot:awikabot /data

# /data é o volume: banco, pastas de trabalho dos bots, login e conversas do motor.
# O resto do sistema de arquivos é somente leitura; a versão do motor não muda sozinha.
ENV NODE_ENV=production \
    AWIKA_HOST=0.0.0.0 \
    AWIKA_PORTA=8790 \
    AWIKA_DADOS=/data \
    HOME=/data \
    CLAUDE_CONFIG_DIR=/data/claude \
    DISABLE_AUTOUPDATER=1 \
    SHELL=/bin/bash

COPY --from=build /repo/apps/server/dist/server.mjs /app/server.mjs
USER awikabot
VOLUME /data
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8790/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["node", "/app/server.mjs"]
CMD ["servir"]
