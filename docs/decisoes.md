# Decisões que fogem do padrão da casa

O padrão é o da skill `bootstrap-monorepo`. Aqui fica só o que desvia dele, com o motivo.

| Decisão | Padrão | Motivo |
|---|---|---|
| `apps/server` no lugar de `apps/web` | Next.js na Vercel com Neon | O servidor precisa manter processos de agente vivos e arquivos locais no Orange Pi, o que uma plataforma serverless não faz. |
| Scripts `server` e `server:build` na raiz | `web` e `web:build` | Não há web. As skills que chamam `web` ou `web:build` não se aplicam; `typecheck`, `test` e `lint` seguem o contrato. |
| Sem páginas legais nem site | `apps/web` reduzido às páginas legais | A distribuição começa por TestFlight e teste interno. As páginas entram antes da loja pública. |
| `node:http` sem framework no servidor | — | O esqueleto só tem o health check. A escolha de framework fica para a etapa 2, quando houver rotas, autenticação e streaming para pesar. |
| `packages/core` exporta o TypeScript de origem | — | O servidor é empacotado pelo esbuild e o app pelo Metro; os dois leem a origem, e não há passo de build do core para esquecer. |
| ESLint 9, não o 10 | — | O `eslint-plugin-react` que vem com o `eslint-config-expo` 58 falha no ESLint 10. |
| Imagem do servidor sem o motor | — | O Claude Code entra na imagem na etapa em que o driver existir. A prova da etapa 0 fica em `spike/`. |

## Pendências de configuração externa

- **Identificador do app** (`ios.bundleIdentifier` e `android.package`): não definido. É difícil de trocar depois da primeira publicação.
- **Projeto no EAS**: o app já traz `expo-updates` e `runtimeVersion` por fingerprint, mas `updates.url` e o `projectId` só existem depois de criar o projeto na conta Expo. Depois disso, cadastrar cada `EXPO_PUBLIC_*` nos ambientes `production` e `preview` do EAS.
- **Subdomínio do túnel** para o acesso de fora.
