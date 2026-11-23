---
name: verificar
description: Runbook do awikabot para subir o servidor em build de produção, percorrer os fluxos do mapa (docs/fluxos.md), observar o resultado, encerrar e relatar. Usar antes de dar por concluída uma mudança que altera comportamento visto pelo usuário e antes de um commit autorizado.
---

# Verificar o awikabot

Typecheck, lint e teste de unidade passam com a funcionalidade quebrada. O que prova uma mudança é o servidor rodando e o fluxo percorrido. Rodar este runbook não autoriza commit, push nem deploy.

## Comando

Da raiz do repositório:

```sh
pnpm verificar
```

O comando faz os cinco passos e sai com código diferente de zero se algo falhar:

1. **Subir**: empacota o servidor (`apps/server/build.mjs`) e inicia `dist/server.mjs` com `NODE_ENV=production` em `127.0.0.1:8795`. Outra porta: `AWIKA_VERIFICAR_PORTA`. Recusa começar se a porta já responde.
2. **Dirigir**: os fluxos do mapa que existem. Hoje, só o F0 (saúde do servidor).
3. **Observar**: status e corpo de cada resposta contra o resultado esperado do mapa.
4. **Encerrar**: derruba o processo e confere que a porta ficou livre.
5. **Relatar**: uma linha por verificação e a lista do que não foi verificado.

## App no aparelho

O comando não abre o app. Para conferir uma mudança de tela:

```sh
pnpm mobile
```

Abrir no Expo Go ou num build de desenvolvimento, no iPhone e no Android, e percorrer os fluxos do mapa tocados pela mudança. Sem aparelho ou emulador, relatar o app como não verificado.

## Ao relatar

Dizer os fluxos exercitados, com a evidência, e o que não foi verificado. Nunca um "verificado" genérico.

## Quando um fluxo novo entrar

Acrescentar a linha em `docs/fluxos.md`, a verificação em `scripts/verificar.mjs` e provar o runbook de novo: duas execuções seguidas com o mesmo resultado, e uma quebra de propósito no fluxo que o comando precisa acusar.
