# Roteiro de release do app de desktop (Windows)

Como sai uma versão do app de desktop para Windows. Cada etapa só começa com a anterior aprovada, e as etapas se amarram pelo commit e pelo SHA-256 do instalador: o que foi conferido é o que foi testado, e o que foi testado é o que é publicado.

Tudo roda no computador de quem tem o certificado de assinatura. A chave fica em nuvem e pede sessão aberta nesse computador; ela não vai para a CI nem para o repositório. A CI monta o pacote sem assinatura a cada PR, só para o empacotamento não quebrar em silêncio.

Os comandos partem da raiz do repositório. Estado de cada etapa em 24/11/2026: a 1 rodou como ensaio, e a 4 rodou com o pacote de desenvolvimento, sem assinatura; a 3 só foi vista recusando esse pacote, como deve; a 2 com assinatura de verdade ainda não foi exercitada. A 5 e a 6 têm script e teste com um `gh` de mentira. Contra o GitHub de verdade, a 5 só rodou como ensaio, recusando o pacote de desenvolvimento, e a 6 parou antes de consultá-lo, por não haver rascunho. Nenhum rascunho foi criado ainda: criar, baixar de volta e publicar nunca rodaram contra o GitHub.

As etapas 3, 4 e 5 gravam cada uma um arquivo na pasta de evidências do commit, `relatorios/release/<versão>-<commit>`, e cada etapa lê os das anteriores. A pasta fica fora do Git.

## Antes

- A versão está em `[workspace.package]`, em `apps/desktop/Cargo.toml`. Subir a versão é um commit na `main`, por PR, antes de tudo. O atualizador só oferece versão maior que a instalada.
- A pasta não tem mudança sem commit e está na `main` atualizada.
- O Inno Setup, na versão fixada em `apps/desktop/distribuicao/windows/comum.ps1` (`$script:VersaoDoInnoSetup`), o Node e o `signtool` do Windows SDK estão instalados, e o Windows Sandbox está habilitado. Com outra versão do Inno Setup, o `empacotar.ps1` monta o instalador e para antes de assiná-lo.

## 1. Conferências do candidato

```powershell
powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/conferir-candidato.ps1
```

Roda a suíte TypeScript, o `pnpm verificar`, a auditoria do pnpm, rustfmt, clippy e os testes do Rust, o `cargo deny`, a consulta à OSV, a coleta das licenças e o teste dos scripts de publicação. Para na primeira falha. Grava `relatorios/release/<versão>-<commit>/candidato.json`.

Com mudança sem commit, recusa. `-PermitirMudancas` serve para ensaiar; a evidência sai marcada e não vale para publicar.

Uma vulnerabilidade apontada pelo `cargo deny` ou pela OSV para o pacote. Ou ela é corrigida, ou é aceita por escrito, com motivo e data, em `apps/desktop/deny.toml` ou em `avisos-osv.mjs`. Dependência sem manutenção que vem por dentro da GPUI é listada e não para o pacote.

## 2. Assinar e empacotar

Abrir a sessão do certificado em nuvem. Depois:

```powershell
powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/empacotar.ps1 -Assinar <impressão digital do certificado>
```

O script confere o certificado antes de compilar, para não falhar no fim. Compila o executável de distribuição, assina-o, junta as licenças e monta o instalador, que o próprio Inno Setup assina enquanto monta, junto com o desinstalador e a cópia interna do programa de instalação. Só então grava o manifesto e a lista de hashes. O certificado é usado várias vezes nesse passo. O pacote fica em `apps/desktop/target/distribuicao/pacotes/<versão>-<commit>`. Se essa pasta já existe, o script para: nada é sobrescrito.

O script recebe só a impressão digital. Senha e token nunca passam por ele.

Se a sessão do certificado cair no meio, a assinatura falha com "certificado não encontrado" ou erro do `signtool`. Reabrir a sessão, apagar a pasta do pacote e rodar de novo.

## 3. Conferir os artefatos

```powershell
powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/conferir-artefatos.ps1
```

Só passa um pacote publicável: de um commit sem mudança pendente, assinado, com carimbo de tempo, com hashes e versões batendo entre si, montado com o Inno Setup da versão fixada em `comum.ps1`, e aceito pelo próprio app com a regra do atualizador (`awikabot.exe --conferir-pacote <arquivo> <versão>`), que confere a assinatura e que o arquivo é o pacote daquela versão. Lista todos os problemas que achar. Aprovado, grava `artefatos.json`, com o SHA-256 dos três arquivos que vão para o release.

Esta etapa é a que garante que quem já instalou vai aceitar a versão nova. Trocar de certificado, de titular ou de autoridade faz o app instalado recusar o pacote: antes disso, publicar uma versão que aceite os dois.

## 4. QA no Windows Sandbox

```powershell
powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/qa-sandbox.ps1
powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/qa-sandbox.ps1 -ComRede -MarcaDeDownload
```

A primeira rodada é sem rede. A segunda marca o instalador como baixado da Internet e liga a rede, para o Windows consultar a reputação do arquivo, como aconteceria com quem baixa pelo navegador. Com pacote assinado, o Smart App Control fica ligado nas duas.

O roteiro instala, abre o app, atualiza por cima com o app aberto, desinstala e confere que não sobrou arquivo, atalho, registro, pasta de dados, credencial no cofre nem processo. Cada rodada grava uma `evidencia.json` com o SHA-256 do instalador testado, em `apps/desktop/target/distribuicao/qa-sandbox/<data>`, e deixa uma cópia na pasta de evidências do commit: `qa-sandbox-sem-rede.json` ou `qa-sandbox-com-rede.json`. Vale a rodada mais recente de cada tipo, aprovada ou não.

Nada é instalado no computador de trabalho. Um Sandbox por vez.

`-DesligarSmartAppControl` existe só para o pacote de desenvolvimento, sem assinatura, e vale só dentro do Sandbox. Pacote que vai ser publicado não usa essa opção.

## 5. Publicar como rascunho

```powershell
powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/publicar-rascunho.ps1 -Ensaio
powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/publicar-rascunho.ps1
```

Com `-Ensaio`, confere tudo, consulta o GitHub e não envia nada. Rodar primeiro assim.

O script só sobe um pacote que passou por tudo:

- assinado e saído de um commit sem mudança pendente, que está na `main` do repositório e declara a versão do pacote;
- com as conferências do candidato, a conferência dos artefatos e as duas rodadas de QA aprovadas, todas daquele commit e daquele instalador, com o Smart App Control ligado;
- com os três arquivos ainda iguais aos que a etapa 3 conferiu;
- com versão maior que a última pública, e etiqueta que ainda não existe, nem em rascunho.

Passando, cria o release em rascunho com a etiqueta `desktop-v<versão>` apontando para o commit e sobe o instalador, `awikabot-desktop-windows-x64.json` e `SHA256SUMS`. Depois baixa os três de volta e os compara com os conferidos. Só então grava `rascunho.json`, com o número do rascunho.

As notas do release saem de `apps/desktop/distribuicao/windows/notas-do-release.md`, com a versão, o SHA-256 do instalador e o commit. `-Notas <arquivo.md>` põe um texto de quem publica antes disso.

O rascunho não aparece para ninguém de fora nem para o atualizador, que só enxerga release público, e não cria a etiqueta. Se ele for criado e não conferir, o script avisa: apagar o rascunho no GitHub antes de tentar de novo. O script usa o `gh` com a sessão de quem roda; nenhum token passa por ele.

## 6. Aprovar

```powershell
powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/aprovar.ps1 -Versao <x.y.z> -Ensaio
powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/aprovar.ps1 -Versao <x.y.z>
```

Decisão do titular, à parte: a versão é escrita à mão, e quem roda sem `-Ensaio` é ele. Tornar o release público é o que faz o app de quem já instalou avisar da versão nova no dia seguinte.

Antes de publicar, o script confere de novo, contra o GitHub de agora: o rascunho é o que a etapa 5 criou, pelo número; aponta para o commit conferido; tem só os três arquivos, e eles, baixados de volta, são os que passaram pela etapa 3 e pelo QA. Publica pelo número do rascunho, não pela etiqueta. Depois confere que o release ficou público e que a etiqueta aponta para o commit, e grava `publicado.json`.

Depois de publicar, conferir num app instalado que o aviso aparece, que o download passa na conferência e que a instalação reabre o app na versão nova.

Não há como recolher uma versão publicada de quem já a instalou: o conserto é publicar outra, maior.

## Teste dos scripts de publicação

```powershell
powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/testes/testar-publicacao.ps1
```

Roda as etapas 5 e 6 de verdade contra um `gh` de mentira, com pacote e evidências montados numa pasta temporária: o caminho bom e, depois, um defeito por vez, que o script tem de recusar pelo motivo certo, sem criar rascunho nem publicar. Não toca o GitHub nem `relatorios/`. Faz parte das conferências do candidato.

## O que o roteiro não cobre

- Windows 10: o Sandbox só prova o Windows 11.
- Instalação por um usuário sem privilégios de administrador: a conta do Sandbox é administradora. O QA confere o lugar dos arquivos e do registro.
- Queda de energia no meio de uma atualização, e atualização pedida no meio de uma resposta de bot.
- O aviso de reputação do SmartScreen, que deve aparecer nos primeiros downloads mesmo com assinatura válida.
- macOS, que ainda não tem pacote.
