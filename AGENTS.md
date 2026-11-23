# awikabot

Gerenciador de bots: um servidor mantém agentes de IA rodando e apps de iOS e Android servem para conversar com eles e aprovar ações. O plano, as premissas e o resultado de cada etapa estão em `PLANO.md`. Licença MIT.

## Estrutura

```text
apps/server     servidor Node 24 (Hono, SQLite embutido); roda em contêiner, com o motor na imagem
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
- **Chamada do motor** (`apps/server/src/motor-claude-code.ts`): o texto da pessoa vai pela entrada padrão e toda opção vai na forma `--nome=valor`. Nunca passar valor vindo do app como argumento solto.
- **Banco**: `node:sqlite`, síncrono, num arquivo em `AWIKA_DADOS`. Migrações em `apps/server/src/banco.ts`, numeradas pela posição na lista; nunca editar uma já publicada.
- **Motor simulado** (`AWIKA_MOTOR=simulado`): só para teste e para o `pnpm verificar`. Em produção ele derruba a partida.
- **Comandos do servidor**: `node dist/server.mjs servir | parear | dispositivos | revogar <id>`. O `parear` imprime um código de uso único.

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
- **Contêiner sem privilégios**: usuário sem root, `cap_drop: ALL`, `no-new-privileges`, sistema de arquivos somente leitura fora do volume, rede própria com sub-rede declarada.
- **Token só na resposta do pareamento**: o banco guarda o hash do token e do código. Nenhuma rota devolve token, e nada o escreve em log.
- **Tudo em `/v1` exige token**, menos `POST /v1/parear`. Rota nova entra abaixo do middleware de autenticação em `apps/server/src/app.ts`, e o teste que lista as rotas protegidas ganha a linha dela.
- **Pareamento com trava**: cinco códigos errados bloqueiam o pareamento por dez minutos, para o servidor inteiro.
- **401 só derruba a sessão que fez o pedido**: o app captura a sessão no início do pedido e só a apaga se ela ainda for a atual, e só quando o corpo do 401 traz o código `nao_autenticado` do servidor. Um 401 de proxy ou túnel e um erro de rede nunca deslogam.
- **Cliente do app testado contra o servidor**: `apps/server/src/contrato-app.test.ts` usa a lógica de `apps/mobile/src/lib` pela rede. Rota ou evento novo que o app consome ganha um caso ali.
- **Endereço do servidor no app**: `https://` sempre, menos `localhost` e endereços de rede privada, que aceitam `http://`.
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

- Os bots só conversam: o motor nega toda ação que pede aprovação até os cartões de aprovação existirem (F4).
- Um bot cuja sessão do motor se perdeu não tem como começar uma conversa nova pelo app.
- O servidor guarda só o texto final de cada resposta; os trechos intermediários vivem na memória do processo.
- O app não tem identificador de pacote nem projeto no EAS; não gera build de loja ainda. Ver `docs/decisoes.md`.
- O app não foi aberto em aparelho: telas, teclado, cofre do sistema e o fluxo de eventos no Hermes estão sem verificação. A leitura de QR no pareamento ainda não existe.
- Em build de release do Android, `http://` para a rede local é bloqueado pelo sistema; fora de desenvolvimento, o servidor precisa de HTTPS.
- Os códigos de erro (`nao_autenticado`, `codigo_invalido` e os demais) são texto solto no servidor e no app, ainda não constantes do `core`.
- O app não guarda conversas no aparelho: cada abertura busca do servidor.
