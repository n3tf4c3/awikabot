# Prova do passo 1 da etapa 7: Codex e Antigravity sem tela

Código descartável. Responde, com medição, se o Codex e o Antigravity servem de motor do awikabot e em qual papel, e como o orquestrador do Claude Code entrega uma tarefa ao servidor. O resultado está no `PLANO.md`, em "Etapa 7, passo 1: resultado da prova".

## O que a prova confere

Para cada motor (`codex` ou `agy`), `prova/prova.mjs` roda um turno por teste:

| Teste | Pergunta | Passa quando |
|---|---|---|
| `eventos` | A resposta sai em eventos, aos poucos? | Chegam dois ou mais eventos de texto, espalhados no tempo. |
| `aprovar`, `negar` | Um programa de fora responde ao pedido? | O gancho consulta o servidor de aprovação; o comando só roda com "aprovar". |
| `fora-do-ar`, `demora`, `ilegivel` | E quando esse programa falha? | O gancho nega e o comando não roda. |
| `gancho-sai1`, `gancho-lixo`, `gancho-mudo`, `gancho-trava` | E quando o próprio gancho quebra? | O motor não roda o comando. |
| `fora-da-pasta` | Gravar fora da pasta de trabalho é barrado? | Com o servidor aprovando tudo, o arquivo não aparece fora da pasta. |
| `guardar` | O modelo e o esforço mudam sem perder a conversa? | A palavra guardada num turno volta no seguinte, com outro modelo e outro esforço. |
| `retomar` | A conversa volta depois de recriar o contêiner? | A palavra guardada volta num contêiner novo. |

Cada turno registra o tempo de cada evento de texto e o pico de memória da árvore de processos do motor. As linhas brutas de cada turno e o relatório ficam em `/data/registros`, dentro do volume.

O servidor de aprovação da prova faz o papel do servidor do awikabot e do celular. O gancho é `prova/gancho.mjs`, o mesmo para os dois motores.

`prova/prova-codex-servidor.mjs` dirige o Codex pelo servidor de aplicativo (`codex app-server`), que é onde o texto sai em trechos e onde a aprovação chega como pedido ao programa que o dirige. O `codex exec`, que o `prova.mjs` usa, nunca pede aprovação. Os testes são os mesmos, mais `cliente-morre`, `leitura`, `leitura-fora`, `dentro-edicao`, `fora-terminal`, `fora-edicao`, `busca` e `esquema`.

`prova/prova-agy-acp.mjs` dirige o Antigravity pelo ACP (`agy acp`), que também traz o pedido de permissão ao programa que o dirige. Usa a chave da API do Gemini, se ela estiver no volume, ou a conta guardada com `agy acp --login`. `AWIKA_AGY_AJUSTES` leva ajustes ao `settings.json` dele, e `AWIKA_AGY_GANCHO` instala um gancho que nega, permite ou quebra de um jeito escolhido (`prova/gancho-nega.mjs`). Com `AWIKA_AGY_GANCHO=lista:<modo>` o gancho é o `prova/gancho-lista.mjs`, que vale para toda ferramenta e nega o que não conhece: os modos são `nega`, `espera-permite:<s>` e `espera-nega:<s>`, e dizem o que ele faz com a busca na web. `AWIKA_PRAZO_GANCHO_S` é o prazo que o `agy` dá ao gancho, e `AWIKA_GANCHO_SO_ANOTA=1` faz o gancho só anotar o nome de cada ferramenta, que é como se levantam os nomes de verdade. `prova/gancho-da-pasta.sh` planta um gancho e um servidor MCP numa pasta e confere se rodaram; com `AWIKA_TRABALHO` a sessão abre em outra pasta, que é como se prova que a configuração da subpasta do bot não é lida.

`orquestrador/prova-orquestrador.mjs` é a parte do Claude Code: compara a ferramenta própria, dada por um servidor MCP na linha de comando, com a lista no fim da resposta, conferida por esquema.

## Como rodar

Da pasta `spike/motores-etapa-7`. O login de cada CLI é da pessoa dona da conta, feito pelo fluxo da própria CLI, e fica no volume do Docker, fora do repositório.

```sh
docker compose build

# Login, uma vez por CLI. O Antigravity não usa conta: usa a chave da API do Gemini, que a
# pessoa cola sem eco e que fica só no volume.
docker compose run --rm -it prova codex login --device-auth
docker compose run --rm -it prova claude auth login
docker compose run --rm -it prova sh /opt/prova/guardar-chave.sh

# Os testes de um motor, e depois a retomada num contêiner novo.
docker compose run --rm prova node /opt/prova/prova.mjs codex tudo
docker compose run --rm prova node /opt/prova/prova.mjs codex retomar

# O Codex pelo servidor de aplicativo, com a caixa de areia só de leitura: é o modo que entra no produto.
AWIKA_CODEX_SANDBOX=read-only docker compose run --rm prova node /opt/prova/prova-codex-servidor.mjs tudo
AWIKA_CODEX_SANDBOX=read-only docker compose run --rm prova node /opt/prova/prova-codex-servidor.mjs retomar

# O Antigravity pelo ACP, com a conta ou com a chave que estiver no volume.
docker compose run --rm -it prova agy acp --login
docker compose run --rm prova node /opt/prova/prova-agy-acp.mjs tudo
docker compose run --rm prova node /opt/prova/prova-agy-acp.mjs retomar
docker compose run --rm -e 'AWIKA_AGY_GANCHO=nega:search_web|read_url_content' prova node /opt/prova/prova-agy-acp.mjs busca
docker compose run --rm -e AWIKA_AGY_GANCHO=lista:nega prova node /opt/prova/prova-agy-acp.mjs busca subagente agendar aprovar
docker compose run --rm -e AWIKA_AGY_GANCHO=lista:nega -e AWIKA_GANCHO_SO_ANOTA=1 prova node /opt/prova/prova-agy-acp.mjs ferramentas

# Um teste avulso.
docker compose run --rm prova node /opt/prova/prova.mjs agy gancho-trava

# O orquestrador no Claude Code: gancho pela opção e pela configuração gerenciada.
docker compose run --rm prova node /opt/orquestrador/prova-orquestrador.mjs
docker compose run --rm orquestrador-gerenciado
```

No produto, o Antigravity roda por chave de API por decisão do titular, em 26/11; a prova pelo ACP usou a assinatura dele, por escolha dele para a prova. O motivo da decisão: a FAQ dele diz que embrulhar o `agy` num aplicativo de terceiros não é suportado em plano pessoal. Com `modelProvider: "gemini"` e `GEMINI_API_KEY`, a documentação diz que os pedidos vão direto à API do Gemini e que a CLI não abre sessão de conta. A prova grava o `modelProvider` sozinha quando acha a chave no volume, e só entrega a chave ao processo do `agy`.

O serviço `prova` tem as travas do contêiner do produto. O `prova-sem-filtro` tira o filtro de chamadas do Docker e serve só para medir a caixa de areia de cada CLI, que não sobe com o filtro.

Variáveis: `AWIKA_MODELO_A`, `AWIKA_MODELO_B`, `AWIKA_ESFORCO_A` e `AWIKA_ESFORCO_B` escolhem o modelo e o esforço dos dois turnos do teste `guardar`; `AWIKA_CODEX_SANDBOX`, `AWIKA_CODEX_APROVACAO`, `AWIKA_CODEX_GANCHOS` e `AWIKA_CODEX_ORIGEM_GANCHO` mudam o modo do Codex; `AWIKA_AGY_EXTRAS` acrescenta opções à linha do `agy`.

No Git Bash do Windows, ponha `MSYS_NO_PATHCONV=1` antes do comando: sem isso ele reescreve `/opt/prova/...` como caminho do Windows.

A prova do Codex rodou com `web_search = "disabled"` e `[features] apps = false` em `/data/codex/config.toml`, gravados à mão no volume depois do teste `busca`. Sem eles o Codex pesquisa na web e usa os conectores da conta sem pedir aprovação.

## Antivírus ou proxy que abre o TLS

No PC em que a prova rodou, o antivírus abre o TLS de `chatgpt.com` também no tráfego dos contêineres, e o login do Codex falhava na troca do código. O contorno é local e não entra no Git: o certificado raiz do antivírus, que é público, vai para `local/ca-da-maquina.pem`, e um `.env` ao lado do `compose.yaml` aponta para ele com `AWIKA_CA_EXTRA=./local/ca-da-maquina.pem`. A entrada do contêiner (`prova/entrada.sh`) junta esse certificado ao pacote do sistema e entrega o resultado às CLIs por `CODEX_CA_CERTIFICATE`, `SSL_CERT_FILE` e `NODE_EXTRA_CA_CERTS`. Sem o `.env`, nada disso acontece.

## Limpeza

```sh
docker compose down -v
docker image rm awikabot-spike:etapa7 awikabot-spike:etapa7-arm64
```

O `down -v` apaga também os logins guardados no volume.
