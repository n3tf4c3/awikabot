# Mapa de fluxos

Lista fechada do que uma pessoa consegue completar no awikabot. É a fonte das specs E2E, do runbook `verificar` e do QA de release. Fluxo sem teste fica escrito como "sem cobertura".

Levantado em 2026-11-23, na etapa 4. Os fluxos F0 a F3, o cartão de aprovação do F4 e o lado do servidor do F5 existem e foram executados pela suíte e pelo `pnpm verificar`, com o motor simulado no PC e com o motor real no Orange Pi. As telas do app para F1 a F5 existem, mas não foram abertas em aparelho: a coluna "Teste" diz o que cada teste cobre de fato. O cliente do app (a lógica em `apps/mobile/src/lib`, sem tela) é exercitado contra o servidor de verdade, pela rede, em `apps/server/src/contrato-app.test.ts`. O aviso push do F4 ainda não tem código.

| ID | Fluxo | Onde | Pré-condição | Passos | Resultado esperado | Escreve dado? | Teste |
|---|---|---|---|---|---|---|---|
| F0 | Saúde do servidor | servidor `GET /healthz` | servidor no ar | pedir `/healthz` | `200` com `status: "ok"` e mais nada; `503` se o banco não responde | não | `apps/server/src/app.test.ts` (integração sem tela) e `pnpm verificar` |
| F1 | Parear o celular | app, tela "Parear"; servidor `POST /v1/parear` | servidor no ar e código gerado pelo comando `parear` | informar "Endereço do servidor", "Código de pareamento" e "Nome deste aparelho"; acionar "Parear" | o app passa a listar os bots desse servidor; o código não vale de novo | sim | servidor: `app.test.ts` e `pnpm verificar` (integração sem tela). App: lógica em `apps/mobile/src/lib` (unidade) e `contrato-app.test.ts` (cliente contra o servidor); tela sem cobertura. Leitura de QR ainda não existe |
| F2 | Criar e editar um bot | app, lista de bots e formulário; servidor `POST` e `PATCH /v1/bots` | celular pareado | acionar "Novo bot" ou "Editar"; informar nome, instruções e modelo; acionar "Salvar" | o bot aparece na lista com os dados informados | sim | servidor: `app.test.ts` e `pnpm verificar` (integração sem tela). App: lógica em `src/lib` (unidade) e `contrato-app.test.ts` (cliente contra o servidor); tela sem cobertura |
| F3 | Conversar e parar um turno | app, conversa do bot; servidor `POST /v1/bots/:id/turnos`, `GET /v1/eventos` | bot criado e motor com login | enviar uma mensagem com "Enviar"; acionar "Parar" durante a resposta | o texto chega aos poucos; ao parar, o turno termina e o que já chegou fica guardado | sim | servidor: `app.test.ts` e `pnpm verificar` (integração sem tela, com o motor simulado; com o motor real, pelo modo descrito no runbook). App: lógica em `src/lib` (unidade) e `contrato-app.test.ts` (cliente contra o servidor, com retomada do fluxo e "Desparear"); tela sem cobertura |
| F4 | Aprovar ou negar uma ação | app, cartão de aprovação e aviso push | turno que pede uma ação | acionar "Aprovar" ou "Negar", com o app aberto e fechado | a ação só roda depois do "Aprovar"; com "Negar", não roda. Ler ou gravar fora da pasta do bot, e gravar na configuração do motor, é negado sem cartão | sim | cartão: servidor em `aprovacoes.test.ts`, `politica.test.ts` e `pnpm verificar` (integração sem tela; com o motor real, pelo modo do runbook); app: lógica em `src/lib` (unidade) e `contrato-app.test.ts`; tela sem cobertura. Aviso push ainda não existe: com o app fechado, o pedido expira em 15 minutos |
| F5 | Ver o estado depois de reiniciar | app, lista de bots e conversa | servidor reiniciado no meio de um turno | abrir o app depois da volta do servidor | o histórico aparece e o turno interrompido está marcado | não | servidor: `retomada.test.ts` e `pnpm verificar`, que mata o processo no meio de um turno e o sobe de novo (integração sem tela, motor simulado); com o motor real, pelo ensaio no host descrito no runbook. App: `retomada.test.ts` usa o cliente de `src/lib` contra um servidor que cai e volta; tela sem cobertura |

## Operação do servidor

O que quem cuida do servidor consegue completar, sem o app.

| ID | Fluxo | Onde | Pré-condição | Passos | Resultado esperado | Escreve dado? | Teste |
|---|---|---|---|---|---|---|---|
| O1 | Fazer backup e restaurar | host do servidor, `deploy/backup.sh` e `deploy/restaurar.sh`; servidor, comando `backup` | servidor no ar para o backup; servidor parado e volume sem dados para restaurar | rodar `deploy/backup.sh <pasta>`; num volume novo, rodar `deploy/restaurar.sh <arquivo>` e subir o servidor | o servidor restaurado tem os mesmos bots e conversas, o aparelho pareado continua entrando e o bot lembra da conversa | sim | comando `backup`: `backup.test.ts` e `pnpm verificar`, que restaura numa pasta nova com outro servidor (integração sem tela). Scripts do host: ensaio no host descrito no runbook, sem teste automático |
| O2 | Servidor travado volta sozinho | imagem do servidor, `HEALTHCHECK` com `saude --reiniciar` | contêiner com a política de reinício do compose | nenhum: a conferência roda a cada 30 segundos | na terceira conferência sem resposta, o servidor é derrubado e o contêiner o levanta | não | regra e comando: `saude.test.ts` e `pnpm verificar` (unidade e integração sem tela). O reinício pelo Docker: ensaio no host descrito no runbook, sem teste automático |

## App de desktop

Prova do passo 1 da etapa 6. O desktop é mais um cliente dos mesmos fluxos; só estes existem nele hoje.

| ID | No desktop | Teste |
|---|---|---|
| F1 | tela "Parear", com "Endereço do servidor", "Código de pareamento" e "Nome deste computador"; "Desparear" na lateral | cliente: `apps/desktop/crates/cliente/tests/contrato.rs` (contra o servidor). Janela: `janela.rs`, dirigida pelo teclado (sem tela). App de verdade no Windows: `scripts/desktop-prova-visual.ps1`. A sessão não é guardada: fechar o app despareia só o computador, não o servidor |
| F2 | só "Novo bot", com nome automático | cliente: `tests/contrato.rs`. Janela: `janela.rs`. Editar bot ainda não existe |
| F3 | conversa com resposta aos poucos e "Enviar" | cliente: `tests/contrato.rs` e `conversa.rs` (unidade). Janela: `janela.rs`. Parar um turno ainda não existe |
| F4 | sem tela | cliente: `tests/contrato.rs` aprova uma ação pela API. A janela não mostra o cartão: um turno que pede aprovação fica esperando até expirar |
| F5 | sem cobertura | o cliente refaz a conexão e pede nova carga, sem teste de queda do servidor |
