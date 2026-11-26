# Prova descartável do passo 1 da etapa 7: Codex e Antigravity sem tela num contêiner.
# Não é a imagem do produto. Os scripts da prova entram por volume, não por COPY.
FROM node:24.22.3-bookworm-slim

ARG CODEX_VERSION=0.172.0
# O Claude Code entra só para a pergunta do orquestrador, na versão da imagem do produto.
ARG CLAUDE_CODE_VERSION=2.1.330

# bubblewrap é o que o Codex usa para a caixa de areia no Linux; procps serve à medição.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git curl bubblewrap procps \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @openai/codex@${CODEX_VERSION} @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force

# O instalador do Antigravity não aceita versão: baixa a que o manifesto do dia aponta e confere
# o SHA-512. O binário fica em /usr/local/bin, do root, para a prova ver se ele se atualiza sozinho
# mesmo sem poder gravar ali.
RUN curl -fsSL https://antigravity.google/cli/install.sh -o /tmp/instalar-agy.sh \
 && HOME=/tmp/agy-instalacao bash /tmp/instalar-agy.sh --dir /usr/local/bin \
 && rm -rf /tmp/instalar-agy.sh /tmp/agy-instalacao \
 && sha256sum /usr/local/bin/agy > /etc/agy.sha256

# /data é o volume. Cada CLI guarda login e conversas num lugar próprio dele: o Codex em
# CODEX_HOME, o Antigravity em ~/.gemini, o Claude Code em CLAUDE_CONFIG_DIR. A pasta de trabalho
# do bot é /data/work.
RUN useradd --create-home --uid 10001 --shell /bin/bash bot \
 && mkdir -p /data/codex /data/claude /data/home /data/work /data/fora /data/registros \
 && chown -R bot:bot /data

ENV HOME=/data/home \
    CODEX_HOME=/data/codex \
    CLAUDE_CONFIG_DIR=/data/claude
USER bot
WORKDIR /data/work
CMD ["sh", "-c", "codex --version; agy --version; claude --version"]
