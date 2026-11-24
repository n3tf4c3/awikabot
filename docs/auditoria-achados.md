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
