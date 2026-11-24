# Roteiro de release do app de desktop (Windows)

Como sai uma versão do app de desktop para Windows. Cada etapa só começa com a anterior aprovada, e as etapas se amarram pelo commit e pelo SHA-256 do instalador: o que foi conferido é o que foi testado, e o que foi testado é o que é publicado.

Tudo roda no computador de quem tem o certificado de assinatura. A chave fica em nuvem e pede sessão aberta nesse computador; ela não vai para a CI nem para o repositório. A CI monta o pacote sem assinatura a cada PR, só para o empacotamento não quebrar em silêncio.

Os comandos partem da raiz do repositório. Estado de cada etapa em 24/11/2026: a 1 rodou como ensaio, e a 4 rodou com o pacote de desenvolvimento, sem assinatura; a 3 só foi vista recusando esse pacote, como deve; a 2 com assinatura de verdade, a 5 e a 6 ainda não foram exercitadas.

## Antes

- A versão está em `[workspace.package]`, em `apps/desktop/Cargo.toml`. Subir a versão é um commit na `main`, por PR, antes de tudo. O atualizador só oferece versão maior que a instalada.
- A pasta não tem mudança sem commit e está na `main` atualizada.
- O Inno Setup 6, o Node e o `signtool` do Windows SDK estão instalados, e o Windows Sandbox está habilitado.

## 1. Conferências do candidato

```powershell
powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/conferir-candidato.ps1
```

Roda a suíte TypeScript, o `pnpm verificar`, a auditoria do pnpm, rustfmt, clippy e os testes do Rust, o `cargo deny`, a consulta à OSV e a coleta das licenças. Para na primeira falha. Grava `relatorios/release/<versão>-<commit>/candidato.json`.

Com mudança sem commit, recusa. `-PermitirMudancas` serve para ensaiar; a evidência sai marcada e não vale para publicar.

Uma vulnerabilidade apontada pelo `cargo deny` ou pela OSV para o pacote. Ou ela é corrigida, ou é aceita por escrito, com motivo e data, em `apps/desktop/deny.toml` ou em `avisos-osv.mjs`. Dependência sem manutenção que vem por dentro da GPUI é listada e não para o pacote.

## 2. Assinar e empacotar

Abrir a sessão do certificado em nuvem. Depois:

```powershell
powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/empacotar.ps1 -Assinar <impressão digital do certificado>
```

O script confere o certificado antes de compilar, para não falhar no fim. Compila o executável de distribuição, assina-o, junta as licenças, monta o instalador, assina-o, e só então grava o manifesto e a lista de hashes. O pacote fica em `apps/desktop/target/distribuicao/pacotes/<versão>-<commit>`. Se essa pasta já existe, o script para: nada é sobrescrito.

O script recebe só a impressão digital. Senha e token nunca passam por ele.

Se a sessão do certificado cair no meio, a assinatura falha com "certificado não encontrado" ou erro do `signtool`. Reabrir a sessão, apagar a pasta do pacote e rodar de novo.

## 3. Conferir os artefatos

```powershell
powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/conferir-artefatos.ps1
```

Só passa um pacote publicável: de um commit sem mudança pendente, assinado, com carimbo de tempo, com hashes e versões batendo entre si, e aceito pelo próprio app com a regra do atualizador (`awikabot.exe --conferir-pacote`). Lista todos os problemas que achar.

Esta etapa é a que garante que quem já instalou vai aceitar a versão nova. Trocar de certificado, de titular ou de autoridade faz o app instalado recusar o pacote: antes disso, publicar uma versão que aceite os dois.

## 4. QA no Windows Sandbox

```powershell
powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/qa-sandbox.ps1
powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/qa-sandbox.ps1 -ComRede -MarcaDeDownload
```

A primeira rodada é sem rede. A segunda marca o instalador como baixado da Internet e liga a rede, para o Windows consultar a reputação do arquivo, como aconteceria com quem baixa pelo navegador. Com pacote assinado, o Smart App Control fica ligado nas duas.

O roteiro instala, abre o app, atualiza por cima com o app aberto, desinstala e confere que não sobrou arquivo, atalho, registro, pasta de dados, credencial no cofre nem processo. Cada rodada grava uma `evidencia.json` com o SHA-256 do instalador testado, em `apps/desktop/target/distribuicao/qa-sandbox/<data>`. Copiar as duas para a pasta de evidências do candidato.

Nada é instalado no computador de trabalho. Um Sandbox por vez.

`-DesligarSmartAppControl` existe só para o pacote de desenvolvimento, sem assinatura, e vale só dentro do Sandbox. Pacote que vai ser publicado não usa essa opção.

## 5. Publicar como rascunho

Ainda sem script. Criar no GitHub um release em rascunho, com a etiqueta `desktop-v<versão>` apontando para o commit do candidato, e subir três arquivos do pacote: o instalador, `awikabot-desktop-windows-x64.json` e `SHA256SUMS`. Antes de subir, conferir que o SHA-256 do instalador é o das evidências das etapas 3 e 4.

O rascunho não aparece para o atualizador: ele só enxerga release público.

## 6. Aprovar

Decisão do titular, à parte. Tornar o release público é o que faz o app de quem já instalou avisar da versão nova no dia seguinte. Depois de publicar, conferir num app instalado que o aviso aparece, que o download passa na conferência e que a instalação reabre o app na versão nova.

Não há como recolher uma versão publicada de quem já a instalou: o conserto é publicar outra, maior.

## O que o roteiro não cobre

- Windows 10: o Sandbox só prova o Windows 11.
- Instalação por um usuário sem privilégios de administrador: a conta do Sandbox é administradora. O QA confere o lugar dos arquivos e do registro.
- Queda de energia no meio de uma atualização, e atualização pedida no meio de uma resposta de bot.
- O aviso de reputação do SmartScreen, que deve aparecer nos primeiros downloads mesmo com assinatura válida.
- macOS, que ainda não tem pacote.
