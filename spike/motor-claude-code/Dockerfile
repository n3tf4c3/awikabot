# Prova descartável da etapa 0: Claude Code sem tela num contêiner arm64.
# Não é a imagem do produto. Os scripts da prova entram por volume, não por COPY,
# para não reconstruir a imagem a cada ajuste.
FROM node:24.22.3-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.330

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force

# /data é o volume: login e conversas do Claude Code em /data/claude,
# pasta de trabalho do bot em /data/work.
RUN useradd --create-home --uid 10001 --shell /bin/bash bot \
 && mkdir -p /data/claude /data/work \
 && chown -R bot:bot /data /home/bot

ENV CLAUDE_CONFIG_DIR=/data/claude
USER bot
WORKDIR /data/work
CMD ["claude", "--version"]
