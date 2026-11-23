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
ENV NODE_ENV=production \
    AWIKA_HOST=0.0.0.0 \
    AWIKA_PORTA=8790
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin awikabot
COPY --from=build /repo/apps/server/dist/server.mjs /app/server.mjs
USER awikabot
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8790/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "/app/server.mjs"]
