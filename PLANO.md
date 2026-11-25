# awikabot — plano

Situação em 2026-11-23. Repositório: `github.com/n3tf4c3/awikabot`, público. A etapa 0 passou: o Claude Code serve de primeiro motor. A etapa 1 está na `main`, com a CI aprovada. Na etapa 2, o servidor foi validado com o motor real no Pi e o cliente do app passa contra o servidor; faltam abrir o app em aparelho e o túnel. Na etapa 3, os cartões de aprovação estão validados com o motor real no Pi; falta o aviso push. As medições estão nas seções de resultado de cada etapa.

## Decisão

Produto nosso, escrito do zero e em MIT: um servidor que roda no Orange Pi e os apps de iOS e Android. O OpenMausBot serve de referência de ideias. Nenhum código dele entra no repositório, e assim tudo fica em MIT, sem trecho em Apache-2.0. Colaboração com HaroldoYoshida.

## Premissas

Assumidas para o plano andar; cada uma pode ser trocada.

| Premissa | Por quê | O que muda se for diferente |
|---|---|---|
| Um servidor só, no Orange Pi 5 (arm64, 8 GB, Docker), dividido com os serviços que já rodam lá. | Pedido: "vai rodar no nosso Orange Pi". | Com VPS, some o limite de memória e entra custo mensal. |
| O primeiro motor é a CLI do Claude Code, sem modificação, dirigida pelo modo sem tela e pelos ganchos dela. | Escolha de 23/11. Os termos permitem a própria assinatura no binário sem modificação; o Agent SDK pede chave de API. | Com chave de API o mesmo motor serve, e o custo vira por uso. |
| Cada bot roda com o login de uma pessoa, que é a dona dele. O awikabot nunca recebe nem guarda esse login. | Os termos proíbem usar a assinatura de uma pessoa em nome de outra e proíbem que um app de terceiros guarde ou repasse o login. | Bots compartilhados entre pessoas usam chave de API. |
| Acesso de fora pelo túnel Cloudflare que o Pi já usa, com HTTPS. | Sem porta aberta e sem conta de terceiros. | Com Tailscale, cada celular precisa do cliente de VPN. |
| Apps distribuídos por TestFlight e teste interno da Play no começo. | Uso nosso primeiro. | Loja pública pede política de privacidade, página de exclusão de conta e revisão. |
| TypeScript de ponta a ponta, monorepo pnpm, app em Expo. | Um código só para iOS e Android, e os tipos do protocolo valem dos dois lados. | — |

## Ideias aproveitadas e o que melhora

Do OpenMausBot ficam as ideias:

- bots como contatos numa lista de conversas;
- um fluxo único de eventos em streaming, que o app retoma de onde parou;
- cartões de aprovação: o bot pergunta antes de agir;
- pareamento por QR com um token por aparelho, do qual o servidor guarda só o hash;
- lista de rotas permitidas para o celular, negando o resto por padrão;
- aviso push sem o texto da conversa.

O nosso melhora em:

- push com o app fechado desde a primeira versão (lá está escrito e desligado);
- apps de código aberto (os deles são fechados);
- servidor enxuto, feito para o Pi: sem Electron, sem máquina virtual, sem nuvem de terceiros;
- nenhuma conta nem relay de terceiros para usar de fora de casa;
- volta sozinho depois de queda de energia, com os turnos interrompidos marcados.

## Primeira versão

Cinco fluxos, cada um conferido no aparelho:

1. Parear o celular com o servidor por QR ou código.
2. Criar e editar um bot: nome, instruções, motor e modelo, pasta de trabalho.
3. Conversar com o bot com resposta em streaming, e parar um turno.
4. Aprovar ou negar uma ação pelo celular, com aviso push mesmo com o app fechado.
5. Ver o que está rodando e o histórico depois de o servidor reiniciar.

Fica fora da primeira versão: app web, computador ou VM para o bot, apps conectados (Gmail, Slack), voz, salas com vários bots, importação de times e temas. Rotinas agendadas e webhooks são as candidatas à segunda versão. O app de desktop para Windows e Mac, pedido em 23/11, está planejado como etapa 6, sem data.

## Arquitetura

```text
celular (Expo) ── HTTPS + SSE ──▶ túnel Cloudflare ──▶ servidor (contêiner no Pi)
                                                        ├─ API e fluxo de eventos
                                                        ├─ motores: CLIs de agente
                                                        ├─ SQLite num volume
                                                        └─ push ──▶ Expo Push ──▶ Apple / Google
```

Três pacotes, cada um ligado a um requisito:

| Pacote | O que é | Requisito |
|---|---|---|
| `apps/server` | Node 24. Dono dos processos das CLIs, API HTTP, fluxo de eventos, SQLite e fila de turnos com limite de simultâneos. | Rodar no Orange Pi. |
| `apps/mobile` | Expo, iOS e Android. Guarda as conversas em cache para abrir na hora. | Apps para gerenciar; sensação ágil. |
| `packages/core` | Tipos e validação das mensagens trocadas. | Servidor e app evoluem juntos sem divergir. |

O servidor não segue o padrão Next.js, Vercel e Neon dos outros projetos porque precisa manter processos de agente vivos e arquivos locais no Pi, o que uma plataforma serverless não faz.

O push sai pelo serviço da Expo, que entrega à Apple e ao Google. Assim o Pi não guarda chaves das lojas. Só trafegam nomes, como "Fulano precisa de aprovação".

## Segurança por desenho

Um bot executa comandos, então o servidor equivale a um terminal remoto no Pi.

- O contêiner roda sem root, enxerga só a pasta de trabalho dos bots e fica numa rede Docker separada dos outros serviços.
- O modo padrão de um bot é perguntar antes de executar.
- Nada é exposto além do túnel.
- O token de cada aparelho é revogável; o código de pareamento vale uma vez e por poucos minutos.
- Segredos ficam fora do banco e do Git.

## Etapas

0. Concluída em 23/11. Prova do motor no Pi, com código descartável. Rodar a CLI em modo não interativo num contêiner arm64.
   Verificar: a resposta sai em eventos; um comando gera pedido de permissão que um programa de fora responde; a conversa é retomada depois de reiniciar o contêiner; a memória usada por turno é medida. Sai daqui o primeiro motor e o limite de turnos simultâneos.
1. Esqueleto: monorepo com os três pacotes, CI e imagem arm64.
   Verificar: typecheck, lint, testes e build passam; o contêiner sobe no Pi e responde ao health check; o app abre no iPhone e no Android.
2. Protocolo e conversa: pareamento, bots e turno com streaming.
   Verificar: fluxos 1 a 3 no aparelho, passando pelo túnel.
3. Aprovações e push.
   Verificar: fluxo 4 com o app fechado e o celular bloqueado.
4. Concluída em 23/11, no lado do servidor. Robustez no Pi: retomada depois de queda, backup do banco e health check vigiado.
   Verificar: derrubar o contêiner no meio de um turno e conferir o fluxo 5 na volta; restaurar o backup num ambiente descartável.
5. Revisão de segurança e distribuição por TestFlight e teste interno da Play.
6. App de desktop para Windows e Mac, em Rust com GPUI. No Windows, as versões 0.1.0 e 0.1.1 foram publicadas em 24 e 25/11; o Mac ainda não tem pacote. Ver "Etapa 6: plano do app de desktop".
   Verificar: os fluxos 1 a 5 percorridos no Windows e num Mac, com o app instalado pelo pacote assinado.

## Etapa 0: resultado (2026-11-23)

Rodada no Orange Pi com o kit de `spike/motor-claude-code`, o Claude Code 2.1.330 e o login da assinatura de uma pessoa.

| Verificação | Resultado |
|---|---|
| Imagem arm64, usuário sem root | Constrói no Pi em 62 s; 1,05 GB. |
| Resposta em eventos | Passa. Com o motor aquecido, o primeiro evento chega em cerca de 1 s e o primeiro texto em 1,7 a 2 s. Na primeira chamada foram 2,5 s e 3,2 s. |
| Aprovação respondida por um programa de fora | Passa. O gancho esperou 20 s e depois 180 s, e o comando só rodou depois do "aprovar". |
| Negação | Passa. Com "negar", o comando não rodou. |
| Retomada em contêiner novo | Passa. A conversa voltou pelo id da sessão, guardada no volume. |
| Memória por turno | Pico de 250 a 290 MB no contêiner. Somando os processos do motor, o maior pico foi 405 MB. |
| Isolamento de rede do contêiner | Sem acesso ao roteador, ao host e à rede de outro serviço; internet liberada. |

O que sai daqui:

- A aprovação entra pelo gancho `PreToolUse` do Claude Code, que consulta o servidor e espera a resposta.
- Limite inicial de 4 turnos simultâneos, cerca de 1,6 GB no pior caso medido. Ajustar com uso real.

Não coberto pela prova:

- espera acima de 10 minutos, que é o limite padrão de um gancho segundo a documentação (a prova configurou 15 minutos e exercitou 3);
- a decisão de adiar (`defer`), em que o processo sai e a conversa é retomada quando a resposta chegar; é o caminho para o app fechado por horas;
- vários turnos no mesmo processo e turnos simultâneos.

## Etapa 1: resultado (2026-11-23)

Monorepo pnpm com `apps/server`, `apps/mobile` e `packages/core`, CI, imagem do servidor, mapa de fluxos e runbook de verificação. O que foge do padrão da casa está em `docs/decisoes.md`.

| Verificação | Resultado |
|---|---|
| Lint, build do servidor, typecheck e testes | Passam, também numa cópia limpa com o lockfile congelado. São 24 testes. |
| Runbook `pnpm verificar` | Duas execuções com o mesmo resultado, em 0,4 s, e uma quebra de propósito acusada. |
| Imagem do servidor | Constrói para arm64; no Pi, em 18 s. |
| Contêiner no Pi | Respondeu ao health check e ficou saudável, sem root, com 26 MB, porta só em loopback e sistema de arquivos somente leitura. Foi removido depois do teste. |
| App | `expo-doctor` passou nas 20 checagens, e o pacote JavaScript exporta para Android e iOS com o `core` dentro. |
| App aberto no iPhone e no Android | Pendente: precisa de aparelho. |
| CI no GitHub | Pendente: roda quando a branch for enviada. |

## Etapa 2: resultado do servidor (2026-11-23)

O servidor ganhou pareamento, autenticação por aparelho, bots, turnos e o fluxo de eventos, sobre Hono e o SQLite embutido do Node. A imagem passou a levar o Claude Code em versão fixa. As decisões estão em `docs/decisoes.md`.

| Verificação | Resultado |
|---|---|
| Testes do servidor | 51 testes: pareamento, autenticação em todas as rotas, bots, turnos, paginação e o fluxo de eventos pela rede. |
| Falsificação | Com a autenticação desligada de propósito, 5 testes e o runbook acusaram. |
| `pnpm verificar`, motor simulado | 9 de 9 verificações, nos fluxos F0 a F3, em duas execuções iguais. |
| `pnpm verificar`, motor real no Pi | 9 de 9. O primeiro trecho da resposta chegou em 3,4 s, o bot lembrou do turno anterior e a parada funcionou. Pico de 243 MB no contêiner. |
| Imagem com o motor | Constrói no Pi em 66 s; 1,05 GB. |

Depois desse teste, o contrato ganhou a posição de cada trecho de texto, o ponto de retomada no primeiro sinal de vida e a rota de "Desparear". Com tudo na `main` (`eba9b1a`), o runbook passou de novo no Pi com o motor real, 9 de 9, com o primeiro trecho em 3,5 s e pico de 250 MB. As três peças novas foram conferidas lá:

- o ponto de retomada chega no primeiro sinal de vida;
- a resposta em andamento sai com o texto parcial, e os trechos vêm com a posição em sequência e somam o texto final;
- depois de "Desparear", o mesmo token é recusado.

## Etapa 2: resultado do app (2026-11-23)

Telas de pareamento, lista de bots, formulário de bot e conversa, com a lógica separada em `apps/mobile/src/lib`.

| Verificação | Resultado |
|---|---|
| Testes do app | 391 testes da lógica: cliente da API, leitura do fluxo de eventos, junção dos trechos de texto, sessão e validação do endereço do servidor. |
| Cliente do app contra o servidor | 4 cenários pela rede, em `apps/server/src/contrato-app.test.ts`: parear, criar e editar bot, conversar e parar, retomar o fluxo sem recarregar tudo, e "Desparear". |
| Revisão de leitura | Confirmou o cuidado com o token e a regra do 401. Os defeitos que achou foram corrigidos: texto perdido ao abrir a conversa no meio de um turno, sessão apagada por qualquer 401 e reconexão sem freio. |
| Expo | `expo-doctor` passou nas 20 checagens, e o pacote JavaScript exporta para Android e iOS. |
| Telas em aparelho | Pendente. Nenhuma tela foi aberta em iPhone, Android ou emulador. |

Não coberto na etapa 2:

- o caminho pelo túnel: o teste no Pi foi pela porta em loopback;
- o app em aparelho, que é o critério da etapa;
- a leitura de QR no pareamento;
- executar ações: o motor nega tudo o que pede aprovação até a etapa 3.

## Etapa 3: resultado dos cartões de aprovação (2026-11-23)

A etapa foi dividida: os cartões de aprovação entraram agora, e o aviso push fica para quando houver projeto na conta Expo e build em aparelho.

O bot passa a executar ações. Antes de cada ferramenta, o gancho do Claude Code pergunta ao servidor. Ler dentro da pasta do bot passa; ler fora dela é negado; todo o resto vira um cartão no app, e a ação só roda depois de "Aprovar".

| Verificação | Resultado |
|---|---|
| Testes | 32 no `core`, 98 no servidor e 460 no app. |
| Falsificação | Com a política liberando tudo de propósito, 28 testes e 3 verificações do runbook acusaram. |
| `pnpm verificar`, motor simulado | 13 de 13, nos fluxos F0 a F4, em duas execuções iguais. |
| `pnpm verificar`, motor real no Pi | 12 de 12, em duas execuções. O comando aprovado criou o arquivo e o negado não, conferido no disco. A leitura do login do motor foi negada sem cartão. Pico de 258 MB. |
| Cliente do app contra o servidor | O pedido chega pelo fluxo de eventos, a decisão vai pela API, e a segunda decisão é recusada. |

Não coberto:

- o aviso push e a espera acima de 15 minutos;
- os cartões em aparelho: nenhuma tela foi aberta;
- o acesso pelo túnel.

## Etapa 4: resultado (2026-11-23)

O servidor passa a aguentar queda, travamento e perda do volume. Nada mudou no contrato com o app: uma resposta interrompida usa o estado `falhou`, que já existia.

- **Queda**: o texto de uma resposta em andamento vai para o banco a cada segundo. Na volta, o turno interrompido aparece como falha com o que já tinha chegado, os pedidos de aprovação pendentes expiram e o bot aceita um turno novo. Numa parada normal, o servidor espera os turnos fecharem.
- **Saúde vigiada**: `/healthz` passa pelo banco. A conferência da imagem derruba o servidor na terceira falha seguida, e o contêiner o levanta.
- **Backup**: o comando `backup` copia o banco com o servidor no ar. O `deploy/backup.sh` junta o banco, as pastas dos bots e as conversas do motor num arquivo, sem o login. O `deploy/restaurar.sh` só restaura num volume sem esses dados.

| Verificação | Resultado |
|---|---|
| Testes | 32 no `core`, 122 no servidor e 460 no app. |
| Falsificação | Cinco quebras de propósito, uma por vez: partida sem marcar os turnos, sem gravação do texto em andamento, parada sem esperar, saúde sem tocar o banco e backup sem recusar destino existente. Todas foram acusadas, pelos testes ou pelo runbook. A da parada só foi acusada depois de o teste ser endurecido. |
| `pnpm verificar`, motor simulado | 21 de 21, em duas execuções iguais. Inclui matar o processo no meio de um turno e restaurar o backup numa pasta nova, com outro servidor. |
| `pnpm verificar`, motor real no Pi | 12 de 12, nos fluxos F0 a F4, com a imagem desta etapa. |
| Queda no Pi, motor real | Servidor morto no meio de um turno: o contêiner voltou em 2 segundos, a resposta interrompida ficou como falha com 551 caracteres guardados, e no turno seguinte o bot lembrou do número pedido antes da queda. |
| Vigia no Pi | Servidor travado de propósito: derrubado e de volta em 101 segundos, sem ninguém intervir. O aparelho pareado continuou entrando. |
| Turnos simultâneos no Pi, motor real | Quatro turnos ao mesmo tempo: pico de 681 MiB no contêiner, lido a cada poucos segundos, contra o limite de 2 GB. O quinto foi recusado pelo teto. |
| Backup e restauração no Pi | Arquivo de 4,9 MB com 57 entradas e nenhuma do login. Num volume novo, em outro projeto: os mesmos 8 bots e conversas idênticas, com o token do mesmo aparelho. Restaurar com o servidor no ar e num volume com dados foi recusado. |
| Memória do bot depois de restaurar | Dados do ensaio apagados do volume e restaurados do arquivo: o bot respondeu o número pedido no começo da conversa. |

Não coberto:

- queda de energia do Pi inteiro: o ensaio matou o processo, não desligou a placa;
- para onde o backup vai, a cifra dele e a rotina agendada: o script grava numa pasta do host;
- aviso para fora quando o Pi some: a vigia mora dentro do contêiner;
- o fluxo F5 no aparelho: nenhuma tela foi aberta;
- um bot cuja conversa do motor se perdeu continua sem saída pelo app.

## Etapa 5: resultado da revisão de segurança (2026-11-23)

A distribuição por TestFlight e pela Play ainda não começou. A revisão de segurança foi feita e os achados, corrigidos.

A conferência estática contra a lista de quesitos da casa encontrou oito achados: um de severidade alta, um de média e seis de baixa. O registro numerado está em `docs/auditoria-achados.md`.

- **O mais grave**: aprovar uma gravação aprovava qualquer caminho e conteúdo, e o motor lia configuração na pasta do bot. Com o motor real, um arquivo plantado ali rodou um comando no turno seguinte, sem cartão. Agora a gravação fica presa à pasta do bot, o cartão mostra o conteúdo, o motor não lê a configuração da pasta e o gancho mora na parte somente leitura da imagem.
- **Aparelho revogado**: o fluxo de eventos é cortado no evento seguinte, e não só no silêncio.
- **Os de severidade baixa**: ambiente do motor por lista de nomes, cabeçalhos de segurança, `/healthz` sem versão, imagem base por digest, log sem a saída do motor e restauração que recusa arquivo com entrada estranha.

| Verificação | Resultado |
|---|---|
| Testes | 36 no `core`, 216 no servidor e 460 no app. |
| Falsificação | Oito quebras de propósito, uma por vez, todas acusadas. |
| `pnpm verificar`, motor simulado | 23 de 23, em duas execuções iguais. |
| `pnpm verificar`, motor real no Pi | 14 de 14, com o gancho na configuração gerenciada. |
| Configuração plantada na pasta do bot, motor real | Antes da correção, rodou um comando sem aprovação. Depois, não teve efeito, com cada barreira sozinha e com as duas. |
| Backup adulterado no Pi | Recusado sem criar volume; o backup bom restaurou com conversas idênticas. |

Não coberto:

- um comando de terminal aprovado continua alcançando o volume inteiro; a proteção é a pessoa ler o comando no cartão;
- as decisões que a revisão deixou registradas: `http://` na rede local, token de aparelho sem validade, aprovação sem biometria, assinatura das atualizações do app e saída de rede do contêiner;
- o gate de publicação sobre o commit final, e o teste dinâmico das rotas de pareamento e aprovação.

## Etapa 6: plano do app de desktop (2026-11-23)

Pedido do titular: versão para Windows e Mac, em Rust, com o design do termIAX. Os passos 1 a 3 estão feitos; o resultado de cada um vem depois do plano.

### Premissas

| Premissa | Base |
|---|---|
| Rust com GPUI, como o termIAX. | O termIAX já resolveu, para Windows, o tema, os componentes de base, o empacotamento, a assinatura, o atualizador e o QA no Windows Sandbox. Uma segunda tecnologia de desktop abriria tudo isso de novo. |
| O app de desktop é mais um cliente do mesmo servidor. | Mesmo pareamento por código, mesmas rotas e mesmo fluxo de eventos do app de celular. O servidor não muda. |
| O código fica em `apps/desktop`, como um workspace Cargo dentro deste repositório. | Um repositório só, com a CI conferindo os três lados do contrato. O pnpm não enxerga essa pasta. |
| A primeira versão faz o que o app de celular faz, mais o aviso do sistema para pedido de aprovação. | Parear, bots, conversa e cartão de aprovação. Com o app na bandeja, o aviso do sistema cobre no computador o que o aviso push cobriria no celular. |

### O que vem do termIAX

Decisão do titular em 23/11: vem só o visual. O termIAX é proprietário e privado, e nenhum arquivo dele entra neste repositório.

- **Vem**: os valores do tema, claro e escuro (cores, fontes e espaçamentos), a aparência dos componentes, e o que o termIAX ensinou sobre o processo: o roteiro de release em etapas, a assinatura e o QA no Windows Sandbox.
- **É escrito aqui, do zero**: os componentes de base (botão, campo de texto, área de texto), a leitura do fluxo de eventos, o aviso do sistema, a lista de conversa e o cartão de aprovação, os scripts de empacotamento e tudo de macOS. O termIAX é só Windows; a versão de Mac dele está em espera por falta de Mac.

### Contrato

Os esquemas ficam no `core`, em zod, e a regra do projeto é não redeclarar limite nem enum fora dele. Para o cliente em Rust:

1. o `core` gera os tipos em Rust direto dos esquemas, num arquivo versionado, com um teste que falha se o arquivo estiver desatualizado;
2. um teste de contrato roda o cliente Rust contra o servidor de verdade, com o motor simulado, na CI. É o papel que o `contrato-app.test.ts` cumpre para o app de celular.

O plano original passava por um JSON Schema intermediário e gerava os tipos no build. Na prova, gerar o arquivo Rust direto ficou mais simples e dispensou uma dependência no build.

### Passos

1. **Prova**: uma janela que pareia e mostra uma conversa com resposta aos poucos.
   Verificar: compila no Windows e no macOS na CI; teste de contrato verde.
2. **Cliente**: sessão no cofre do sistema, regra do 401, retomada do fluxo de eventos.
   Verificar: os mesmos casos de sessão e de fluxo que `apps/mobile/src/lib` testa, contra o servidor.
3. **Telas**: parear, bots, conversa, cartão de aprovação e aviso do sistema.
   Verificar: fluxos 1 a 5 percorridos no Windows.
4. **Distribuição no Windows**: pacote, assinatura e atualizador, pelo roteiro do termIAX.
   Verificar: instalar, atualizar e desinstalar no Windows Sandbox.
5. **macOS**: build, pacote, assinatura e notarização.
   Verificar: fluxos 1 a 4 percorridos num Mac.

### Passo 1: resultado da prova (2026-11-23)

Existe uma janela que pareia com o servidor e conversa com um bot, com a resposta chegando aos poucos. Fica em `apps/desktop`: um crate de cliente, sem interface, e um crate com a janela em GPUI.

| Verificação | Resultado |
|---|---|
| Contrato | Os tipos em Rust saem do `core`; o teste do `core` acusa o arquivo adulterado ou atrasado. |
| Cliente contra o servidor de verdade | Pareia, recusa o código repetido, cria bot, recebe a resposta aos poucos com as posições conferidas, aprova uma ação, despareia e vê o fluxo parar sozinho. |
| Janela dirigida pelo teclado, sem tela | Digita endereço e código, erra o código e corrige com a tecla de apagar, pareia com Enter, envia uma mensagem e despareia, contra o servidor de verdade. |
| App de verdade no Windows | Levado do pareamento à conversa com teclas e cliques mandados só à janela dele, com capturas. A prova achou um defeito que os testes não pegam: texto longo não quebrava a linha e empurrava a tela. Corrigido e conferido de novo. |
| Testes | 22 do cliente, 1 de contrato e 6 da janela, mais 2 no `core` para o gerador. |
| Falsificação | Seis quebras de propósito, uma por vez, todas acusadas. |
| `clippy` e `rustfmt` | Sem avisos. |

Não coberto:

- macOS: a CI compilou o app e passou os testes lá (PR 6), mas ninguém abriu a tela num Mac;
- o que os passos seguintes trazem: sessão guardada no cofre do sistema, cartões de aprovação, aviso do sistema, criar e editar bot com formulário, parar um turno, tema claro;
- o campo de texto é o mínimo: sem seleção, copiar nem desfazer, e uma mensagem longa some pela direita enquanto é digitada;
- pacote, assinatura e atualizador.

### Passo 2: resultado do cliente (2026-11-23)

O app guarda a sessão e abre já pareado. A regra do 401 e a retomada do fluxo passam a ter os testes que o celular tem.

- **Sessão no cofre do sistema**: Gerenciador de Credenciais no Windows, Chaves no macOS. Vale só depois de guardada; ao sair, o cofre é esvaziado antes de qualquer outra coisa.
- **Regra do endereço igual à do celular**: os dois lados testam contra uma tabela única de 97 casos, em `packages/core/casos`. A regra em Rust foi reescrita para seguir a do celular passo a passo.
- **Foco**: ao trocar de tela, o teclado cai no campo certo.

| Verificação | Resultado |
|---|---|
| Sessão guardada | Lida de volta; lixo, endereço adulterado e token que não cabe num cabeçalho não viram sessão; sem conseguir apagar, grava um valor inútil. |
| Cofre de verdade no Windows | Um item de teste é gravado, lido e apagado no Gerenciador de Credenciais. |
| Regra do 401 na janela | Token revogado no servidor volta ao pareamento e esvazia o cofre; 401 de proxy e servidor fora do ar mantêm a sessão; recusa atrasada de uma sessão antiga não derruba a nova; pareamento que não pôde ser guardado não vale, e o token é revogado. |
| Fluxo de eventos, contra um servidor de mentira | Retomada do último id sem pedir carga de novo, id do sinal de vida, id que não cabe em cabeçalho, evento fora do contrato, espera crescente, conexão estável zerando a espera, teto da conexão, parar. |
| Testes | 31 do cliente, 1 de contrato, 12 do fluxo e 13 do app; 558 no app de celular, com a tabela de endereços. |
| Falsificação | Dez quebras de propósito, uma por vez, todas acusadas. |
| App de verdade no Windows | Pareia, conversa, fecha, reabre direto na conversa com o histórico, despareia; o item entra e sai do cofre. |

Não coberto:

- o cofre de verdade no macOS: o teste fica desligado lá, e ninguém conferiu num Mac;
- silêncio do fluxo: uma conexão que morre em silêncio só é percebida no teto de um minuto, não em três sinais de vida como no celular;
- pausar o fluxo com a janela minimizada, que o celular faz com o app em segundo plano.

### Passo 3: resultado das telas (2026-11-24)

O desktop passa a fazer o que o celular faz: cria e edita bot por formulário, mostra o pedido de aprovação num cartão, para uma resposta, e avisa pelo sistema quando um bot espera a pessoa e a janela não está na frente.

- **Cartão de aprovação**: fica na conversa, logo depois da resposta em que o pedido surgiu, com o pedido inteiro, "Aprovar" e "Negar". Resolvido, vira uma linha. A lista de bots diz "aguardando aprovação". A regra é a do celular, portada para `aprovacoes.rs`: desfecho conhecido não volta a pendente, e lista possivelmente velha só acrescenta.
- **Aviso do sistema**: pela GPUI, que já traz isso para Windows e macOS. Só sai com a janela fora da frente, diz qual bot espera e qual ferramenta, não leva o conteúdo do pedido nem botões, e o clique abre a conversa do pedido. É recolhido quando o pedido se resolve ou a pessoa volta ao app.
- **Formulário de bot**: nome, modelo e instruções, no lugar da conversa. A validação segue a do celular e as duas são testadas contra uma tabela única de 133 casos, em `packages/core/casos/bot-entrada.json`. Editar manda só o que mudou.
- **Parar**: enquanto o bot responde, "Enviar" dá lugar a "Parar".
- **Campo de texto**: seleção com teclado e mouse, copiar, recortar, colar, desfazer e refazer, andar por palavra. O campo de mensagem e o de instruções têm várias linhas, quebram o texto na largura e rolam; o de uma linha rola para o cursor ficar à vista. O limite conta caracteres, como o esquema do contrato.
- **Tema claro**: acompanha a aparência do sistema. Os valores são daqui, porque o termIAX não tem tema claro próprio.
- **Teclado depois do clique**: clicar num botão deixava o teclado sem campo nenhum, e a pessoa tinha de clicar no campo para seguir digitando. Achado pelo primeiro teste que clicou num botão; corrigido.

| Verificação | Resultado |
|---|---|
| Regras do cliente | Aprovações e formulário com os mesmos casos do celular. O levantamento achou que o esquema conta o tamanho em caracteres, não em unidades UTF-16, e que o aparo de espaços do JavaScript não é o do Rust; a tabela cobre os dois. |
| Cliente contra o servidor de verdade | Edita bot, inclusive devolvendo o modelo ao padrão; para um turno; nega um pedido; decidir de novo dá `ja_resolvida`; a lista de pendentes acompanha. |
| Janela sem tela, com teclado e cliques nos botões de verdade | Cria e edita bot pelo formulário; aprova e nega no cartão; mostra o pedido que já esperava, mesmo sem o fluxo de eventos; acompanha a decisão de outro aparelho; avisa quando outro aparelho resolveu antes; para a resposta. |
| Aviso do sistema, pela plataforma de teste da GPUI | Nenhum com a janela na frente; um, sem o conteúdo, com a janela em segundo plano; o clique abre a conversa; é recolhido quando o pedido se resolve. |
| Campo de texto | Teclas, área de transferência, mouse, quebra de linha, altura que cresce até o teto e rolagem, sem tela; a lógica do texto em teste de unidade. |
| Testes | 90 do cliente, 4 de contrato, 12 do fluxo e 48 do app; 693 no app de celular, com a tabela do bot. Quatro rodadas seguidas do app, sem falha. |
| Falsificação | No app, 17 quebras de propósito, uma por vez, todas acusadas; uma só foi acusada depois de um teste novo, o do pedido pendente sem fluxo de eventos. No cliente, 13, rodadas pelo subagente que portou as regras, num espelho descartável do crate, todas acusadas; três delas foram repetidas na árvore de verdade, com o mesmo resultado. |
| App de verdade no Windows | Pareia, cria bot pelo formulário, aprova no cartão, escreve uma mensagem de seis linhas, para a resposta, recebe um aviso de verdade com a janela minimizada (lido na central de notificações: um aviso, sem o conteúdo, recolhido ao voltar), nega, reabre no tema claro e despareia. Na primeira rodada dois cliques do script erraram o alvo; corrigidas as coordenadas, a segunda passou inteira. |

Não coberto:

- macOS: nada do passo 3 foi compilado nem testado lá ainda; a CI roda no PR. O aviso do sistema só é entregue a app empacotado, que não existe;
- o aviso do sistema com o app fechado: fechar a janela encerra o app, e não há ícone na bandeja;
- o clique num aviso de verdade do Windows: só o clique simulado pela plataforma de teste;
- o texto em composição de teclado de outro idioma e a tecla morta do ABNT2 no campo novo, fora de digitar acentos pelo script;
- Home e End por linha da tela, cursor piscando e rolar ao arrastar o mouse para fora do campo;
- pacote, assinatura e atualizador, que são o passo 4.

### Passo 4: plano da distribuição no Windows (2026-11-24)

Só plano; nada foi implementado. O passo entrega um instalador assinado do app de desktop, um jeito de o app se atualizar e um roteiro de release repetível, conferidos no Windows Sandbox.

#### De onde o plano parte

| Fato | Fonte |
|---|---|
| O app não tem ícone, a versão é `0.0.0`, o executável não leva metadados e não existe release. A CI compila o build de release e joga fora. | `apps/desktop`, conferido em 24/11 |
| As 322 dependências que entram no executável do Windows têm licença permissiva; nenhuma é GPL. Os crates que vêm do repositório do Zed são Apache-2.0. | `cargo tree`, conferido em 24/11 |
| O termIAX distribui por instalador por usuário, sem pedir administrador, com o executável e o instalador assinados e carimbo de tempo. A assinatura usa um certificado em nuvem de pessoa física, que exige sessão aberta no PC de quem assina: não serve para CI. | documentos do termIAX, lidos em 24/11 |
| Lá, o atualizador confia na assinatura do pacote, não numa chave própria: depois de baixar, confere tamanho e SHA-256 e exige o publicador esperado, com revogação conferida. Nada é baixado sem a pessoa pedir, e versão menor ou igual é recusada. | idem |
| O QA de lá roda num Windows Sandbox sem rede, com uma pasta de entrada só de leitura e uma de saída, usuário sem privilégios, e devolve um `result.json`. Uma segunda rodada usa rede e a marca de arquivo baixado da Internet. Esse QA achou um defeito de atualização que nenhum teste pegava. | idem |
| Assinatura válida não tira o aviso de reputação do SmartScreen de um publicador pouco conhecido. Sem assinatura, o Smart App Control bloqueia o executável. | idem |
| Este PC tem o `signtool` do Windows SDK, o Windows Sandbox e o `cargo-deny`. Não tem ferramenta de instalador. | conferido em 24/11 |

Do termIAX vêm o processo e as lições, como decidido em 23/11. Os scripts e o código são escritos aqui.

#### Desenho proposto

- **Executável com identidade.** Ícone, versão e descrição gravados no `.exe` por um `build.rs`, só no Windows. A versão sai de `[workspace.package]`, e o pacote não sai se a do executável divergir. Runtime do C++ embutido (`crt-static`), para o app não depender de nada instalado. Os caminhos da máquina de quem compila são remapeados: sem isso, o binário público levaria o nome de usuário em mensagens de pânico.
- **Instalador por usuário**, sem administrador, em `%LOCALAPPDATA%\Programs\awikabot`, com atalho no Menu Iniciar que carrega a identidade `awikabot.desktop`, para o aviso do sistema aparecer com o nome e o ícone do app. Leva o executável, a licença e as licenças de terceiros. Não mexe em PATH, inicialização do Windows, firewall nem serviços.
- **Desinstalação que não deixa credencial.** Tira os arquivos, o atalho e o registro da identidade, e pede ao app para esvaziar o cofre antes de sair: sem isso, o token do computador ficaria no Gerenciador de Credenciais depois de o app ir embora.
- **Assinatura** do executável e do instalador, com SHA-256 e carimbo de tempo, feita à mão no PC de quem tem o certificado. O script só recebe a impressão digital do certificado; senha e token nunca passam por ele.
- **Atualização em três passos, cada um a pedido da pessoa.** O app consulta, no máximo uma vez por dia e com opção de desligar, os releases públicos do repositório no GitHub, só os de etiqueta `desktop-v`. Havendo versão maior, avisa. A pessoa pede o download: o arquivo vai para uma pasta do app com nome provisório, e só vale depois de conferidos o tamanho, o SHA-256 e a assinatura, com o publicador esperado. A pessoa pede para instalar: o app chama o instalador e fecha, e o instalador o reabre.
- **A assinatura é a âncora da atualização.** Quem tomar a conta do GitHub não consegue empurrar um pacote: precisaria também do certificado. Em compensação, trocar de certificado ou de titular exige antes uma versão que aceite os dois.
- **Release em etapas**, cada uma amarrada à anterior pelo SHA-256 dos pacotes: conferências do candidato, assinatura e pacote, conferência dos artefatos, QA no Sandbox, release em rascunho no GitHub e aprovação do titular, que o torna público e cria a etiqueta. As evidências ficam fora do Git e fora de `target/`.

#### Subpassos

1. **Identidade do executável**: ícone, versão `0.1.0`, metadados, `crt-static`, caminhos remapeados.
   Verificar: as propriedades do `.exe` mostram produto e versão; ele não importa o runtime do C++; não há caminho da máquina dentro dele.
2. **Instalador e desinstalação**: pacote por usuário, atalho com a identidade, licenças de terceiros, esvaziar o cofre ao desinstalar.
   Verificar, no Sandbox, com usuário sem privilégios: instala, o atalho abre o app, desinstala, e não sobra arquivo, atalho, registro nem item no cofre.
3. **Assinatura e conferência dos artefatos**: assinar, conferir assinatura e carimbo, gerar `SHA256SUMS`.
   Verificar: o Windows mostra a assinatura como válida; um arquivo adulterado depois de assinado é recusado pela conferência.
4. **QA no Sandbox como comando**: gera a configuração do Sandbox, roda o roteiro lá dentro e traz o `result.json`. Rodada sem rede e rodada com rede e marca de download.
   Verificar: duas execuções seguidas com o mesmo resultado, e uma quebra de propósito no pacote que o roteiro precisa acusar.
5. **Atualizador no app**: consulta, aviso, download conferido e instalação.
   Verificar: testes contra um servidor falso (versão maior, igual e menor; hash errado; tamanho errado; download cortado); a conferência de assinatura aceita o pacote de verdade e recusa um sem assinatura, um adulterado e um assinado por outro publicador; no Sandbox, uma versão antiga se atualiza para a nova e recusa voltar.
6. **Roteiro de release e primeira versão**: runbook, conferências do candidato (suíte, `verificar`, desktop, licenças e avisos de segurança das dependências), nova verificação de segurança sobre a `main`, e a versão `0.1.0` em rascunho.
   Verificar: o rascunho só sai com o QA aprovado para os mesmos hashes; a aprovação é um passo à parte, do titular.

O atualizador entra antes da primeira versão pública: a versão que não sabe se atualizar fica para trás para sempre.

#### Decisões que são do titular, antes de começar

| Decisão | Opções | Recomendação |
|---|---|---|
| Ferramenta do instalador | Inno Setup; MSI pelo WiX; MSI montado à mão com o que o Windows traz, como no termIAX | **Inno Setup**: instala por usuário, grava a identidade no atalho e fecha o app aberto, com um roteiro curto. O MSI tem reversão de atualização que falha, mas foi nele que o termIAX achou o defeito mais sutil, e montá-lo à mão é o caminho mais longo para reescrever. Qualquer das duas primeiras exige instalar a ferramenta neste PC. |
| Certificado | O certificado em nuvem do titular; um programa de assinatura para código aberto; sem assinatura | **O do titular**: já existe e o processo é conhecido. O custo é de exposição: o nome civil do titular vira o publicador de um binário público e fica escrito no atualizador, num repositório público. Sem assinatura, o Smart App Control bloqueia o app. |
| Ícone | O titular fornece; eu proponho um, simples, para aprovação | Sem ícone não há pacote. |
| Fonte das atualizações | Releases do GitHub; um endereço próprio | **GitHub**: o repositório é público e não há mais nada para manter. |
| Bandeja e abrir com o Windows | Neste passo; depois | **Depois.** É o que faria o aviso chegar com a janela fechada, mas pede um crate novo, a provar nos dois sistemas, e o passo já é grande. |
| Versão portátil, em ZIP | Agora; depois | **Depois**: ninguém pediu, e ela pede um atualizador próprio. |

#### Riscos

- O atualizador é um caminho para executar código baixado. Ele passa por revisão de segurança própria antes da primeira versão, e a conferência de assinatura tem teste com pacote adulterado e com outro publicador.
- O aviso de reputação do SmartScreen deve aparecer nos primeiros downloads, mesmo com assinatura válida.
- A sessão do certificado em nuvem pode cair no meio da assinatura; o script precisa refazer só o que faltou.
- Renovar o certificado com outro nome, ou trocar de autoridade, quebra a atualização de quem já instalou.
- O Sandbox só prova o Windows 11. Windows 10, atualização com o app aberto no meio de uma resposta e queda de energia ficam sem prova.
- Antivírus de terceiros podem desconfiar de um executável novo e pouco baixado.

#### Fora deste passo

macOS, que é o passo 5; loja da Microsoft; canal de versões de teste; e o que a tabela de decisões deixa para depois.

### Passo 4: andamento (2026-11-24)

O titular aceitou as recomendações da tabela acima em 24/11: Inno Setup, o certificado dele, ícone proposto aqui, atualizações pelos releases do GitHub; bandeja e versão portátil ficam para depois. Feito até agora o subpasso 1 e a parte sem janela do subpasso 5.

- **Identidade do executável (subpasso 1).** Ícone gerado por `apps/desktop/crates/app/recursos/gerar-icone.mjs` e versionado ao lado; à espera da aprovação do desenho pelo titular. Versão `0.1.0`. O `build.rs` grava ícone, versão e descrição no `.exe`. O runtime do C++ vai embutido em todo build (`apps/desktop/.cargo/config.toml`). O build de distribuição é o `apps/desktop/distribuicao/windows/compilar.ps1`, que troca os caminhos da máquina por nomes neutros e só entrega o executável depois de conferi-lo.
- **Atualizador, parte sem janela (subpasso 5).** `apps/desktop/crates/cliente/src/atualizacao.rs`: lê a versão, consulta os releases de etiqueta `desktop-v`, lê o manifesto da plataforma e baixa o pacote para um arquivo provisório, que só ganha o nome final depois de conferidos o tamanho e o SHA-256. A etiqueta e os nomes dos arquivos são montados a partir da versão: nada do que a rede respondeu vira parte de um endereço. Falta a conferência da assinatura, a tela e a instalação.

| Verificação | Resultado |
|---|---|
| Executável comum, antes | Levava o nome de usuário de quem compilou em 1.183 caminhos e pedia o runtime do C++. |
| Executável de distribuição | Propriedades com produto e versão `0.1.0`; não pede o runtime do C++; nenhum caminho da máquina dentro dele. O script acusa o executável comum (controle), e o de distribuição abre a janela. |
| Atualizador contra um servidor de mentira | Oferece só versão maior; ignora rascunho, versão de teste, outro produto, etiqueta malformada e release sem pacote da plataforma; recusa manifesto de outra versão, de outra plataforma, com outro nome de arquivo, com caminho, com tamanho ou hash sem sentido; não segue redirecionamento na lista; segue no arquivo, como o GitHub entrega. |
| Download | Pacote trocado, maior, menor, cortado ou página de erro não ficam no disco; se o publicado mudou desde a consulta, nada é baixado; cancelar não deixa arquivo. A consulta não manda credencial. |
| Testes | 96 do cliente, 10 do atualizador, 4 de contrato, 12 do fluxo e 48 do app. `clippy` e `rustfmt` sem avisos. |
| Falsificação | Doze quebras de propósito no atualizador, uma por vez, todas acusadas. |

Em seguida, com o Inno Setup instalado neste PC por autorização do titular, vieram os subpassos 2 e 4 e o roteiro de assinatura do 3:

- **Instalador e desinstalação (subpasso 2).** `instalador.iss` instala só para o usuário e grava a identidade do app no atalho. A desinstalação chama o app com `--esquecer-sessao`, que revoga o token por melhor esforço e esvazia o cofre, e tira o registro da identidade. Com o app aberto, ela pede para fechá-lo: o app passa a criar uma marca com o nome da identidade enquanto está aberto. O `empacotar.ps1` compila, confere, junta as licenças de terceiros, monta o instalador e grava o manifesto que o atualizador lê e a lista de hashes.
- **Licenças de terceiros.** `licencas-de-terceiros.mjs` junta o texto das licenças dos 400 componentes que entram no executável e para o pacote se aparecer licença fora da lista das aceitas.
- **QA no Sandbox como comando (subpasso 4).** `qa-sandbox.ps1` prepara as pastas, abre o Windows Sandbox sem rede e traz o `result.json`; `qa-sandbox-dentro.ps1` é o roteiro que roda lá dentro.
- **Assinatura (subpasso 3), só escrita.** O `empacotar.ps1 -Assinar` confere o certificado antes de compilar, assina o executável e o instalador com carimbo de tempo e confere as duas assinaturas. Não foi exercitado: depende da sessão do certificado do titular.

| Verificação | Resultado |
|---|---|
| Opção de esvaziar o cofre | Esvazia e o token deixa de valer no servidor; esvazia mesmo sem servidor; cofre com lixo termina vazio; avisa quando não conseguiu. |
| Pacote sem assinatura | Instalador de 6 MB, com a versão conferida; manifesto e lista de hashes com os nomes que o atualizador procura. Duas execuções do script de licenças dão o mesmo arquivo. |
| Sandbox, pacote sem assinatura, Smart App Control ligado | O Windows bloqueou o instalador, e o roteiro reprovou o pacote dizendo por quê. É o que a pessoa veria com um pacote sem assinatura. |
| Sandbox, Smart App Control desligado só lá dentro | 17 de 17 passos: instala em silêncio; executável na pasta do usuário, na versão certa; licenças; atalho com a identidade; registro só do usuário; o app abre; com o app aberto a desinstalação recusa; a atualização por cima fecha o app, troca e reabre; desinstala; não sobra arquivo, atalho, registro, credencial no cofre nem processo. |
| Quebra de propósito no pacote | Um instalador sem a identidade no atalho e sem esvaziar o cofre: o roteiro acusou os dois e passou nos outros 15 passos. |
| Testes | 96 do cliente, 10 do atualizador, 4 de contrato, 12 do fluxo e 53 do app. `clippy` e `rustfmt` sem avisos. |

Depois, com a primeira parte na `main` (PR 11), veio o resto do subpasso 5:

- **De quem é o pacote** (`crates/app/src/confianca.rs`). O Windows confere a assinatura do pacote baixado, com revogação, e o app exige o publicador e a autoridade do certificado dele. O nome do publicador foi lido do próprio certificado. Fora do Windows, tudo é recusado.
- **Painel de atualização** (`crates/app/src/atualizador.rs`). Aparece no pareamento e na lateral da conversa: avisa da versão nova, baixa a pedido, confere tamanho, hash e assinatura, e só então oferece instalar. Na hora de instalar confere a assinatura de novo, chama o instalador em silêncio e sai; o instalador fecha o que restar do app, troca o executável e o reabre. O pacote que não passa é apagado. O download roda numa thread própria e pode ser cancelado.
- **Preferências** (`crates/cliente/src/preferencias.rs`). Avisar de versão nova, ligado até a pessoa desligar na tela, e a data da última consulta, num arquivo comum na pasta de dados. A desinstalação passa a apagar essa pasta.
- **O app de desenvolvimento não se atualiza** nem consulta versão: o painel só existe no build de release do Windows.

| Verificação | Resultado |
|---|---|
| Assinatura, com arquivos de verdade | Lê quem assinou um executável assinado pela Microsoft e o aceita com a regra certa; recusa o mesmo arquivo com a regra do app, e com outra autoridade; recusa a cópia com um byte trocado; recusa arquivo sem assinatura e arquivo que não existe. |
| Painel, sem tela, com cliques nos botões | Ao abrir, avisa e registra a consulta, sem baixar; no mesmo dia não consulta de novo; versão igual não avisa; erro na consulta não registra nada; com o aviso desligado nada sai, e ligar consulta na hora. |
| Download pelo painel | Pacote sem a assinatura esperada é apagado e não há como instalar; pacote trocado no caminho não fica pronto; cancelar volta ao aviso sem deixar arquivo. |
| Instalação pelo painel | Pacote assinado por quem a regra do teste espera fica pronto, e instalar chama o instalador com o arquivo conferido; se o arquivo é trocado no disco depois de conferido, a instalação é recusada e ele é apagado. |
| Testes | 99 do cliente, 10 do atualizador, 4 de contrato, 12 do fluxo e 71 do app. `clippy` e `rustfmt` sem avisos. |
| Falsificação | Treze quebras de propósito no painel e na assinatura, uma por vez, todas acusadas. |
| Sandbox, pacote novo, sem assinatura | O roteiro ganhou um passo, a pasta de dados depois de desinstalar, e na primeira rodada reprovou o pacote nele: o caminho da pasta no instalador tinha saído sem a barra. Corrigido, 18 de 18 passos. |

Nesse ponto, o caminho feliz com o certificado do app não tinha sido exercitado: não existia pacote assinado por ele. Os testes provam o mecanismo com um arquivo assinado por outro publicador e uma regra de teste.

Por fim, o começo do subpasso 6, o roteiro de release (`docs/release-desktop.md`):

- **Conferências do candidato** (`conferir-candidato.ps1`). A suíte, o `pnpm verificar`, a auditoria do pnpm, rustfmt, clippy e os testes do Rust, o `cargo deny`, a consulta à OSV e a coleta das licenças, parando na primeira falha. Recusa a pasta com mudança sem commit. Grava a evidência em `relatorios/release`.
- **Avisos de segurança das dependências.** `apps/desktop/deny.toml` e `avisos-osv.mjs`. Em 24/11 não havia vulnerabilidade conhecida. Havia sete avisos de dependência sem manutenção, todos por dentro da GPUI, que ficam listados e não param o pacote.
- **Conferência dos artefatos** (`conferir-artefatos.ps1`). Só passa um pacote publicável, e pede ao próprio app que o confira pela regra do atualizador (`--conferir-pacote`).
- **Servidor de teste mais firme.** Uma rodada local falhou porque dois testes disputaram a mesma porta. O apoio de testes passou a perceber o servidor que saiu na partida e a tentar de novo.

| Verificação | Resultado |
|---|---|
| Conferências do candidato | Com mudança sem commit, recusa. Como ensaio, 12 de 12 passos, com a evidência gravada. Um programa que falha para o roteiro (controle). |
| OSV | Na primeira versão do script os sete avisos de manutenção saíram como vulnerabilidade e o script parou: o tipo do aviso estava em outro lugar da resposta. Corrigido; quando a marca falta, o aviso vale como vulnerabilidade. |
| Conferência dos artefatos | Recusa o pacote de desenvolvimento por não ter assinatura e por ter saído de pasta com mudanças. Numa cópia adulterada, acusa também o tamanho e o hash do instalador, a lista de hashes e a licença que falta. |
| Opção de conferir pacote | Recusa um executável assinado pela Microsoft, com a revogação consultada, um sem assinatura e um que não existe. |
| CI do PR 12 | Falhou no macOS, por três motivos de recusa que só o Windows produz; corrigido, passou nos dois sistemas. |

Depois, as duas últimas etapas do roteiro:

- **Publicar o rascunho** (`publicar-rascunho.ps1`). Só sobe pacote assinado, de commit que está na `main`, com as conferências do candidato, a conferência dos artefatos e as duas rodadas de QA aprovadas para aquele commit e aquele instalador. Os arquivos têm de ser os que foram conferidos, a versão maior que a última pública e a etiqueta nova. Depois de criar o rascunho, baixa os arquivos de volta e compara. `-Ensaio` confere e não envia.
- **Aprovar** (`aprovar.ps1`). Confere o rascunho contra o GitHub de agora e publica pelo número dele. Depois confere que ficou público e que a etiqueta aponta para o commit. A versão é escrita à mão, e sem `-Ensaio` só o titular roda.
- **Evidência por etapa.** A conferência dos artefatos, cada rodada de QA, o rascunho e a publicação gravam um arquivo na pasta do commit em `relatorios/release`, e cada etapa lê os das anteriores. Copiar a evidência do QA à mão deixou de existir.
- **Repositório e etiqueta num lugar só.** Os scripts leem os dois de `atualizacao.rs`: o que é publicado vai para onde o app instalado procura.

| Verificação | Resultado |
|---|---|
| Teste dos scripts de publicação (`testes/testar-publicacao.ps1`) | Com um `gh` de mentira, 43 de 43 casos: o caminho bom das duas etapas, o ensaio que não envia, as notas do release, e 34 defeitos plantados um por vez no pacote, nas evidências ou no GitHub de mentira, cada um recusado pelo motivo certo. As evidências do teste saem das mesmas funções que os scripts de verdade usam. Entrou nas conferências do candidato. |
| Falsificação do teste | Treze conferências tiradas dos scripts, uma por vez; o teste acusou todas. |
| Sandbox, depois da mudança na evidência | Pacote de desenvolvimento, sem assinatura: 18 de 18 passos, e a cópia da evidência chegou à pasta do commit com o tipo de rodada e a marca de Smart App Control desligado. |
| Conferências do candidato, como ensaio | 13 de 13 passos, já com o teste dos scripts de publicação. |
| Ensaio contra o GitHub de verdade | Com o pacote de desenvolvimento, a etapa 5 consulta o GitHub e recusa por seis motivos, entre eles a falta de assinatura e de evidências. A etapa 6 para antes, por não haver rascunho. |

Por último, a segunda verificação de segurança e a primeira versão:

- **Verificação de segurança sobre a `main`** (`f9616d6`). Cobriu também o desktop, o instalador, o atualizador, o roteiro de release e a CI. Nenhuma falha e dois achados de severidade baixa, o 9 e o 10 de `docs/auditoria-achados.md`: o atualizador aceitava um pacote assinado pelo publicador sem conferir que era a versão oferecida, e o Inno Setup não tinha versão fixa. Corrigidos pelo PR 15. A verificação foi reemitida sobre `1d1368c` e passou como gate; para `206b67f` valeu a mesma, com o diff entre os dois commits conferido.
- **Produto e versão depois da assinatura** (`crates/app/src/confianca.rs`). Depois de conferir quem assinou, o app lê o nome do produto e a versão gravados no pacote e exige os do app e os da versão oferecida.
- **Inno Setup em versão fixa** (`comum.ps1`). O pacote assinado só sai da versão fixada, que fica gravada no `build-info.json`.
- **O Inno Setup assina o instalador por dentro** (PR 16). O primeiro pacote assinado, de `1d1368c`, passou na conferência dos artefatos e foi reprovado no Sandbox: o Smart App Control bloqueou a cópia do programa de instalação que o instalador extrai e roda, que saía sem assinatura. Agora o compilador assina o instalador, o desinstalador e essa cópia.
- **Versão 0.1.0**, de `206b67f`. As seis etapas do roteiro, com o rascunho criado por autorização do titular e a publicação feita por ele.

| Verificação | Resultado |
|---|---|
| Verificação de segurança, `f9616d6` | 28 quesitos atendidos, 1 em parte, nenhuma falha; 23 não se aplicam. |
| Verificação de segurança reemitida, `1d1368c` | 29 quesitos atendidos, nenhum em parte, nenhuma falha; 23 não se aplicam. |
| Testes | 99 do cliente, 10 do atualizador, 4 de contrato, 12 do fluxo e 76 do app. |
| Sandbox, pacote assinado de `1d1368c`, Smart App Control ligado | Reprovado nas duas rodadas: o Windows bloqueou o instalador. |
| Conferências do candidato, `206b67f` | 13 de 13 passos, sem mudança pendente. |
| Conferência dos artefatos, `206b67f` | Aprovada; o app aceitou o pacote pela regra do atualizador. |
| Sandbox, pacote assinado de `206b67f`, Smart App Control ligado | 17 de 17 passos em cada rodada: sem rede, e com rede e a marca de arquivo baixado. |
| Rascunho no GitHub | Criado com os três arquivos, baixado de volta e comparado com os conferidos. |
| Publicação | Feita pelo titular em 24/11. Lido no GitHub depois: o release é público, a etiqueta `desktop-v0.1.0` aponta para `206b67f`, e os três arquivos têm os hashes da conferência dos artefatos. |

Na primeira tentativa de assinar o pacote de `206b67f`, a assinatura falhou por não achar o certificado, logo depois de a sessão dele ser aberta; refeita um minuto depois, passou. A conferência que o script faz antes de compilar não percebe a sessão fechada.

Em 25/11 saiu a versão 0.1.1, de `b410db0`. Ela não muda o app: existe para ver um app instalado se atualizar, o que uma versão só não permite.

- **QA a partir da versão anterior** (PR 18). Com `-Anterior`, depois do roteiro comum o Sandbox instala a versão publicada, abre o app e atualiza para o pacote como o atualizador faz. Confere a versão no executável e no registro, as preferências mantidas e a desinstalação limpa. A evidência registra de que versão a rodada partiu; a publicação ainda não cobra isso.
- **Roteiro de release pela segunda vez**, com as duas rodadas de QA partindo da 0.1.0.
- **Atualização vista num app instalado.** Num Sandbox com rede, com a 0.1.0 publicada instalada, o titular clicou no painel. Um roteiro avulso anotou de dentro o estado do disco e do registro.

| Verificação | Resultado |
|---|---|
| Sandbox, pacote de desenvolvimento 0.1.1, partindo da 0.1.0 | 27 de 27 passos. Na primeira rodada a parte nova não rodou e o QA passou assim mesmo: uma variável do script tinha o nome do parâmetro, e o PowerShell não diferencia maiúsculas. Percebido pela saída, que não trazia os passos novos. |
| Falsificação do QA novo | Com a atualização trocada pela reinstalação da 0.1.0, reprova no passo que confere a versão. As quatro recusas do script de fora foram exercitadas sem abrir o Sandbox. |
| Conferências do candidato, `b410db0` | 13 de 13 passos, na terceira tentativa. As duas primeiras pararam no teste de contrato do cliente, por um artefato de build de um worktree já apagado; limpo o cache dos dois crates, passou. |
| Sandbox, pacote assinado de `b410db0`, Smart App Control ligado | 26 de 26 passos em cada rodada, sem rede e com rede, as duas partindo da 0.1.0. |
| A 0.1.0 confere o instalador publicado da 0.1.1 | O executável da 0.1.0 aceita o arquivo baixado do release. Recusa o mesmo arquivo oferecido como outra versão, o instalador antigo e uma cópia adulterada. |
| Atualização pelo painel, no Sandbox com rede | A 0.1.0 consultou a versão ao abrir e baixou o pacote da 0.1.1. O app fechou, o executável e o registro passaram a 0.1.1 e o app reabriu; o pacote baixado foi apagado em seguida. O aviso e os botões são relato de quem clicou. |
| Publicação | Feita pelo titular em 25/11. Lido no GitHub depois: o release é público, a etiqueta `desktop-v0.1.1` aponta para `b410db0`, e os três arquivos têm os hashes da conferência dos artefatos. |

Ainda em 25/11, as duas pontas que a 0.1.1 deixou soltas no roteiro:

- **A publicação cobra de onde o QA partiu.** Havendo versão pública, o `publicar-rascunho.ps1` lê no GitHub o manifesto da última e só passa se as duas rodadas de QA partiram dela, com o instalador que está publicado, comparado pelo SHA-256. O `aprovar.ps1` repete a conferência contra a última versão pública de agora, para o caso de outra versão sair entre o rascunho e a aprovação. Sem versão pública, nada muda.
- **Conferência depois de publicar como comando** (`ver-atualizacao.ps1 -Anterior <pasta>`). Abre um Sandbox com rede, instala a versão anterior publicada e abre o app. Um roteiro lá dentro anota cada mudança do que está instalado; o script de fora lê o histórico e julga a sequência: consulta registrada, pacote baixado com o tamanho e o hash do manifesto público, executável e registro na versão nova, app reaberto em outro processo, pacote apagado pelo app novo. Grava `atualizacao-vista.json` na pasta do commit da versão nova. Os cliques continuam sendo de uma pessoa.
- **Versão anterior conferida num lugar só.** As recusas da pasta de `-Anterior` saíram do `qa-sandbox.ps1` para `comum.ps1`; o QA e a conferência depois de publicar usam a mesma função. A conferência depois de publicar exige ainda que o instalador seja o do release daquela versão.

| Verificação | Resultado |
|---|---|
| Teste dos scripts de publicação | 57 de 57 casos: os 43 de antes e 14 com uma versão pública no GitHub de mentira. O caminho bom das duas etapas; a rodada sem `anterior`, a que partiu de outra versão e a que partiu de outro instalador da mesma versão, recusadas pelo motivo certo; a versão pública sem manifesto que se leia; e, na aprovação, outra versão publicada depois do rascunho. |
| Falsificação do teste de publicação | Seis conferências novas tiradas, uma por vez, numa cópia descartável do repositório; o teste acusou todas. |
| Teste da conferência depois de publicar (`testes/testar-ver-atualizacao.ps1`) | 33 de 33 casos, sem Sandbox: o julgamento de históricos escritos no teste, a atualização inteira e um defeito por vez, e as recusas da versão anterior contra uma pasta temporária. Entrou nas conferências do candidato. |
| Falsificação do julgamento | 25 conferências tiradas, uma por vez. Na primeira rodada uma passou sem ser acusada: faltava o caso das preferências gravadas sem a data da consulta. Com ele, o teste acusou as 25. |
| Recusas do script novo, contra o GitHub de verdade, sem abrir o Sandbox | A 0.1.1 como versão anterior, por não ser menor que a última pública; o pacote assinado da 0.1.0 que não foi publicado, por não ser o do release; um pacote de desenvolvimento, por não ter assinatura. |
| Sandbox com rede, `ver-atualizacao.ps1 -AteAConsulta` | A 0.1.0 publicada foi instalada com o Smart App Control ligado, o app abriu e registrou a consulta seis segundos depois. O histórico foi lido de fora enquanto era escrito, e o Sandbox desligou a pedido do script. |
| Sandbox, QA depois da mudança no `qa-sandbox.ps1` | Pacote assinado da 0.1.1 partindo da 0.1.0, sem rede: 26 de 26 passos. |
| Conferências do candidato, como ensaio | 14 de 14 passos, já com o teste da conferência depois de publicar. |
| Sandbox com rede, rodada inteira do `ver-atualizacao.ps1` | Aberta a pedido do titular. A 0.1.0 registrou a consulta e nada mais mudou no disco em 19 minutos; o Sandbox foi fechado, e o script reprovou a rodada no passo do download, com a evidência gravada. O histórico não diz se houve clique. |

A rodada inteira do `ver-atualizacao.ps1` ainda não foi vista passar: do download em diante, o julgamento só viu históricos escritos no teste, no formato que as rodadas de verdade produziram.

Os botões do app não têm foco de teclado: de fora, só se chega a eles pelo mouse. Três caminhos para tirar os cliques, nenhum implementado:

- o roteiro de dentro do Sandbox clica por coordenada, com mensagens à janela, como o `scripts/desktop-prova-visual.ps1` já faz no build de desenvolvimento, e guarda uma captura do painel, que troca o relato por imagem. Não muda o app e vale já para a 0.1.1 instalada. As coordenadas são as da tela da versão anterior e dependem da escala do Sandbox, o que não foi medido. Se o clique não pegar, a rodada não passa por engano: o veredito sai do disco, e a pessoa ainda pode clicar;
- dar papel e nome acessíveis aos botões do app, e o roteiro passa a acioná-los pela automação de interface do Windows. A GPUI do commit fixado traz acessibilidade (AccessKit), que o app ainda não usa. Não é caminho de teste: é o que um leitor de tela usa. Só vale a partir da versão que levar os nomes, e falta provar que o acionamento chega ao clique do botão;
- uma opção de linha de comando no app que consulte, baixe, confira e instale de uma vez, com a mesma origem e a mesma regra de assinatura. Não passa pelo painel, e muda a regra de que cada passo só acontece a pedido.

Depende do titular para seguir:

- aprovar o ícone, ou pedir outro;
- fazer os dois cliques numa rodada inteira do `ver-atualizacao.ps1`;
- decidir se os cliques saem, e por qual dos três caminhos.

Não coberto ainda: os cliques no painel de atualização num app instalado, que são de uma pessoa; a conferência de revogação com o computador sem rede; a recusa do roteiro do instalador diante de outra versão do Inno Setup. No Sandbox a conta é administradora, e a instalação sem privilégios é conferida pelo lugar dos arquivos e do registro, não com um usuário comum. A assinatura e a publicação só rodaram neste PC; a CI monta o pacote sem assinatura no Windows a cada PR.

### Decisões que são do titular

- **Mac sem Mac**: a CI do GitHub compila e testa no macOS, sem custo num repositório público, mas ninguém abre a tela. O passo 5 depende de alguém com Mac e da conta de desenvolvedor da Apple, a mesma que o TestFlight do iOS exige.
- **Quando**: depois de a primeira versão estar conferida no celular, ou em paralelo.

### Riscos

- A GPUI vem do repositório do Zed, fixada por commit, porque o crate publicado está parado. A troca de commit segue a do termIAX.
- Passam a existir dois clientes, em duas linguagens. Quem segura a igualdade é o teste de contrato, não a revisão.
- O que foi escrito em TypeScript para o app (sessão, fluxo de eventos, regras de tela) é reescrito em Rust, com os testes.
- Os componentes de base também são escritos aqui. Um campo de texto com seleção, área de transferência e teclado ABNT2 é a peça mais trabalhosa.

## Riscos

- Aprovação: um comando aprovado roda com os direitos do contêiner e alcança tudo o que está no volume, inclusive o login do motor. A proteção é a pessoa ler o comando no cartão.
- Memória: os 8 GB são divididos com outros serviços, e cada turno é um processo de CLI. A etapa 4 mediu quatro turnos simultâneos curtos, com pico de 681 MiB; turnos longos com ferramentas podem passar disso.
- Energia: o servidor fica numa placa doméstica e pode reiniciar por queda de energia. A etapa 4 provou a volta depois de o processo morrer; a queda de energia da placa não foi ensaiada.
- Backup: enquanto o arquivo ficar só no Pi, a perda do cartão leva o servidor e o backup juntos.
- Termos de uso: a página "Legal and compliance" do Claude Code não diz se um servidor sempre ligado, comandado pelo celular, conta como uso comum da assinatura, e manda perguntar à Anthropic em caso de dúvida. Ela reserva o direito de aplicar as restrições sem aviso. A saída segura é chave de API.
- Formato das CLIs: a saída muda entre versões. Fixar a versão na imagem e testar o driver contra ela.
- Push: o serviço da Expo é um terceiro no caminho do aviso.

## Decisões em aberto

- Assinatura de cada pessoa ou chave de API no uso contínuo: depende da leitura dos termos acima. A prova usou a assinatura.
- Subdomínio do túnel. O domínio `awikabot.com` já está registrado na Cloudflare; a ligação do túnel fica para depois.
- App de desktop: quem confere a versão de Mac, e quando a etapa 6 começa. Ver "Etapa 6: plano do app de desktop".

## Referência: OpenMausBot em 2026-11-23

Lido no repositório `milind-soni/OpenMausBot`, release v0.1.177; lojas não conferidas.

- Servidor que executa os bots pelas CLIs `claude`, `codex` e `grok`, com app desktop em Electron e interface web. Licença Apache-2.0; nomes e mascote são marca registrada.
- Apps oficiais de iOS e Android existem nas lojas, segundo documentos e issues, com código fechado desde 06/10 e push com app fechado ainda desligado.
- Ritmo: 12 releases em 8 dias, mais de 1.500 commits por semana, 1.310 issues e PRs abertos, 9.371 arquivos. Por isso um fork não se sustenta.
