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

1. **Subir**: empacota o servidor (`apps/server/build.mjs`) e inicia `dist/server.mjs` em `127.0.0.1:8795`, com o motor simulado e um banco descartável numa pasta temporária. Outra porta: `AWIKA_VERIFICAR_PORTA`. Recusa começar se a porta já responde.
2. **Dirigir**: os fluxos F0 a F4 do mapa, pelo lado do servidor: saúde, pareamento com código gerado pelo comando `parear`, criar e editar um bot, um turno com resposta aos poucos, a parada de um turno, e a aprovação: ação aprovada, ação negada, leitura fora da pasta do bot e o gancho sem servidor.
3. **Observar**: status e corpo de cada resposta, e os eventos do fluxo `/v1/eventos`, contra o resultado esperado do mapa.
4. **Encerrar**: fecha o fluxo, derruba o processo, apaga o banco temporário e confere que a porta ficou livre.
5. **Relatar**: uma linha por verificação e a lista do que não foi verificado.

## Motor real

O comando acima roda o motor simulado. Para conferir o Claude Code de verdade, usar um servidor que já está no ar e com login feito. Isso gasta uso da conta do motor e deixa um bot de teste no banco desse servidor, então não é para produção com dado real.

No host do servidor, na pasta do repositório:

```sh
C="docker compose -f deploy/compose.yaml"
CODIGO=$($C exec -T server node /app/server.mjs parear | grep -oE '[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}')
$C exec -T -e AWIKA_VERIFICAR_BASE=http://127.0.0.1:8790 -e AWIKA_VERIFICAR_CODIGO="$CODIGO" \
  server node --input-type=module - < scripts/verificar.mjs
```

Nesse modo o comando também confere que o bot lembra do turno anterior e prova a aprovação pelo disco: o arquivo do comando aprovado existe na pasta do bot, e o do comando negado não. Por isso ele precisa rodar dentro do contêiner do servidor, como acima.

## App no aparelho

O comando não abre o app. Para conferir uma mudança de tela:

```sh
pnpm mobile
```

Abrir no Expo Go ou num build de desenvolvimento, no iPhone e no Android, e percorrer os fluxos do mapa tocados pela mudança. Sem aparelho ou emulador, relatar o app como não verificado.

## Ao relatar

Dizer os fluxos exercitados, com a evidência, com qual motor, e o que não foi verificado. Nunca um "verificado" genérico.

## Quando um fluxo novo entrar

Acrescentar a linha em `docs/fluxos.md`, a verificação em `scripts/verificar.mjs` e provar o runbook de novo: duas execuções seguidas com o mesmo resultado, e uma quebra de propósito no fluxo que o comando precisa acusar.
