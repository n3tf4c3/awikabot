# Túnel: o acesso de fora ao servidor

O servidor só ouve em loopback no host. Quem está fora da rede de casa chega a ele por um túnel nomeado da Cloudflare, que dá um endereço fixo com HTTPS sem abrir porta no roteador. O túnel é o serviço `tunel` de `deploy/compose.yaml` e só sobe com o perfil `tunel`.

```text
app ── HTTPS ──▶ Cloudflare ── túnel ──▶ contêiner tunel ── http://server:8790 ──▶ servidor
```

## O que fica onde

- **No painel da Cloudflare**: o túnel, o endereço público e o destino dele. Quem tem a conta é quem cria.
- **No host do servidor**: só o token do túnel, em `deploy/.env`, que o Git ignora.
- **No repositório**: o serviço do compose e este documento. Nenhum token.

## Ligar

1. No painel da Cloudflare, em Networking > Tunnels, criar um túnel. O painel mostra um comando de instalação com o token; do comando, só o token interessa.
2. No host do servidor, gravar o token em `deploy/.env` e fechar o arquivo para os outros usuários:

   ```sh
   printf 'AWIKA_TUNEL_TOKEN=%s\n' '<token>' > deploy/.env
   chmod 600 deploy/.env
   ```

3. Subir o servidor com o túnel. O painel só deixa seguir depois de ver o túnel conectado:

   ```sh
   docker compose -f deploy/compose.yaml --profile tunel up -d
   ```

4. No túnel, na aba Routes, acrescentar uma rota do tipo Published application: o endereço escolhido, com `http://server:8790` em Service URL. Nenhuma outra rota.
5. Conferir, de fora da rede de casa:

   ```sh
   curl -s https://<endereço>/healthz
   ```

   Esperado: `{"status":"ok"}`. Depois, parear um aparelho por esse endereço e mandar uma mensagem a um bot: a resposta tem de chegar aos poucos, não de uma vez no fim.

Sem o perfil, `docker compose up -d` sobe só o servidor, como antes. Com o perfil e sem o token, o contêiner do túnel reinicia sem parar, com a mensagem `"cloudflared tunnel run" requires the ID or name of the tunnel`; o servidor não é afetado.

## O que o túnel alcança

- Só `server:8790`, a porta da API. A porta do gancho ouve em loopback dentro do contêiner do servidor e nunca ganha rota.
- As métricas do cloudflared ficam em loopback dentro do contêiner do túnel. Por padrão, num contêiner, elas ouviriam na rede que o servidor e os bots enxergam.
- O contêiner do túnel roda sem privilégios, com sistema de arquivos somente leitura e a imagem fixada por digest. Trocar de versão é trocar a etiqueta e o digest juntos, de uma versão que não acabou de sair.

## O que passa a ficar exposto

- `GET /healthz` responde a qualquer um, e só diz o estado.
- `POST /v1/parear` responde a qualquer um. Cinco códigos errados de uma origem bloqueiam o pareamento dessa origem por dez minutos; a origem é o endereço que a Cloudflare manda no `CF-Connecting-IP`, e o IPv6 conta pelo /64. Mil erros no servidor inteiro, na mesma janela, bloqueiam todas as origens: para manter o pareamento bloqueado para todos, alguém de fora precisa errar de duzentas origens diferentes a cada dez minutos. Os aparelhos já pareados não são afetados. Um limite de pedidos por origem antes do servidor, se for preciso, é regra do painel da Cloudflare.
- Todo o resto de `/v1` pede o token de um aparelho.
- A Cloudflare termina o HTTPS: o tráfego passa por ela em claro, inclusive o token do aparelho e as conversas.

## Trocar o token e desligar

- **Trocar**: gerar outro token no painel, gravar em `deploy/.env` e recriar o contêiner com `docker compose -f deploy/compose.yaml --profile tunel up -d tunel`. Depois de ver o endereço responder, invalidar o token antigo no painel.
- **Desligar**: `docker compose -f deploy/compose.yaml --profile tunel stop tunel`. O servidor continua no ar em loopback. Para tirar o endereço de vez, apagar a rota no painel.

## Limites

- A Cloudflare corta uma conexão que fica 100 segundos sem tráfego. O fluxo de eventos manda um sinal de vida a cada 15 segundos, e o app refaz a conexão do ponto em que parou.
- Com o túnel fora do ar, o app fora de casa não alcança o servidor e os pedidos de aprovação expiram. Dentro de casa, o endereço da rede local não é publicado pelo compose: o acesso continua pelo túnel.
