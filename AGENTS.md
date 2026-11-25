# awikabot

Gerenciador de bots: um servidor mantém agentes de IA rodando e apps de iOS e Android servem para conversar com eles e aprovar ações. Um app de desktop faz o mesmo: no Windows tem instalador assinado e publicado, desde a versão 0.1.0; no Mac ainda não tem pacote. O plano, as premissas e o resultado de cada etapa estão em `PLANO.md`. Licença MIT.

## Estrutura

```text
apps/server     servidor Node 24 (Hono, SQLite embutido); roda em contêiner, com o motor na imagem
apps/mobile     app Expo (iOS e Android)
apps/desktop    app de desktop em Rust com GPUI; workspace Cargo, fora do pnpm
packages/core   contratos e validação compartilhados (zod), sem framework
deploy/         compose do servidor e scripts de backup e restauração
docs/           mapa de fluxos e decisões que fogem do padrão
scripts/        runbook de verificação em forma de comando, e o desenho do ícone
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
- **Cargo em worktree**: num worktree, o Cargo usa a pasta de build do próprio worktree. O apoio de testes do cliente guarda, ao compilar, o caminho do pacote do servidor. Com a pasta de build de outra cópia do repositório, o Cargo dá por em dia uma biblioteca com o caminho errado, e os testes de contrato falham com "falta o pacote do servidor" quando essa cópia some. O conserto é `cargo clean -p awikabot-cliente -p awikabot-desktop`.
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
| `powershell -ExecutionPolicy Bypass -File distribuicao/windows/empacotar.ps1` | compila o executável de distribuição do Windows, confere, junta as licenças e monta o instalador; com `-Assinar <impressão digital>`, assina |
| `powershell -ExecutionPolicy Bypass -File distribuicao/windows/qa-sandbox.ps1` | confere o instalador no Windows Sandbox: instala, abre, atualiza, desinstala; com `-Anterior <pasta>`, parte também da versão publicada e atualiza para o pacote |
| `powershell -ExecutionPolicy Bypass -File distribuicao/windows/conferir-candidato.ps1` | conferências do commit de onde um pacote vai sair; grava a evidência em `relatorios/release` |
| `powershell -ExecutionPolicy Bypass -File distribuicao/windows/conferir-artefatos.ps1` | só passa um pacote que pode ser publicado: assinado, com hashes e versões batendo |
| `powershell -ExecutionPolicy Bypass -File distribuicao/windows/publicar-rascunho.ps1 -Ensaio` | confere pacote, evidências e GitHub para a publicação e não envia nada; sem `-Ensaio`, cria o release em rascunho |
| `powershell -ExecutionPolicy Bypass -File distribuicao/windows/aprovar.ps1 -Versao <x.y.z> -Ensaio` | confere o rascunho contra as evidências e não publica; sem `-Ensaio`, só o titular roda |
| `powershell -ExecutionPolicy Bypass -File distribuicao/windows/testes/testar-publicacao.ps1` | testa os dois scripts acima com um `gh` de mentira, um defeito por vez |
| `powershell -ExecutionPolicy Bypass -File distribuicao/windows/ver-atualizacao.ps1 -Anterior <pasta> -Clicar` | depois de publicar: num Windows Sandbox com rede, instala a versão anterior, abre o app, clica em "Baixar" e em "Instalar e reabrir" e diz, pelo que muda no disco e no registro, se ele se atualizou para a última versão pública. Sem `-Clicar`, os cliques são de uma pessoa. Com `-AteAConsulta`, para quando o app registra a consulta |
| `powershell -ExecutionPolicy Bypass -File distribuicao/windows/testes/testar-ver-atualizacao.ps1` | testa, sem abrir o Sandbox, o julgamento do histórico da atualização e as recusas da pasta de `-Anterior` |
| `cargo test --workspace` | testes do cliente e da janela; sobem o servidor de verdade com o motor simulado |
| `cargo fmt --all --check` e `cargo clippy --workspace --all-targets -- -D warnings` | formatação e lint |

O roteiro de release do desktop, etapa por etapa, está em `docs/release-desktop.md`.

Todo workspace declara `lint`, `typecheck` e `test`: `pnpm -r` pula em silêncio quem não declara.

## Convenções e invariantes

- **Contrato no core**: toda mensagem entre servidor e app tem esquema em `packages/core`, usado dos dois lados. Limites, regex e enums nunca são redeclarados fora dele. O servidor tem teste que confere a resposta contra o esquema.
- **Contrato em Rust é gerado**: `apps/desktop/crates/cliente/src/contrato.rs` sai de `packages/core/src/contrato-rust.ts` e não se edita à mão. O teste do `core` falha enquanto o arquivo estiver para trás; esquema novo entra na lista desse gerador.
- **Do termIAX, só o visual**: o tema escuro do desktop repete os valores do termIAX (`apps/desktop/crates/app/src/tema.rs`). Nenhum arquivo nem trecho de código dele entra neste repositório, que é público. O tema claro tem valores daqui. `tema.rs` é o único módulo com cor literal, e o teste dele confere o contraste do texto sobre cada fundo nos dois temas.
- **Cliente do desktop sem interface**: endereço do servidor, pedidos, fluxo de eventos e as regras da conversa, dos pedidos de aprovação e do formulário de bot ficam em `apps/desktop/crates/cliente`, sem GPUI, com teste. `tests/contrato.rs` roda esse cliente contra o servidor de verdade; rota ou evento novo que o desktop consome ganha um caso ali.
- **Sessão do desktop no cofre do sistema**: o token do computador fica no Gerenciador de Credenciais do Windows ou nas Chaves do macOS (`cofre_do_sistema.rs`), nunca num arquivo. A sessão só vale depois de guardada; se o cofre recusar, o token é revogado no servidor. Ao sair, o cofre é esvaziado antes de qualquer outra coisa. O que volta do cofre passa de novo pela regra do endereço.
- **Mesma regra do 401 no desktop**: todo pedido volta com a credencial que o fez; o resultado só vale se ela ainda for a da sessão atual, e só a recusa do token pelo servidor desfaz o pareamento. Resposta de proxy e servidor fora do ar mantêm a sessão.
- **Janela testada pelo teclado e pelo mouse**: os testes de `janela.rs` digitam, apertam teclas e clicam nos botões de verdade pelo apoio de testes da GPUI, contra o servidor de verdade. Botão novo ganha um nome de teste (`debug_selector`) e um teste que clica nele. O que só a tela mostra, como quebra de linha e encaixe, é conferido com `scripts/desktop-prova-visual.ps1`.
- **Uma versão do desktop, num lugar só**: `[workspace.package]` em `apps/desktop/Cargo.toml`. O `build.rs` do app a grava no executável do Windows, junto com o ícone e a descrição, e o build de distribuição para se a do executável divergir. O ícone é gerado por `apps/desktop/crates/app/recursos/gerar-icone.mjs` e versionado ao lado dele.
- **Um desenho de ícone, dois geradores**: o desenho está em `scripts/icone.mjs`, descrito por formas, e só ele sabe as medidas e as cores. O gerador do desktop grava o `.ico`; o do celular, `apps/mobile/assets/gerar-icones.mjs`, grava os PNG do iOS, as camadas do Android e a imagem de abertura. Mudou o desenho, rodam-se os dois e versiona-se o que saiu; os arquivos gerados nunca são editados à mão. A cor de fundo do ícone do Android está no `app.json` e é a mesma `FUNDO` do desenho.
- **Executável público sem rastro da máquina**: o executável que vai ser distribuído sai de `apps/desktop/distribuicao/windows/compilar.ps1`, nunca de um `cargo build` comum, que grava nele o nome de usuário de quem compilou. O script troca os caminhos da máquina por nomes neutros e confere o resultado antes de entregar. O runtime do C++ vai embutido em todo build (`apps/desktop/.cargo/config.toml`).
- **Instalador do desktop só para o usuário**: `apps/desktop/distribuicao/windows/instalador.iss` (Inno Setup) instala sem administrador, em `%LOCALAPPDATA%\Programs\awikabot`, e o atalho carrega a identidade do app. Não mexe em PATH, inicialização do Windows, firewall nem serviços. A identidade está em dois lugares, `IDENTIDADE` em `janela.rs` e no roteiro do instalador, e o QA confere que batem.
- **Inno Setup em versão fixa para o pacote publicável**: `$script:VersaoDoInnoSetup`, em `apps/desktop/distribuicao/windows/comum.ps1`. O roteiro do instalador informa a versão do compilador que o montou, o `empacotar.ps1` a grava no `build-info.json` e não assina com outra, e o `conferir-artefatos.ps1` só passa a fixada. Pacote sem assinatura, como o da CI, pode sair de outra versão. Trocar de versão é mudar esse valor.
- **Desinstalar não deixa credencial**: o desinstalador chama o app com `--esquecer-sessao`, que revoga o token por melhor esforço e esvazia o cofre, e tira o registro da identidade. Com o app aberto, ele pede para fechar antes: o app cria uma marca com o nome da identidade enquanto está aberto (`instancia.rs`).
- **Instalador se confere no Sandbox, nunca neste computador**: `qa-sandbox.ps1` roda o roteiro numa máquina descartável, sem rede, e traz um `result.json`. Os roteiros que rodam lá dentro (`qa-sandbox-dentro.ps1` e `ver-atualizacao-dentro.ps1`) instalam o app e desligam a máquina no fim: nunca são chamados direto. Mudou o instalador ou o que ele instala, roda o QA. O Smart App Control só é desligado dentro do Sandbox, a pedido, para pacote sem assinatura.
- **Licenças de terceiros no pacote, com lista de aceitas**: `apps/desktop/distribuicao/licencas-de-terceiros.mjs` junta o texto das licenças do que entra no executável e para o pacote se aparecer uma licença fora da lista. Licença nova entra na lista por decisão, não por conveniência.
- **Assinatura só à mão**: o certificado é em nuvem e pede sessão aberta no computador de quem assina; a chave nunca vai para a CI nem para o repositório. O `empacotar.ps1` recebe só a impressão digital. Pacote sem assinatura serve para o QA, nunca para publicar.
- **Quem assina o instalador é o Inno Setup, não um passo depois dele**: com `-Assinar`, o `empacotar.ps1` entrega a ferramenta de assinatura ao compilador (`SignTool` no `instalador.iss`), que assina o instalador, o desinstalador e a cópia do programa de instalação que o instalador extrai e roda. Assinar só o arquivo final deixa essas partes sem assinatura, e o Smart App Control bloqueia a instalação. Quem prova isso é o QA no Sandbox com pacote assinado e o Smart App Control ligado.
- **Atualização do desktop: consultar não baixa, baixar não instala**: `apps/desktop/crates/cliente/src/atualizacao.rs` só oferece versão maior que a do app, de release público com etiqueta `desktop-v`. O pacote só ganha o nome final depois de conferidos tamanho e SHA-256, e nenhum texto vindo da rede vira parte de um endereço. Tamanho e hash não dizem de quem o pacote é: antes de instalar, vale a assinatura.
- **A assinatura é a âncora da atualização**: `apps/desktop/crates/app/src/confianca.rs` pede ao Windows que confira a assinatura do pacote baixado, com revogação, e exige o publicador do app e a autoridade que emitiu o certificado. A assinatura diz de quem é o arquivo, não qual arquivo é: depois dela, o nome do produto e a versão gravados no pacote têm de ser os do app e os da versão oferecida, o que recusa um instalador antigo ou outro programa do mesmo publicador. O pacote que não passa é apagado. A conferência roda depois do download e de novo na hora de instalar (`atualizador.rs`). Trocar de certificado, de titular ou de autoridade pede antes uma versão que aceite os dois: quem já instalou recusaria a atualização.
- **Release do desktop em etapas amarradas**: conferências do candidato, assinatura e pacote, conferência dos artefatos, QA no Sandbox, rascunho e aprovação do titular (`docs/release-desktop.md`). Um pacote só sai de um commit sem mudança pendente. O pacote publicável é conferido pelo próprio app, com a regra do atualizador (`awikabot.exe --conferir-pacote <arquivo> <versão>`). As evidências ficam em `relatorios/release`, fora do Git e de `target/`.
- **Cada etapa do release lê a evidência da anterior**: conferência dos artefatos, QA e rascunho gravam um arquivo na pasta do commit, com o SHA-256 do que viram. O `publicar-rascunho.ps1` só sobe arquivos iguais aos conferidos, baixa o rascunho de volta e compara. O repositório e a etiqueta saem de `atualizacao.rs`, que é onde o app instalado procura. Mudou um desses scripts, roda `testes/testar-publicacao.ps1`.
- **O QA parte da última versão pública**: havendo versão pública do desktop, o `publicar-rascunho.ps1` e o `aprovar.ps1` só passam se as duas rodadas de QA partiram dela (`qa-sandbox.ps1 -Anterior`), com o instalador que está no release: o campo `anterior` da evidência é comparado, por versão e SHA-256, com o manifesto público lido do GitHub. A aprovação repete a conferência contra a última versão pública de agora.
- **Depois de publicar, a atualização é vista num app instalado**: `ver-atualizacao.ps1` abre um Sandbox com rede, instala a versão anterior publicada e tira o veredito do que muda no disco e no registro, nunca da tela. A evidência, `atualizacao-vista.json`, fica na pasta do commit da versão nova, com três capturas da janela. O julgamento do histórico e as recusas da versão anterior ficam em `comum.ps1`, com teste em `testes/testar-ver-atualizacao.ps1`; mudou o roteiro de dentro, roda o script no Sandbox.
- **O roteiro clica no painel só onde vê um botão**: com `-Clicar`, o `ver-atualizacao-dentro.ps1` clica por coordenada, com mensagens à janela, no lugar medido na tela de pareamento da versão anterior. Antes de cada clique ele olha a captura: sem uma faixa de botão ali, não clica; e só manda instalar quando a faixa é colorida, a do botão principal, porque enquanto o pacote é conferido o botão do mesmo lugar é "Cancelar". Essa regra depende de os cinzas do tema terem os três canais iguais e de só o botão principal ser colorido. Mudou a tela de pareamento ou o tema, mede-se o lugar de novo numa captura (`-AteAConsulta`) e roda-se a conferência com `-Clicar`.
- **Tornar um release público é do titular**: agente roda `aprovar.ps1` só com `-Ensaio`. Publicar cria a etiqueta e faz o app de quem já instalou avisar da versão nova; não há como recolher. Criar o rascunho também envia arquivos ao GitHub e pede autorização explícita, como um push.
- **Vulnerabilidade em dependência do desktop para o pacote**: `cargo deny check advisories sources` (`apps/desktop/deny.toml`) e `avisos-osv.mjs`, que consulta a OSV. Aviso aceito entra no arquivo com motivo e data. Dependência sem manutenção que vem por dentro da GPUI é listada e não para. Repositório Git novo como origem de dependência entra na lista do `deny.toml` por decisão.
- **O app de desenvolvimento não se atualiza nem consulta versão**: o painel de atualização só existe no build de release do Windows. A consulta é no máximo uma por dia, pode ser desligada na tela, e não leva credencial. As preferências ficam num arquivo comum, na pasta de dados do app; a sessão, nunca.
- **Texto do campo sem interface**: o que cada tecla faz com o texto (cursor, seleção, limite, desfazer) fica em `apps/desktop/crates/app/src/edicao.rs`, sem GPUI, com teste. `campo.rs` só liga teclas, mouse e área de transferência a isso e desenha. O limite conta caracteres, como o esquema do contrato.
- **Validação do bot em dois lugares**: a regra do formulário existe no celular (`formulario-bot.ts`, pelo esquema do contrato) e no desktop (`formulario_bot.rs`, à mão), e os dois testam contra a mesma tabela, `packages/core/casos/bot-entrada.json`. Mudar a regra é mudar o esquema, a tabela e o lado em Rust.
- **No desktop, a decisão é no cartão**: o cartão mostra o pedido inteiro, e só os botões dele aprovam ou negam. O aviso do sistema não leva o conteúdo do pedido nem botões: só diz qual bot espera, e o clique abre a conversa. Ele só sai com a janela fora da frente, e é recolhido quando o pedido se resolve ou a pessoa volta ao app.
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
- O app não foi aberto em aparelho: telas, teclado, cofre do sistema e o fluxo de eventos no Hermes estão sem verificação. O ícone e a abertura também não: os arquivos foram vistos, mas nenhum build os pôs num aparelho. A abertura só tem versão clara, porque o app só tem tema claro. A leitura de QR no pareamento ainda não existe.
- Em build de release do Android, `http://` para a rede local é bloqueado pelo sistema; fora de desenvolvimento, o servidor precisa de HTTPS.
- Os códigos de erro (`nao_autenticado`, `codigo_invalido` e os demais) são texto solto no servidor e no app, ainda não constantes do `core`.
- O app não guarda conversas no aparelho: cada abertura busca do servidor.
- O atualizador do desktop foi visto de ponta a ponta com um par de versões só: num Sandbox com rede, a 0.1.0 instalada avisou da 0.1.1, baixou, conferiu e instalou, primeiro com um roteiro avulso e depois com o `ver-atualizacao.ps1`, com os cliques de uma pessoa e com os do próprio roteiro. Os cliques do roteiro são por coordenada e só foram vistos com a janela de 980x680, na escala 1, no tema claro; ele clica no painel da tela de pareamento, não no da lateral da conversa. O veredito só vê o disco e o registro: sem as capturas, não distingue a rodada em que ninguém clicou da rodada em que o clique não baixou. O QA automatizado atualiza chamando o instalador como o app faz, e não exercita a consulta, o download nem a tela.
- A regra de assinatura do atualizador confere o nome do publicador e a autoridade, não a impressão digital do certificado: outra pessoa com o mesmo nome e certificado da mesma autoridade passaria. É o preço de a renovação do certificado não quebrar a atualização.
- O QA no Sandbox roda com a conta do próprio Sandbox, que é administradora: a instalação sem privilégios é conferida pelo lugar onde os arquivos e o registro ficam, não com um usuário comum. Só prova o Windows 11.
- No arquivo de licenças do desktop, 15 componentes foram publicados sem arquivo de licença no pacote; aparecem na lista com a licença declarada, sem o aviso de direitos autorais próprio. Fechar a janela encerra o app: não há ícone na bandeja, e com o app fechado não há aviso de pedido de aprovação. No macOS o aviso do sistema só é entregue a app empacotado, o que ainda não existe.
- No campo de texto do desktop, Home e End vão ao começo e ao fim do parágrafo, não da linha da tela, o cursor não pisca, e arrastar o mouse para fora do campo não rola o texto.
- O desktop nunca foi aberto num Mac. Lá ele compila e passa nos testes pela CI, mas a tela não foi vista por ninguém, e o teste do cofre de verdade fica desligado: o chaveiro da CI pode pedir senha.
- No desktop, a sessão que volta do cofre não confere o tamanho do token contra o contrato: um token estranho só é recusado pelo servidor.
- No desktop, cada conexão do fluxo de eventos dura no máximo um minuto e é refeita do ponto em que parou: o cliente HTTP usado não tem prazo por leitura.
