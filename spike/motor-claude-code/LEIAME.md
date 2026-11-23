# Prova da etapa 0: Claude Code sem tela no Orange Pi

Código descartável. Responde, com medição, se o Claude Code serve de primeiro motor do awikabot.

## O que a prova confere

| Teste | Pergunta | Passa quando |
|---|---|---|
| 1. streaming | A resposta sai em eventos? | Chegam pelo menos dois trechos de texto antes do fim. |
| 2. aprovação | Um programa de fora aprova uma ação? | O gancho consulta o servidor de aprovação, espera, e o comando roda. |
| 3. negação | E nega? | O gancho recebe "negar" e o arquivo não é criado. |
| 4. retomada | A conversa volta depois de recriar o contêiner? | A palavra-chave guardada antes volta na resposta. |

Cada turno registra o tempo até o primeiro evento, o tempo até o primeiro texto e o pico de memória do processo do motor. O relatório fica em `/data/work/relatorio-*.json`, dentro do volume.

O servidor de aprovação faz o papel do celular: recebe o pedido, espera `AWIKA_ATRASO_APROVACAO` segundos e responde. A aprovação entra pelo gancho `PreToolUse` do próprio Claude Code, sem alterar o binário.

## Como rodar no Pi

Na pasta `~/awikabot-spike`, pela conta de deploy.

1. Login, feito pela pessoa dona da conta, uma vez. O comando mostra um endereço para abrir no navegador; o login fica no volume, dentro do contêiner.

   ```sh
   docker compose run --rm -it prova claude auth login
   ```

2. Testes 1 a 3 e a primeira metade do 4:

   ```sh
   docker compose run --rm prova
   ```

3. Segunda metade do teste 4, num contêiner novo:

   ```sh
   docker compose run --rm prova node /opt/prova/prova.mjs retomar
   ```

4. Espera longa, para provar que a aprovação aguenta minutos:

   ```sh
   AWIKA_ATRASO_APROVACAO=180 docker compose run --rm prova
   ```

Variáveis opcionais: `AWIKA_MODELO` escolhe o modelo; `AWIKA_CLAUDE_BIN='node /opt/prova/falso-claude.mjs'` troca o motor por um simulador, que serve só para testar a própria prova sem login.

## Login e termos de uso

A página "Legal and compliance" da documentação do Claude Code permite que uma pessoa entre com a própria assinatura no binário sem modificação. Ela proíbe que um aplicativo de terceiros ofereça o login do Claude.ai, guarde ou repasse esse login, ou use a assinatura de uma pessoa em nome de outra. Por isso:

- cada pessoa entra com a própria conta, pelo fluxo do próprio Claude Code;
- o awikabot nunca recebe, guarda nem repassa esse login;
- bots compartilhados entre pessoas usam chave de API, não assinatura.

A página não diz se um servidor sempre ligado, comandado pelo celular, conta como uso comum da assinatura. Ela manda perguntar à Anthropic em caso de dúvida.

## Limpeza

```sh
docker compose down -v
docker image rm awikabot-spike:etapa0
```

Depois, apagar a pasta `~/awikabot-spike`. O `down -v` apaga também o login guardado no volume.
