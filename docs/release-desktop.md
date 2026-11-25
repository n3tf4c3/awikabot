# Roteiro de release do app de desktop (Windows)

Como sai uma versão do app de desktop para Windows. Cada etapa só começa com a anterior aprovada, e as etapas se amarram pelo commit e pelo SHA-256 do instalador: o que foi conferido é o que foi testado, e o que foi testado é o que é publicado.

Tudo roda no computador de quem tem o certificado de assinatura. A chave fica em nuvem e pede sessão aberta nesse computador; ela não vai para a CI nem para o repositório. A CI monta o pacote sem assinatura a cada PR, só para o empacotamento não quebrar em silêncio.

Os comandos partem da raiz do repositório. Estado em 25/11/2026: o roteiro rodou inteiro duas vezes, com a 0.1.0, saída do commit `206b67f`, e com a 0.1.1, saída de `b410db0`. Na segunda, as rodadas de QA partiram também da 0.1.0 publicada. Depois de publicar, a atualização foi vista num app instalado: num Sandbox com rede, a 0.1.0 avisou da versão nova, baixou, conferiu e instalou a 0.1.1. Essa conferência foi feita com um roteiro avulso; o comando dela, `ver-atualizacao.ps1`, veio depois e a repetiu com as mesmas duas versões: seis de seis passos, primeiro com os cliques de uma pessoa e depois, duas vezes, com os cliques do próprio roteiro. Ainda em 25/11 o roteiro rodou inteiro pela terceira vez, com a 0.1.2, saída de `02c9d0b`: as rodadas de QA partiram da 0.1.1 publicada, a publicação cobrou isso, e a conferência depois de publicar rodou pelo comando, com `-Clicar`: a 0.1.1 instalada se atualizou para a 0.1.2, seis de seis passos.

As etapas 3, 4 e 5 gravam cada uma um arquivo na pasta de evidências do commit, `relatorios/release/<versão>-<commit>`, e cada etapa lê os das anteriores. A conferência depois de publicar grava lá também. A pasta fica fora do Git.

## Antes

- A versão está em `[workspace.package]`, em `apps/desktop/Cargo.toml`. Subir a versão é um commit na `main`, por PR, antes de tudo. O atualizador só oferece versão maior que a instalada.
- A pasta não tem mudança sem commit e está na `main` atualizada.
- O Inno Setup, na versão fixada em `apps/desktop/distribuicao/windows/comum.ps1` (`$script:VersaoDoInnoSetup`), o Node e o `signtool` do Windows SDK estão instalados, e o Windows Sandbox está habilitado. Com outra versão do Inno Setup, o `empacotar.ps1` monta o instalador e para antes de assiná-lo.

## 1. Conferências do candidato

```powershell
powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/conferir-candidato.ps1
```

Roda a suíte TypeScript, o `pnpm verificar`, a auditoria do pnpm, rustfmt, clippy e os testes do Rust, o `cargo deny`, a consulta à OSV, a coleta das licenças, o teste dos scripts de publicação e o teste da conferência depois de publicar. Para na primeira falha. Grava `relatorios/release/<versão>-<commit>/candidato.json`.

Com mudança sem commit, recusa. `-PermitirMudancas` serve para ensaiar; a evidência sai marcada e não vale para publicar.

Uma vulnerabilidade apontada pelo `cargo deny` ou pela OSV para o pacote. Ou ela é corrigida, ou é aceita por escrito, com motivo e data, em `apps/desktop/deny.toml` ou em `avisos-osv.mjs`. Dependência sem manutenção que vem por dentro da GPUI é listada e não para o pacote.

## 2. Assinar e empacotar

Abrir a sessão do certificado em nuvem. Depois:

```powershell
powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/empacotar.ps1 -Assinar <impressão digital do certificado>
```

O script confere o certificado antes de compilar, para não falhar no fim. Essa conferência não prova que a sessão está aberta: o certificado continua listado com a sessão fechada, e logo depois de aberta ela pode levar um instante para responder. Compila o executável de distribuição, assina-o, junta as licenças e monta o instalador, que o próprio Inno Setup assina enquanto monta, junto com o desinstalador e a cópia interna do programa de instalação. Só então grava o manifesto e a lista de hashes. O certificado é usado várias vezes nesse passo. O pacote fica em `apps/desktop/target/distribuicao/pacotes/<versão>-<commit>`. Se essa pasta já existe, o script para: nada é sobrescrito.

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

A partir da segunda versão, as duas rodadas levam também `-Anterior <pasta>`, com o instalador e o manifesto da versão que está publicada: a pasta do pacote dela, se ainda estiver neste computador, ou os dois arquivos baixados do release. Depois do roteiro comum, o QA instala a versão anterior, abre o app e atualiza para o pacote como o atualizador faz. Confere que a versão mudou no executável e no registro, que as preferências da pessoa ficaram e que a desinstalação não deixa nada. A evidência registra de que versão a rodada partiu e o SHA-256 do instalador dela.

Havendo versão pública, a etapa 5 cobra isso: as duas rodadas têm de ter partido da última versão pública, com o instalador que está no release dela. Uma rodada sem `-Anterior`, ou que partiu de outra versão ou de outro pacote com o mesmo número, não serve.

Nada é instalado no computador de trabalho. Um Sandbox por vez: a segunda rodada só começa depois de o Sandbox da primeira fechar, e o script recusa enquanto ele estiver aberto.

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
- com versão maior que a última pública, e etiqueta que ainda não existe, nem em rascunho;
- havendo versão pública, com as duas rodadas de QA partindo dela. O script lê no GitHub o manifesto da última versão pública e compara a versão e o SHA-256 do instalador com o campo `anterior` de cada rodada. Sem versão pública, como na primeira, nada disso é cobrado.

Passando, cria o release em rascunho com a etiqueta `desktop-v<versão>` apontando para o commit e sobe o instalador, `awikabot-desktop-windows-x64.json` e `SHA256SUMS`. Depois baixa os três de volta e os compara com os conferidos. Só então grava `rascunho.json`, com o número do rascunho.

As notas do release saem de `apps/desktop/distribuicao/windows/notas-do-release.md`, com a versão, o SHA-256 do instalador e o commit. `-Notas <arquivo.md>` põe um texto de quem publica antes disso.

O rascunho não aparece para ninguém de fora nem para o atualizador, que só enxerga release público, e não cria a etiqueta. Se ele for criado e não conferir, o script avisa: apagar o rascunho no GitHub antes de tentar de novo. O script usa o `gh` com a sessão de quem roda; nenhum token passa por ele.

## 6. Aprovar

```powershell
powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/aprovar.ps1 -Versao <x.y.z> -Ensaio
powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/aprovar.ps1 -Versao <x.y.z>
```

Decisão do titular, à parte: a versão é escrita à mão, e quem roda sem `-Ensaio` é ele. Tornar o release público é o que faz o app de quem já instalou avisar da versão nova no dia seguinte.

Antes de publicar, o script confere de novo, contra o GitHub de agora: o rascunho é o que a etapa 5 criou, pelo número; aponta para o commit conferido; tem só os três arquivos, e eles, baixados de volta, são os que passaram pela etapa 3 e pelo QA. Confere também de onde o QA partiu, contra a última versão pública de agora: se outra versão foi publicada depois do rascunho, o QA partiu da versão errada e a aprovação recusa. Publica pelo número do rascunho, não pela etiqueta. Depois confere que o release ficou público e que a etiqueta aponta para o commit, e grava `publicado.json`.

Não há como recolher uma versão publicada de quem já a instalou: o conserto é publicar outra, maior.

### Depois de publicar: a atualização num app instalado

```powershell
powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/ver-atualizacao.ps1 -Anterior <pasta da versão anterior> -Clicar
```

Confere num app instalado que o aviso aparece, que o download passa na conferência e que a instalação reabre o app na versão nova. O lugar para isso é um Windows Sandbox com rede, nunca o computador de trabalho. A pasta de `-Anterior` é a mesma do QA, e o instalador dela tem de ser o que está publicado com aquela versão. A versão nova é a última pública, lida do GitHub na hora.

O script abre o Sandbox, instala a versão anterior e abre o app. Um roteiro lá dentro anota cada mudança: a versão do executável e a do registro, se o app está aberto e em que processo, os pacotes na pasta do atualizador, com tamanho e SHA-256, e as preferências. Guarda também três capturas da janela: o aviso da versão nova, o pacote baixado e conferido, e o app reaberto.

Com `-Clicar`, o roteiro de dentro clica em "Baixar" e em "Instalar e reabrir", e ninguém precisa ficar na frente. O clique é por coordenada, com mensagens à janela, no lugar onde o botão do painel fica na tela de pareamento da versão anterior. Antes de clicar ele olha a captura. Só clica se houver ali uma faixa de botão, e só manda instalar quando a faixa é a do botão principal, o único colorido da tela: enquanto o pacote é conferido, o botão dali é "Cancelar". Se não acha o botão, não clica, anota por quê e deixa o clique para uma pessoa até o fim do prazo. Sem `-Clicar`, os dois cliques são de uma pessoa.

O lugar do botão está no começo do `ver-atualizacao-dentro.ps1`, medido na tela da 0.1.0 e da 0.1.1. Quando uma versão mudar o desenho da tela de pareamento, a conferência da versão seguinte parte dela: rodar com `-AteAConsulta`, medir o botão na captura `1-aviso.png` e passar `-DeslocamentoDoBotao <pontos abaixo do meio da janela>`, ou trocar o valor no roteiro.

De fora, o script lê o histórico enquanto ele é escrito e diz se a sequência aconteceu:

1. a versão anterior foi instalada e o app abriu;
2. o app consultou as versões publicadas, o que se vê pela data da consulta nas preferências;
3. o pacote da versão nova foi baixado, com o tamanho e o SHA-256 do manifesto público;
4. o executável e o registro passaram à versão nova;
5. o app reabriu na versão nova, em outro processo;
6. o app novo apagou o pacote baixado.

Vista a sequência, ou esgotado o prazo de 30 minutos (`-PrazoEmMinutos`), o script manda o Sandbox desligar. Fechar o Sandbox também encerra a rodada. A evidência fica em `apps/desktop/target/distribuicao/ver-atualizacao/<data>` e uma cópia vai para a pasta de evidências do commit da versão nova, como `atualizacao-vista.json`, com as capturas ao lado (`atualizacao-vista-1-aviso.png` e as outras duas). Ela diz de quem foram os cliques e traz o que o roteiro anotou de cada captura e de cada clique. Vale a rodada mais recente, aprovada ou não. Um Sandbox por vez.

O veredito sai do disco e do registro, nunca da tela: um clique que não pega reprova a rodada, não a aprova. As capturas mostram o aviso e os botões; olhar as três é parte da conferência.

`-AteAConsulta` para no passo 2 e não pede ninguém na frente: serve para ver que o app publicado ainda alcança a lista de versões, e para medir o lugar do botão. Não vale como a conferência e não grava na pasta do commit.

## Teste dos scripts de publicação

```powershell
powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/testes/testar-publicacao.ps1
```

Roda as etapas 5 e 6 de verdade contra um `gh` de mentira, com pacote e evidências montados numa pasta temporária: o caminho bom, sem versão pública e com uma, e depois um defeito por vez, que o script tem de recusar pelo motivo certo, sem criar rascunho nem publicar. Não toca o GitHub nem `relatorios/`. Faz parte das conferências do candidato.

```powershell
powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/testes/testar-ver-atualizacao.ps1
```

Testa, sem abrir o Sandbox, o que a conferência depois de publicar decide: o julgamento de um histórico escrito no teste, primeiro a atualização inteira e depois um defeito por vez; de quem a evidência diz que foram os cliques, pelas anotações do roteiro; e as recusas da pasta de `-Anterior`, que o QA também usa. Também faz parte das conferências do candidato. Não cobre o Sandbox nem os cliques: mudou o roteiro que roda lá dentro, roda o `ver-atualizacao.ps1 -Clicar`.

## O que o roteiro não cobre

- O painel de atualização na lateral da conversa, com o app pareado: a conferência depois de publicar clica no painel da tela de pareamento. Os testes do app clicam nos mesmos botões sem tela, contra um servidor de mentira.
- Outra escala de tela ou outro tamanho de janela no Sandbox: os cliques foram vistos com a janela de 980x680, na escala 1.
- Windows 10: o Sandbox só prova o Windows 11.
- Instalação por um usuário sem privilégios de administrador: a conta do Sandbox é administradora. O QA confere o lugar dos arquivos e do registro.
- Queda de energia no meio de uma atualização, e atualização pedida no meio de uma resposta de bot.
- O aviso de reputação do SmartScreen, que deve aparecer nos primeiros downloads mesmo com assinatura válida.
- macOS, que ainda não tem pacote.
