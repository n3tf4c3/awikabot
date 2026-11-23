# Decisões que fogem do padrão da casa

O padrão é o da skill `bootstrap-monorepo`. Aqui fica só o que desvia dele, com o motivo.

| Decisão | Padrão | Motivo |
|---|---|---|
| `apps/server` no lugar de `apps/web` | Next.js na Vercel com Neon | O servidor precisa manter processos de agente vivos e arquivos locais no Orange Pi, o que uma plataforma serverless não faz. |
| Scripts `server` e `server:build` na raiz | `web` e `web:build` | Não há web. As skills que chamam `web` ou `web:build` não se aplicam; `typecheck`, `test` e `lint` seguem o contrato. |
| Sem páginas legais nem site | `apps/web` reduzido às páginas legais | A distribuição começa por TestFlight e teste interno. As páginas entram antes da loja pública. |
| Hono no servidor | — | A etapa 2 trouxe rotas, autenticação e fluxo de eventos. O Hono é pequeno, não tem dependências e entra inteiro no pacote único do servidor. |
| SQLite embutido do Node (`node:sqlite`) | Postgres no Neon | O banco fica num arquivo no volume do servidor. O módulo embutido dispensa addon nativo, que complicaria o pacote único e a imagem arm64. |
| Código de pareamento gerado por comando no servidor | — | Quem pode rodar um comando no contêiner é quem manda no servidor. O código tem 60 bits, vale 5 minutos e uma vez; o banco guarda só o hash. |
| Fluxo de eventos com época e reenvio | — | O app retoma de onde parou pelo último id. Se o servidor reiniciou ou o evento já saiu da memória, recebe `ressincronizar` e busca o estado de novo. Cada trecho de texto leva a posição dele, e a resposta em andamento sai com o que já chegou, para o app juntar sem repetir. |
| "Desparear" revoga o token no servidor | — | O aparelho chama `DELETE /v1/dispositivo`. Só esquecer a sessão no celular deixaria o token valendo. |
| Texto do turno pela entrada padrão do motor; opções na forma `--nome=valor` | — | Nada que venha do app é lido pelo Claude Code como opção de linha de comando. |
| Pasta de trabalho definida pelo servidor, uma por bot | "pasta de trabalho" informada pela pessoa | Nenhum caminho vindo do app entra no sistema de arquivos. |
| Aprovação pelo gancho `PreToolUse` do Claude Code | — | Antes de cada ferramenta, o motor executa o próprio servidor com o subcomando `gancho`, que pergunta ao servidor e espera. É um recurso do binário sem modificação. |
| O gancho fala com o servidor numa porta só de loopback | — | A porta do gancho não é a da API e não é publicada. O token de cada turno deixa pedir uma aprovação; aprovar só um aparelho pareado, pela API. Assim, um bot que leia o próprio ambiente não consegue se aprovar. |
| O servidor decide a leitura sem perguntar | — | Ler dentro da pasta do bot passa; ler fora dela é negado, o que protege o login do motor e o banco, que ficam no mesmo volume. Todo o resto, inclusive ferramenta desconhecida, vai para a pessoa. |
| Pedido de aprovação expira em 15 minutos | — | Sem resposta, ou se o turno acabar antes, a ação não roda. Esperas de horas dependem do aviso push e do adiamento da decisão, que ainda não existem. |
| Aviso push adiado | Plano: push na etapa 3 | O push precisa de um projeto na conta Expo e de build em aparelho. Os cartões funcionam com o app aberto. |
| `packages/core` exporta o TypeScript de origem | — | O servidor é empacotado pelo esbuild e o app pelo Metro; os dois leem a origem, e não há passo de build do core para esquecer. |
| ESLint 9, não o 10 | — | O `eslint-plugin-react` que vem com o `eslint-config-expo` 58 falha no ESLint 10. |
| Motor na imagem do servidor, em versão fixa | — | O Claude Code é instalado como a Anthropic publica, com a atualização automática desligada. Trocar de versão é mudar o `CLAUDE_CODE_VERSION` e testar. |

## Pendências de configuração externa

- **Identificador do app** (`ios.bundleIdentifier` e `android.package`): não definido. É difícil de trocar depois da primeira publicação.
- **Projeto no EAS**: o app já traz `expo-updates` e `runtimeVersion` por fingerprint, mas `updates.url` e o `projectId` só existem depois de criar o projeto na conta Expo. Depois disso, cadastrar cada `EXPO_PUBLIC_*` nos ambientes `production` e `preview` do EAS.
- **Túnel** para o acesso de fora: o domínio `awikabot.com` está registrado na Cloudflare. Falta escolher o subdomínio e ligar o túnel ao servidor.
