# awikabot — plano

Situação em 2026-11-23. Repositório: `github.com/n3tf4c3/awikabot`, público. A etapa 0 passou: o Claude Code serve de primeiro motor. A etapa 1 está na `main`, com a CI aprovada. Na etapa 2, o servidor foi validado com o motor real no Pi e o cliente do app passa contra o servidor; faltam abrir o app em aparelho e o túnel. As medições estão nas seções de resultado de cada etapa.

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

Fica fora da primeira versão: app de desktop e web, computador ou VM para o bot, apps conectados (Gmail, Slack), voz, salas com vários bots, importação de times e temas. Rotinas agendadas e webhooks são as candidatas à segunda versão.

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
4. Robustez no Pi: retomada depois de queda, backup do banco e health check vigiado.
   Verificar: derrubar o contêiner no meio de um turno e conferir o fluxo 5 na volta; restaurar o backup num ambiente descartável.
5. Revisão de segurança e distribuição por TestFlight e teste interno da Play.

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

Depois do teste no Pi, o contrato ganhou a posição de cada trecho de texto, o ponto de retomada no primeiro sinal de vida e a rota de "Desparear". Essas mudanças passaram na suíte e no runbook com o motor simulado, mas não voltaram ao Pi.

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

## Riscos

- Memória: os 8 GB são divididos com outros serviços, e cada turno é um processo de CLI. A etapa 0 mediu um turno por vez; falta medir turnos simultâneos.
- Energia: o servidor fica numa placa doméstica e pode reiniciar por queda de energia. Precisa voltar sozinho.
- Termos de uso: a página "Legal and compliance" do Claude Code não diz se um servidor sempre ligado, comandado pelo celular, conta como uso comum da assinatura, e manda perguntar à Anthropic em caso de dúvida. Ela reserva o direito de aplicar as restrições sem aviso. A saída segura é chave de API.
- Formato das CLIs: a saída muda entre versões. Fixar a versão na imagem e testar o driver contra ela.
- Push: o serviço da Expo é um terceiro no caminho do aviso.

## Decisões em aberto

- Assinatura de cada pessoa ou chave de API no uso contínuo: depende da leitura dos termos acima. A prova usou a assinatura.
- Subdomínio do túnel.

## Referência: OpenMausBot em 2026-11-23

Lido no repositório `milind-soni/OpenMausBot`, release v0.1.177; lojas não conferidas.

- Servidor que executa os bots pelas CLIs `claude`, `codex` e `grok`, com app desktop em Electron e interface web. Licença Apache-2.0; nomes e mascote são marca registrada.
- Apps oficiais de iOS e Android existem nas lojas, segundo documentos e issues, com código fechado desde 06/10 e push com app fechado ainda desligado.
- Ritmo: 12 releases em 8 dias, mais de 1.500 commits por semana, 1.310 issues e PRs abertos, 9.371 arquivos. Por isso um fork não se sustenta.
