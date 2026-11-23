# awikabot

Gerenciador de bots: um servidor mantém agentes de IA rodando e apps de iOS e Android servem para conversar com eles e aprovar ações. O plano, as premissas e o resultado de cada etapa estão em `PLANO.md`. Licença MIT.

## Estrutura

```text
apps/server     servidor Node 24 (hoje só o health check); roda em contêiner
apps/mobile     app Expo (iOS e Android)
packages/core   contratos e validação compartilhados (zod), sem framework
deploy/         compose do servidor
docs/           mapa de fluxos e decisões que fogem do padrão
scripts/        runbook de verificação em forma de comando
spike/          provas descartáveis; não é código do produto
```

## Stack e pegadinhas

- **pnpm 12** com `nodeLinker: hoisted`. A versão exata está em `packageManager`. Nunca rodar `npm install` aqui.
- **Node 24** (`.nvmrc`), o mesmo na CI e na imagem.
- **`packages/core` exporta TypeScript de origem**, sem build. O servidor é empacotado pelo esbuild num arquivo só; o app, pelo Metro.
- **Importações relativas sem extensão**: a resolução é a de bundler em todo o repositório.
- **Uma única versão de React**: declarada no `catalog` do `pnpm-workspace.yaml`, com `react-dom` preso em `overrides`. Conferir com `pnpm why react -r` a cada upgrade do Expo SDK.
- **ESLint 9**: o `eslint-config-expo` 58 não roda no 10.
- **Dependências do app**: instalar com `pnpm exec expo install <pacote> --pnpm`, de dentro de `apps/mobile`, para pegar a versão do SDK.
- **Motor dos bots**: o binário do Claude Code sem modificação. Cada pessoa entra com a própria conta pelo fluxo do próprio Claude Code. O awikabot nunca recebe, guarda nem repassa esse login.

## Comandos (da raiz)

| Comando | O que faz |
|---|---|
| `pnpm install --frozen-lockfile` | instala com o lockfile congelado |
| `pnpm server` | servidor em modo de desenvolvimento |
| `pnpm server:build` | empacota o servidor em `apps/server/dist/server.mjs` |
| `pnpm mobile` | inicia o Expo |
| `pnpm lint`, `pnpm typecheck`, `pnpm test` | suíte de todos os workspaces |
| `pnpm verificar` | sobe o build de produção do servidor e percorre os fluxos do mapa |

Todo workspace declara `lint`, `typecheck` e `test`: `pnpm -r` pula em silêncio quem não declara.

## Convenções e invariantes

- **Contrato no core**: toda mensagem entre servidor e app tem esquema em `packages/core`, usado dos dois lados. Limites, regex e enums nunca são redeclarados fora dele. O servidor tem teste que confere a resposta contra o esquema.
- **Ambiente validado na partida**: `apps/server/src/env.ts` é o único lugar que lê `process.env`. Configuração inválida derruba o processo antes de atender pedidos, e a mensagem cita só o nome da variável, nunca o valor.
- **Loopback por padrão**: o servidor ouve em `127.0.0.1` se nada for dito. Só a imagem abre para a rede do contêiner, e o compose publica a porta só em loopback. Acesso de fora entra por túnel.
- **Contêiner sem privilégios**: usuário sem root, `cap_drop: ALL`, `no-new-privileges`, sistema de arquivos somente leitura, rede própria com sub-rede declarada.
- **Segredos fora do Git e do banco**: `.env*` é ignorado. Nada de token, senha, endereço interno ou nome de conta em código, documento ou mensagem de commit. O repositório é público.
- **Lógica de tela em helper puro** (`apps/mobile/src/lib`), testado com o mesmo runner do servidor.
- **Fim de linha LF** em todo o repositório (`.gitattributes`).

## Verificação

- **Mapa de fluxos**: `docs/fluxos.md`. Fluxo novo entra lá, com o teste ou escrito como "sem cobertura".
- **Runbook**: `.claude/skills/verificar/SKILL.md`. Rodar `pnpm verificar` antes de dar por concluída uma mudança que altera comportamento visto pelo usuário, e antes de um commit autorizado. Relatar o que foi exercitado e o que não foi.
- **Carimbo no commit**: a mensagem leva o trailer `Verificado-por:` com o que rodou contra aquela árvore: `suite` (lint, build, typecheck e testes), `verificar` seguido dos fluxos (`verificar F0`), ou `nenhum (motivo)`. Mais de um valor, separados por vírgula. O carimbo descreve o que rodou, nunca o que deveria ter rodado. Usar `git commit --trailer "Verificado-por: suite, verificar F0"`.
- **Gancho de pre-push**: cobra o carimbo dos commits enviados. Ativar uma vez por clone:

  ```sh
  git config core.hooksPath .githooks
  ```

  O modo fica em `git config verificacao.gate`: `observar` (padrão, só avisa), `impor` (recusa o push) ou `off`.

## Memória e retomada

A memória do projeto fica no ai-memory, no escopo do `.ai-memory.toml`. Ao concluir uma tarefa que altera código, dados, produção ou release, gravar lá uma nota de retomada: o que foi feito, commits, estado, pendências e problemas com o contorno usado. Nunca segredos, URLs de conexão, dados pessoais, saída de terminal ou payloads.

## Limitações conhecidas

- O servidor só tem `GET /healthz`. Os fluxos F1 a F5 do mapa ainda não existem.
- O app não tem identificador de pacote nem projeto no EAS; não gera build de loja ainda. Ver `docs/decisoes.md`.
- O app não foi aberto em aparelho na etapa 1.
