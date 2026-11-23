# Mapa de fluxos

Lista fechada do que uma pessoa consegue completar no awikabot. É a fonte das specs E2E, do runbook `verificar` e do QA de release. Fluxo sem teste fica escrito como "sem cobertura".

Levantado em 2026-11-23, na etapa 1 (esqueleto). Só o F0 existe; ele foi executado pelo `pnpm verificar` e pela suíte. Os fluxos F1 a F5 são a primeira versão descrita no `PLANO.md` e ainda não têm código.

| ID | Fluxo | Onde | Pré-condição | Passos | Resultado esperado | Escreve dado? | Teste |
|---|---|---|---|---|---|---|---|
| F0 | Saúde do servidor | servidor `GET /healthz` | servidor no ar | pedir `/healthz` | `200` com `status: "ok"`, a versão e o número do protocolo | não | `apps/server/src/app.test.ts` (integração sem tela) e `pnpm verificar` |
| F1 | Parear o celular | app, tela de pareamento | servidor no ar e código de pareamento válido | ler o QR ou digitar o código | o app passa a listar os bots desse servidor | sim | ainda não existe; sem cobertura |
| F2 | Criar e editar um bot | app, lista de bots | celular pareado | informar nome, instruções, motor e modelo, pasta de trabalho | o bot aparece na lista com os dados informados | sim | ainda não existe; sem cobertura |
| F3 | Conversar e parar um turno | app, conversa do bot | bot criado e motor com login | enviar uma mensagem; acionar "Parar" durante a resposta | o texto chega aos poucos; ao parar, o turno termina | sim | ainda não existe; sem cobertura |
| F4 | Aprovar ou negar uma ação | app, cartão de aprovação e aviso push | turno que pede uma ação | acionar "Aprovar" ou "Negar", com o app aberto e fechado | a ação só roda depois do "Aprovar"; com "Negar", não roda | sim | ainda não existe; sem cobertura |
| F5 | Ver o estado depois de reiniciar | app, lista de bots e conversa | servidor reiniciado no meio de um turno | abrir o app depois da volta do servidor | o histórico aparece e o turno interrompido está marcado | não | ainda não existe; sem cobertura |
