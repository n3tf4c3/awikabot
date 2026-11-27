# Achados de auditoria

Registro versionado da numeração e do status dos achados de auditoria, verificação de segurança e teste dinâmico. A numeração é contínua e nunca recomeça. Os relatórios ficam em `relatorios/`, fora do Git.

Status: `ABERTO`, `PARCIAL`, `RESOLVIDO`, `ACEITO`, `ADIADO`, `FALSO POSITIVO (justificado)`.

## Rodadas

| Data | Tipo | Commit | Relatório |
|---|---|---|---|
| 2026-11-23 | Verificação de segurança (estática) | `e9095e9` | `relatorios/seguranca-2026-11-23-211005.md` |
| 2026-11-23 | Resolução dos achados 1 a 8, com teste dinâmico do achado 1 | a partir de `e9095e9` | adendo no mesmo relatório |
| 2026-11-24 | Verificação de segurança (estática): servidor, celular, desktop, instalador, atualizador, release e CI | `f9616d6` | `relatorios/seguranca-2026-11-24-153000.md` |
| 2026-11-24 | Resolução dos achados 9 e 10, com QA no Sandbox do pacote sem assinatura | a partir de `f9616d6` | adendo no mesmo relatório |
| 2026-11-24 | Verificação de segurança (estática), reemitida depois do PR 15: aprovada como gate, sem achado novo | `1d1368c` | `relatorios/seguranca-2026-11-24-160600.md` |
| 2026-11-27 | Auditoria técnica completa, achados 11 a 37 | `fdc1ad8` | `C:\Codes\hobby\relatorios\awikabot\auditoria-2026-11-27-023025.md` |

## Achados

| Nº | Título | Severidade | Status | Origem e prova |
|---|---|---|---|---|
| 1 | Aprovar uma gravação aprovava qualquer caminho e conteúdo; configuração plantada na pasta do bot rodava comandos sem aprovação | Alta (registrado como Média; confirmado em teste dinâmico) | RESOLVIDO | segurança 2026-11-23, C3. `politica.test.ts`, `gancho.test.ts`, runbook F4, e teste com o motor real: explorável antes, não explorável depois |
| 2 | Fluxo de eventos de aparelho revogado continuava enquanto houvesse atividade | Média | RESOLVIDO | segurança 2026-11-23, B1. `app.test.ts`, revogação no meio de um turno |
| 3 | Motor recebia o ambiente inteiro do servidor; gancho lia variável fora do esquema | Baixa | RESOLVIDO | segurança 2026-11-23, A3. `env.test.ts`; runbook com o motor real |
| 4 | Cabeçalhos de segurança incompletos na API | Baixa | RESOLVIDO | segurança 2026-11-23, D1. `app.test.ts` |
| 5 | `/healthz` sem token devolvia versão e protocolo | Baixa | RESOLVIDO | segurança 2026-11-23, D11. `app.test.ts`, runbook F0 |
| 6 | Imagem base fixada por tag, sem digest | Baixa | RESOLVIDO | segurança 2026-11-23, H1. Imagem construída em amd64 e arm64 |
| 7 | Saída de erro do motor ia para o log sem filtro | Baixa | RESOLVIDO | segurança 2026-11-23, I1. `gancho.test.ts` (classificação da falha) |
| 8 | `restaurar.sh` extraía qualquer entrada do arquivo de backup | Baixa | RESOLVIDO | segurança 2026-11-23, fora da baseline. Ensaio no host: arquivo adulterado recusado |
| 9 | O atualizador do desktop aceitava um pacote assinado pelo publicador sem conferir que era a versão oferecida | Baixa (passaria a Média com uma versão pública de defeito de segurança corrigido depois) | RESOLVIDO | segurança 2026-11-24, fora da baseline. `confianca.rs` e `atualizador.rs`: três testes que falham sem a correção, leitura do nome e da versão num instalador de verdade, e QA no Sandbox aprovado. O instalador segue aceitando versão menor rodada à mão, por decisão (`docs/decisoes.md`) |
| 10 | O compilador do instalador (Inno Setup) não tinha versão fixada nem registrada no pacote | Baixa | RESOLVIDO | segurança 2026-11-24, H1. Versão fixa em `comum.ps1`, gravada no `build-info.json` e exigida pelo `conferir-artefatos.ps1`; `testar-publicacao.ps1` 43 de 43; QA no Sandbox aprovado com o pacote montado pela versão fixada |
| 11 | Restaurar uma cópia anterior à revogação reativa a credencial do aparelho | Alta | ABERTO | auditoria técnica 2026-11-27, item 11. `apps/server/src/dispositivos.ts:46–51,78–80` |
| 12 | Uma falha do empacotamento pode produzir um backup anunciado como concluído | Alta | ABERTO | auditoria técnica 2026-11-27, item 12. `deploy/backup.sh:37–56` |
| 13 | O cartão permite aprovar uma operação maior que o conteúdo apresentado | Alta | ABERTO | auditoria técnica 2026-11-27, item 13. `apps/server/src/politica.ts:55–58,96–109,158` |
| 14 | Execuções concorrentes podem apagar a cópia de backup de outra execução | Média | ABERTO | auditoria técnica 2026-11-27, item 14. `apps/server/src/backup.ts:49–55,69–73` |
| 15 | O checksum do restore pode conferir um arquivo diferente do selecionado | Média | ABERTO | auditoria técnica 2026-11-27, item 15. `deploy/restaurar.sh:23–27,32,71` |
| 16 | Restore interrompido deixa o volume parcialmente preenchido | Média | ABERTO | auditoria técnica 2026-11-27, item 16. `deploy/restaurar.sh:32–38,53–65,69–71` |
| 17 | Uma pausa do motor prolonga a janela de perda do texto parcial | Média | ABERTO | auditoria técnica 2026-11-27, item 17. `apps/server/src/turnos.ts:88–108` |
| 18 | O servidor ainda aceita turnos enquanto aguarda o desligamento | Média | ABERTO | auditoria técnica 2026-11-27, item 18. `apps/server/src/main.ts:105–118` |
| 19 | A trava do pareamento admite tentativas sobrepostas além do limite | Média | ABERTO | auditoria técnica 2026-11-27, item 19. `apps/server/src/app.ts:105–114` |
| 20 | O consumo do código e a criação do aparelho não são atômicos | Média | ABERTO | auditoria técnica 2026-11-27, item 20. `apps/server/src/dispositivos.ts:31–42` |
| 21 | O início de turno grava as duas mensagens sem unidade de recuperação | Média | ABERTO | auditoria técnica 2026-11-27, item 21. `apps/server/src/turnos.ts:80–100,110–118,145–155` |
| 22 | Conexão SSE lenta acumula uma fila sem limite próprio | Média | ABERTO | auditoria técnica 2026-11-27, item 22. `apps/server/src/app.ts:223–248` |
| 23 | A consulta de aprovações do histórico não tem índice por mensagem | Média | ABERTO | auditoria técnica 2026-11-27, item 23. `apps/server/src/banco.ts:47–60` |
| 24 | O desktop só oferece a primeira página do histórico | Média | ABERTO | auditoria técnica 2026-11-27, item 24. `apps/desktop/crates/cliente/src/api.rs:191–195` |
| 25 | O desktop apaga o rascunho antes de saber se o envio foi aceito | Média | ABERTO | auditoria técnica 2026-11-27, item 25. `apps/desktop/crates/app/src/janela.rs:341,489–506,1242–1247` |
| 26 | O rascunho do desktop acompanha a janela quando a pessoa troca de bot | Média | ABERTO | auditoria técnica 2026-11-27, item 26. `apps/desktop/crates/app/src/janela.rs:139,340–342,449–457,489–502` |
| 27 | Resposta HTTP atrasada pode desfazer um evento final já aplicado no desktop | Média | ABERTO | auditoria técnica 2026-11-27, item 27. `apps/desktop/crates/app/src/janela.rs:468–482,503–509,885–900,973–975` |
| 28 | Falha ao carregar aprovações pendentes no celular fica silenciosa | Média | ABERTO | auditoria técnica 2026-11-27, item 28. `apps/mobile/src/provedores/dados.tsx:46–48,56–58` |
| 29 | A decisão de aprovação no desktop não é alcançável pelo teclado | Média | ABERTO | auditoria técnica 2026-11-27, item 29. `apps/desktop/crates/app/src/janela.rs:923–942,979–985,1179–1184,1472–1474` |
| 30 | O contador de caracteres do celular diverge da regra Unicode do formulário | Baixa | ABERTO | auditoria técnica 2026-11-27, item 30. `apps/mobile/src/components/Campo.tsx:28,42–44` |
| 31 | A montagem da conversa móvel compara cada mensagem com todas as aprovações | Baixa | ABERTO | auditoria técnica 2026-11-27, item 31. `apps/mobile/src/lib/aprovacoes.ts:92–95,141–150` |
| 32 | O SDK Expo indica quatro dependências fora da faixa recomendada | Baixa | ABERTO | auditoria técnica 2026-11-27, item 32. `apps/mobile/package.json:17,20,22,25` |
| 33 | O contexto de build Docker admite arquivos locais de configuração | Baixa | ABERTO | auditoria técnica 2026-11-27, item 33. `deploy/compose.yaml:25–26,48,57` |
| 34 | Desligar o aviso de atualização não cancela uma consulta já agendada | Baixa | ABERTO | auditoria técnica 2026-11-27, item 34. `apps/desktop/crates/app/src/atualizador.rs:59,136–160,169–173` |
| 35 | Duas instâncias do desktop compartilham e limpam a mesma área de atualização | Baixa | ABERTO | auditoria técnica 2026-11-27, item 35. `apps/desktop/crates/app/src/main.rs:63–64,85` |
| 36 | A seleção da última versão do desktop só consulta uma página de releases | Baixa | ABERTO | auditoria técnica 2026-11-27, item 36. `apps/desktop/crates/cliente/src/atualizacao.rs:229–246` |
| 37 | O teste de interrupção do Codex depende da velocidade de inicialização | Baixa | ABERTO | auditoria técnica 2026-11-27, item 37. `apps/server/src/motor-codex.test.ts:77,211–215` |
