# awikabot

Gerenciador de bots: um servidor mantém agentes de IA rodando e apps de iOS e Android servem para conversar com eles e aprovar ações. Um app de desktop para Windows e Mac está em prova. O plano, as premissas e o resultado de cada etapa estão em `PLANO.md`. Licença MIT.

## Estrutura

```text
apps/server     servidor Node 24 (Hono, SQLite embutido); roda em contêiner, com o motor na imagem
apps/mobile     app Expo (iOS e Android)
apps/desktop    app de desktop em Rust com GPUI; workspace Cargo, fora do pnpm
packages/core   contratos e validação compartilhados (zod), sem framework
deploy/         compose do servidor e scripts de backup e restauração
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
- **Chamada do motor** (`apps/server/src/motor-claude-code.ts`): o texto da pessoa vai pela entrada padrão e toda opção vai na forma `--nome=valor`. Nunca passar valor vindo do app como argumento solto. O motor sempre roda com `--setting-sources=user`: o que estiver em `.claude/` ou `.mcp.json` na pasta do bot não é lido como configuração.
- **Banco**: `node:sqlite`, síncrono, num arquivo em `AWIKA_DADOS`. Migrações em `apps/server/src/banco.ts`, numeradas pela posição na lista; nunca editar uma já publicada.
- **Motor simulado** (`AWIKA_MOTOR=simulado`): só para teste e para o `pnpm verificar`. Em produção ele derruba a partida.
- **Desktop em Rust**: `apps/desktop` tem o próprio `Cargo.toml`, `Cargo.lock` e `rust-toolchain.toml`; o pnpm não enxerga essa pasta. A GPUI vem do repositório do Zed, fixada num commit, porque o crate publicado está parado: `gpui`, `gpui_platform` e o patch do `async-task` sobem juntos. A referência de uso da GPUI são os exemplos dela nesse mesmo commit.
- **Comandos do servidor**: `node dist/server.mjs servir | parear | dispositivos | revogar <id> | backup <arquivo> | saude | configuracao-do-motor`. O `parear` imprime um código de uso único. O `backup` copia o banco com o servidor no ar. O `saude` é o que o health check da imagem executa. O `configuracao-do-motor` imprime a configuração gerenciada que o build da imagem instala.

## Comandos (da raiz)

| Comando | O que faz |
|---|---|
| `pnpm install --frozen-lockfile` | instala com o lockfile congelado |
| `pnpm server` | servidor em modo de desenvolvimento |
| `pnpm server:build` | empacota o servidor em `apps/server/dist/server.mjs` |
| `pnpm mobile` | inicia o Expo |
| `pnpm lint`, `pnpm typecheck`, `pnpm test` | suíte de todos os workspaces |
| `pnpm verificar` | sobe o build de produção do servidor e percorre os fluxos do mapa |
| `pnpm --filter @awikabot/core contrato` | gera de novo o contrato em Rust do app de desktop |

Do app de desktop, de dentro de `apps/desktop`, depois de `pnpm server:build`:

| Comando | O que faz |
|---|---|
| `cargo run -p awikabot-desktop` | abre o app |
| `cargo test --workspace` | testes do cliente e da janela; sobem o servidor de verdade com o motor simulado |
| `cargo fmt --all --check` e `cargo clippy --workspace --all-targets -- -D warnings` | formatação e lint |

Todo workspace declara `lint`, `typecheck` e `test`: `pnpm -r` pula em silêncio quem não declara.

## Convenções e invariantes

- **Contrato no core**: toda mensagem entre servidor e app tem esquema em `packages/core`, usado dos dois lados. Limites, regex e enums nunca são redeclarados fora dele. O servidor tem teste que confere a resposta contra o esquema.
- **Contrato em Rust é gerado**: `apps/desktop/crates/cliente/src/contrato.rs` sai de `packages/core/src/contrato-rust.ts` e não se edita à mão. O teste do `core` falha enquanto o arquivo estiver para trás; esquema novo entra na lista desse gerador.
- **Do termIAX, só o visual**: o tema do desktop repete os valores do termIAX (`apps/desktop/crates/app/src/tema.rs`). Nenhum arquivo nem trecho de código dele entra neste repositório, que é público.
- **Cliente do desktop sem interface**: endereço do servidor, pedidos, fluxo de eventos e a regra da conversa ficam em `apps/desktop/crates/cliente`, sem GPUI, com teste. `tests/contrato.rs` roda esse cliente contra o servidor de verdade; rota ou evento novo que o desktop consome ganha um caso ali.
- **Sessão do desktop no cofre do sistema**: o token do computador fica no Gerenciador de Credenciais do Windows ou nas Chaves do macOS (`cofre_do_sistema.rs`), nunca num arquivo. A sessão só vale depois de guardada; se o cofre recusar, o token é revogado no servidor. Ao sair, o cofre é esvaziado antes de qualquer outra coisa. O que volta do cofre passa de novo pela regra do endereço.
- **Mesma regra do 401 no desktop**: todo pedido volta com a credencial que o fez; o resultado só vale se ela ainda for a da sessão atual, e só a recusa do token pelo servidor desfaz o pareamento. Resposta de proxy e servidor fora do ar mantêm a sessão.
- **Janela testada pelo teclado**: os testes de `janela.rs` digitam e apertam teclas pelo apoio de testes da GPUI, contra o servidor de verdade. O que só a tela mostra, como quebra de linha e encaixe, é conferido com `scripts/desktop-prova-visual.ps1`.
- **Ambiente validado na partida**: só `apps/server/src/env.ts` interpreta variáveis de ambiente; o `main.ts` entrega `process.env` a ele e mais ninguém o lê. Configuração inválida derruba o processo antes de atender pedidos, e a mensagem cita só o nome da variável, nunca o valor.
- **O motor não herda o ambiente do servidor**: `ambienteDoMotor`, em `env.ts`, passa só uma lista de nomes (sistema, idioma, proxy, `ANTHROPIC_*`, `CLAUDE_*`). Segredo novo no ambiente do servidor não chega aos bots sem entrar nessa lista, com teste em `env.test.ts`.
- **Loopback por padrão**: o servidor ouve em `127.0.0.1` se nada for dito. Só a imagem abre para a rede do contêiner, e o compose publica a porta só em loopback. Acesso de fora entra por túnel.
- **Contêiner sem privilégios**: usuário sem root, `cap_drop: ALL`, `no-new-privileges`, sistema de arquivos somente leitura fora do volume, rede própria com sub-rede declarada.
- **Token só na resposta do pareamento**: o banco guarda o hash do token e do código. Nenhuma rota devolve token, e nada o escreve em log.
- **Tudo em `/v1` exige token**, menos `POST /v1/parear`. Rota nova entra abaixo do middleware de autenticação em `apps/server/src/app.ts`, e o teste que lista as rotas protegidas ganha a linha dela.
- **Pareamento com trava**: cinco códigos errados bloqueiam o pareamento por dez minutos, para o servidor inteiro.
- **O motor pede, a pessoa aprova**: a decisão de uma aprovação só entra por `POST /v1/aprovacoes/:id`, com token de aparelho. O token do turno, que o gancho usa, nunca aprova nada.
- **Porta do gancho só em loopback** (`AWIKA_PORTA_GANCHO`): nunca publicar no compose nem passar pelo túnel.
- **Política de ferramentas num lugar só**: `apps/server/src/politica.ts`. Ferramenta nova ou desconhecida vai para a pessoa; só entra na lista de leitura com teste em `politica.test.ts`.
- **Gravação presa à pasta do bot**: `Write`, `Edit`, `MultiEdit` e `NotebookEdit` fora da pasta de trabalho são negadas sem cartão, e também dentro dela em `.claude/` e `.mcp.json`, que o motor leria como configuração. O cartão de gravação mostra o conteúdo, não só o nome do arquivo.
- **Gancho fora do alcance do bot**: na imagem (`AWIKA_GANCHO=gerenciado`), o gancho mora em `/etc/claude-code/managed-settings.json`, gerado no build, com `allowManagedHooksOnly`. O servidor recusa subir se o arquivo não for exatamente o esperado. Fora da imagem, o gancho vai pela opção `--settings`.
- **Gancho que falha nega**: sem servidor, sem configuração, com resposta ilegível ou sem resposta dentro do prazo do próprio gancho, a ação não roda. O prazo do gancho (`PRAZO_DO_PEDIDO_MS`) fica abaixo do que o motor dá a ele: um gancho cortado pelo motor não bloqueia a ferramenta.
- **Revogação corta o fluxo na hora**: o fluxo de eventos confere o aparelho antes de cada evento, direto no banco, então vale também para o comando `revogar`.
- **`/healthz` só diz o estado**: sem token, a resposta é `{ "status": "ok" }`. Versão e protocolo saem só na resposta do pareamento.
- **Queda não apaga o que já chegou**: o texto de uma resposta em andamento vai para o banco a cada segundo (`apps/server/src/turnos.ts`). Na partida, todo turno que ficou pela metade vira `falhou` e todo pedido de aprovação pendente expira; nada volta a rodar sozinho.
- **Parada espera os turnos**: no `SIGTERM`, o servidor para os turnos e espera até 5 segundos cada resposta ser gravada como `parada`, antes de fechar o banco.
- **Saúde passa pelo banco**: `/healthz` só responde `ok` se o banco responde; senão, `503`.
- **Vigia só na imagem**: `saude --reiniciar` mata o servidor na terceira conferência seguida sem resposta, e a política de reinício do contêiner o levanta. A opção só aparece no `HEALTHCHECK` do `Dockerfile`; sem ela, o comando só observa.
- **Backup nunca escreve por cima e nunca leva o login**: o comando `backup` recusa um destino que já existe. O `deploy/backup.sh` junta o banco, as pastas dos bots e as conversas do motor; `claude/.credentials.json` fica de fora.
- **Restauração só em volume sem dados**: o `deploy/restaurar.sh` recusa com o servidor no ar, e recusa um volume que já tem o banco, ou qualquer pasta de bot ou conversa do motor que venha no arquivo. Um arquivo com qualquer entrada além do banco, de `trabalho/` e de `claude/projects/` é recusado inteiro.
- **401 só derruba a sessão que fez o pedido**: o app captura a sessão no início do pedido e só a apaga se ela ainda for a atual, e só quando o corpo do 401 traz o código `nao_autenticado` do servidor. Um 401 de proxy ou túnel e um erro de rede nunca deslogam.
- **Cliente do app testado contra o servidor**: `apps/server/src/contrato-app.test.ts` usa a lógica de `apps/mobile/src/lib` pela rede. Rota ou evento novo que o app consome ganha um caso ali.
- **Endereço do servidor no app**: `https://` sempre, menos `localhost` e endereços de rede privada, que aceitam `http://`. A regra existe em dois lugares, no celular (`endereco-servidor.ts`) e no desktop (`endereco.rs`), e os dois testam contra a mesma tabela, `packages/core/casos/endereco-servidor.json`. Mudar a regra é mudar a tabela e os dois lados.
- **Segredos fora do Git e do banco**: `.env*` é ignorado. Nada de token, senha, endereço interno ou nome de conta em código, documento ou mensagem de commit. O repositório é público.
- **Publicação por agentes**: peça autorização explícita antes de fazer push ou abrir um PR. Com autorização, revise os commits enviados e use o gancho normal de pre-push.
- **Lógica de tela em helper puro** (`apps/mobile/src/lib`), testado com o mesmo runner do servidor.
- **Fim de linha LF** em todo o repositório (`.gitattributes`).

## Verificação

- **Mapa de fluxos**: `docs/fluxos.md`. Fluxo novo entra lá, com o teste ou escrito como "sem cobertura".
- **Runbook**: `.claude/skills/verificar/SKILL.md`. Rodar `pnpm verificar` antes de dar por concluída uma mudança que altera comportamento visto pelo usuário, e antes de um commit autorizado. Relatar o que foi exercitado e o que não foi.
- **Carimbo no commit**: a mensagem leva o trailer `Verificado-por:` com o que rodou contra aquela árvore: `suite` (lint, build, typecheck e testes), `verificar` seguido dos fluxos (`verificar F0`), `desktop` (rustfmt, clippy e testes do workspace Cargo), ou `nenhum (motivo)`. Mais de um valor, separados por vírgula. O carimbo descreve o que rodou, nunca o que deveria ter rodado. Usar `git commit --trailer "Verificado-por: suite, verificar F0"`.
- **Gancho de pre-push**: examina as alterações e mensagens dos commits com [Gitleaks](https://github.com/gitleaks/gitleaks/releases) antes de publicar e cobra o carimbo de verificação. Instale o Gitleaks (8.30.1 validado) e ative o gancho uma vez por clone:

  ```sh
  git config core.hooksPath .githooks
  ```

  O gancho procura `gitleaks` no PATH. Para indicar um executável fora do PATH, use `git config --local verificacao.gitleaksPath "caminho-do-executável"`. Se a varredura falhar ou apontar um possível segredo, o push é recusado e o valor detectado é ocultado na saída.

  O modo do carimbo fica em `git config verificacao.gate`: `observar` (padrão, só avisa), `impor` (recusa o push) ou `off`. A varredura de segredos vale nos três modos.

## Memória e retomada

A memória do projeto fica no ai-memory, no escopo do `.ai-memory.toml`. Ao concluir uma tarefa que altera código, dados, produção ou release, gravar lá uma nota de retomada: o que foi feito, commits, estado, pendências e problemas com o contorno usado. Nunca segredos, URLs de conexão, dados pessoais, saída de terminal ou payloads.

## Limitações conhecidas

- Não há aviso push: com o app fechado, um pedido de aprovação expira em 15 minutos e a ação não roda.
- Um comando de terminal aprovado roda com os direitos do contêiner: lê e grava tudo o que está no volume, inclusive o login do motor, o banco e a configuração do usuário do motor. O cartão mostra o comando inteiro, e é ele que a pessoa aprova. As travas de gravação valem para as ferramentas de arquivo, não para o terminal.
- Um bot cuja sessão do motor se perdeu não tem como começar uma conversa nova pelo app.
- Numa queda, perde-se até um segundo do texto que estava chegando, e a ação que rodava no momento pode ter ficado pela metade. A resposta aparece como falha; o bot não a refaz sozinho.
- O backup fica no host e sai sem cifra: tirar o arquivo do Pi, cifrar e agendar a rotina ainda é manual.
- Ninguém é avisado se o Pi inteiro sair do ar: a vigia mora dentro do contêiner. Um monitor de fora depende do túnel.
- O app não tem identificador de pacote nem projeto no EAS; não gera build de loja ainda. Ver `docs/decisoes.md`.
- O app não foi aberto em aparelho: telas, teclado, cofre do sistema e o fluxo de eventos no Hermes estão sem verificação. A leitura de QR no pareamento ainda não existe.
- Em build de release do Android, `http://` para a rede local é bloqueado pelo sistema; fora de desenvolvimento, o servidor precisa de HTTPS.
- Os códigos de erro (`nao_autenticado`, `codigo_invalido` e os demais) são texto solto no servidor e no app, ainda não constantes do `core`.
- O app não guarda conversas no aparelho: cada abertura busca do servidor.
- O app de desktop ainda não mostra os cartões de aprovação, só cria bot com nome automático, não para um turno, e o campo de texto não tem seleção, copiar nem desfazer. Só há tema escuro. Não há instalador, assinatura nem atualizador.
- O desktop nunca foi aberto num Mac. Lá ele compila e passa nos testes pela CI, mas a tela não foi vista por ninguém, e o teste do cofre de verdade fica desligado: o chaveiro da CI pode pedir senha.
- No desktop, a sessão que volta do cofre não confere o tamanho do token contra o contrato: um token estranho só é recusado pelo servidor.
- No desktop, cada conexão do fluxo de eventos dura no máximo um minuto e é refeita do ponto em que parou: o cliente HTTP usado não tem prazo por leitura.
