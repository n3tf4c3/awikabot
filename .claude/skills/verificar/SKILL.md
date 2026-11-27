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
2. **Dirigir**: os fluxos F0 a F5 e O1 e O2 do mapa, pelo lado do servidor: saúde, pareamento com código gerado pelo comando `parear`, criar e editar um bot, um turno com resposta aos poucos, a parada de um turno, e a aprovação: ação aprovada, ação negada, leitura fora da pasta do bot, gravação fora da pasta e na configuração do motor, a ação que não cabe inteira no cartão, e o gancho sem servidor. Depois mata o servidor no meio de um turno, sobe de novo com os mesmos dados e confere o histórico. Por fim, faz o backup com o servidor no ar e o restaura numa pasta nova, com um segundo servidor nas duas portas seguintes: confere o banco com `conferir-banco` e revoga os aparelhos com `revogar-todos`, como o `restaurar.sh`, confere que o token do backup é recusado e que um pareamento novo vê os mesmos bots e mensagens.
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

Nesse modo o comando também confere que o bot lembra do turno anterior e prova a aprovação pelo disco: o arquivo do comando aprovado existe na pasta do bot, e o do comando negado não; a gravação fora da pasta e em `.claude/settings.json` não deixa arquivo, mesmo com todo cartão aprovado. Por isso ele precisa rodar dentro do contêiner do servidor, como acima.

Depois de mexer na chamada do motor, na política ou na configuração gerenciada, conferir também que uma configuração plantada na pasta do bot não tem efeito: gravar, pelo host, um `.claude/settings.json` com um gancho de início de sessão que cria um arquivo, rodar um turno e conferir que o arquivo não apareceu.

### Com o Codex

Com `-e AWIKA_VERIFICAR_MOTOR=codex` no segundo comando, o bot do runbook nasce no Codex. O servidor precisa ter feito o login do Codex (ver `deploy/compose.yaml`) e aceitar bot nele: enquanto o catálogo não o marca como pronto, suba o servidor com `AWIKA_MOTORES_EM_PROVA=codex`, num arquivo de compose a mais ou no `deploy/.env`, e tire a variável depois. Nesse modo os pedidos usam o terminal e a edição de arquivos do Codex, a leitura na pasta do bot também passa por cartão (no Codex, até um `cat` vira pedido), a leitura fora da pasta tenta o `codex/auth.json`, a gravação na configuração é em `.codex/config.toml`, e há uma conferência a mais: a busca na web não roda.

Para provar que a configuração gerenciada de `/etc/codex` vence a do usuário, grave antes, no volume, um `codex/config.toml` que liga o que ela desliga (`web_search = "live"`, `approval_policy = "never"`, `[features] apps = true`) e devolva o original no fim.

### Com o Antigravity

Com `-e AWIKA_VERIFICAR_MOTOR=antigravity` no segundo comando, o bot do runbook nasce no Antigravity. O servidor precisa do acesso dele (a chave em `GEMINI_API_KEY`, ou o login feito pela pessoa dona da conta; ver `deploy/compose.yaml`) e de `AWIKA_MOTORES_EM_PROVA=antigravity` no ambiente do serviço, num arquivo de compose a mais, porque o catálogo ainda não o marca como pronto. Nesse modo os pedidos de arquivo levam o caminho completo dentro da pasta do bot, porque a sessão abre fora dela; o comando de terminal não leva, e o cartão o mostra com `cd '<pasta do bot>' &&` na frente. A leitura na pasta do bot passa sem cartão, a leitura fora da pasta tenta o login do próprio Antigravity, a gravação na configuração é em `.agents/hooks.json`, e a busca na web não roda.

Depois de mexer no driver, no gancho ou na configuração do Antigravity, conferir também, com um turno de verdade: que `pwd` sem `cd` devolve a pasta do bot e que um arquivo de caminho relativo cai nela; e que uma configuração plantada não tem efeito. Para isso, gravar pelo host um `.agents/hooks.json` com um gancho que cria um arquivo, na pasta do bot e na pasta da sessão (`<AWIKA_DADOS>/antigravity/<bot>`), trocar o `~/.gemini/config/hooks.json` pelo mesmo, rodar um turno e conferir que o arquivo não apareceu, que a pasta da sessão ficou vazia e que o gancho pessoal voltou a ser o do servidor.

O modelo do Codex nem sempre pede: às vezes responde "negado" sem tentar. A conferência da ação negada depende de surgir um pedido; quando ela falha com zero pedidos, ler a resposta gravada antes de concluir que a trava falhou.

## Ensaio no host: queda, vigia, backup e restauração

O comando acima mata e sobe o processo do servidor, mas não passa pelo Docker. O que depende do contêiner é conferido no host, à mão, depois de uma mudança em `deploy/`, no `Dockerfile`, em `saude.ts` ou em `backup.ts`. Usar um servidor de ensaio, nunca um com dado real:

```sh
export COMPOSE_PROJECT_NAME=awikabot-ensaio AWIKA_SUBREDE=172.28.0.0/16 AWIKA_PORTA_HOST=8799
C="docker compose -f deploy/compose.yaml"
```

1. **Queda (F5)**: com um turno em andamento, matar o processo do servidor e esperar a volta.

   ```sh
   $C exec -T server sh -c 'kill -9 "$(cat /data/vigia.pid)"'
   ```

   Esperado: `/healthz` responde de novo em segundos, o `RestartCount` do contêiner sobe em um, a resposta interrompida aparece como `falhou` com o texto que já tinha chegado, e o bot responde a um turno novo lembrando da conversa.
2. **Vigia (O2)**: travar o servidor sem matá-lo e esperar.

   ```sh
   $C exec -T server sh -c 'kill -STOP "$(cat /data/vigia.pid)"'
   ```

   Esperado: em até dois minutos o `RestartCount` sobe em um e `/healthz` volta a responder.
3. **Backup (O1)**: `sh deploy/backup.sh <pasta>`. Esperado: um `.tar` e o `.sha256` dele, que confere; `tar -tf` não lista nenhum arquivo de login; nenhuma cópia do banco fica em `/data/backup`. Com o servidor parado (`$C stop server`), o mesmo comando sai com erro e a pasta fica sem arquivo e sem `.sha256`. Dois backups ao mesmo tempo na mesma pasta: fica um `.tar` com o `.sha256` conferindo, ou dois, se caíram em segundos diferentes, e nenhuma pasta `.awikabot-backup.*`. Os defeitos do empacotamento, um por vez, são do `sh deploy/testes/testar.sh`, que não usa Docker.
4. **Restauração (O1)**: em outro projeto, com volume novo, `sh deploy/restaurar.sh <arquivo.tar>` e `$C up -d`. Antes, com um `.sha256` de outro backup ao lado do arquivo escolhido, e com um arquivo cortado: os dois são recusados e o volume fica vazio. Esperado na restauração boa: o script mostra o banco conferido e diz que os aparelhos do backup foram revogados; o volume não fica com pasta `.restaurando-*`, e o login do motor que já estivesse nele continua lá; o token do aparelho de origem recebe 401; depois de parear de novo (`$C exec -T server node /app/server.mjs parear`), aparecem os mesmos bots e as mesmas conversas do servidor de origem. Repetir o comando com o servidor no ar e depois com ele parado: os dois são recusados. Para conferir que o bot lembra da conversa, o volume restaurado precisa do login do motor.
5. **Contexto do build**, depois de mudar o `.dockerignore` ou o que o `Dockerfile` copia: pôr arquivos marcadores sintéticos, sem credencial nenhuma, em `deploy/.env`, `apps/server/.env.local` e `apps/server/marcador.pem`; construir, com a raiz como contexto, uma imagem de teste que copia o contexto inteiro e lista esses nomes; e apagar os marcadores e a imagem. Esperado: nenhum marcador na lista. Depois, construir a imagem do produto e rodar um comando nela.
6. **Encerrar**: `$C down -v` nos projetos de ensaio e apagar a pasta do backup, que tem conversas.

## App de desktop

De dentro de `apps/desktop`, depois de `pnpm server:build`:

```sh
cargo test --workspace
```

Os testes sobem o servidor de verdade com o motor simulado. O de contrato confere o cliente; os de `janela.rs` dirigem a janela pelo teclado, sem tela. Eles não veem o desenho: quebra de linha, encaixe e cor só aparecem com o app aberto. No Windows:

```sh
cargo build -p awikabot-desktop
powershell -ExecutionPolicy Bypass -File ../../scripts/desktop-prova-visual.ps1
```

Para o instalador, quando ele ou o que ele instala mudou:

```sh
powershell -ExecutionPolicy Bypass -File distribuicao/windows/empacotar.ps1
powershell -ExecutionPolicy Bypass -File distribuicao/windows/qa-sandbox.ps1 -DesligarSmartAppControl
```

O primeiro comando monta o pacote sem assinatura em `target/distribuicao/pacotes`; se a pasta daquela versão e daquele commit já existe, ele para, e é preciso apagá-la. O segundo abre o Windows Sandbox, que roda o roteiro sozinho e fecha em poucos minutos: instala em silêncio, confere arquivos, atalho com a identidade e registro só do usuário, abre o app, tenta desinstalar com o app aberto, atualiza por cima com o app aberto, desinstala e confere que não sobrou arquivo, atalho, registro, credencial no cofre nem processo. `-DesligarSmartAppControl` vale só dentro do Sandbox e só existe porque o pacote de teste não tem assinatura; com pacote assinado, rodar sem ela, e uma segunda vez com `-ComRede -MarcaDeDownload`. Relatar os passos que passaram e falharam, o estado do Smart App Control e se o pacote estava assinado. Nada é instalado neste computador.

O script pareia, cria um bot pelo formulário, aprova um pedido no cartão, para uma resposta, minimiza a janela e manda um pedido por outro aparelho para ver o aviso do sistema, nega esse pedido, fecha, reabre no tema claro com a sessão que estava no cofre do sistema e despareia. Ele grava capturas numa pasta temporária, cujo caminho imprime, e diz: quantos avisos o sistema recebeu com a janela minimizada, se algum mostra o conteúdo do pedido, quantos sobraram depois de voltar ao app, quantos pedidos ficaram pendentes no servidor, e se a sessão estava no cofre depois de parear e depois de desparear. Os cliques são por coordenada: depois de mudar o desenho da tela, conferir as coordenadas no começo do script. A sessão de quem desenvolve não é tocada: a prova usa um item só dela no cofre, e apaga no fim os avisos e o registro da identidade do build de desenvolvimento, se foi ela que criou. Durante a prova aparece um aviso de verdade na tela. Olhar as imagens é parte da verificação, e apagar a pasta depois também. No macOS não há prova visual: relatar como não verificado.

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
