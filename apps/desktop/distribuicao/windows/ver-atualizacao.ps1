# Conferência depois de publicar: num Windows Sandbox com rede, um app da versão anterior avisa da
# versão nova, baixa, confere e instala. Nada é instalado neste computador.
#
#   powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/ver-atualizacao.ps1 -Anterior <pasta>
#   ... -Clicar                 o roteiro de dentro clica em "Baixar" e em "Instalar e reabrir"; não pede ninguém na frente
#   ... -AteAConsulta           para quando o app registra a consulta; não pede ninguém na frente e não vale como a conferência
#   ... -PrazoEmMinutos <n>     quanto esperar pelos cliques (30)
#   ... -DeslocamentoDoBotao <n>  outro lugar para o botão do painel, quando a tela de pareamento mudou
#
# A pasta de -Anterior tem o instalador e o manifesto da versão que estava publicada antes: a
# pasta do pacote dela, em target\distribuicao\pacotes, ou os dois arquivos baixados do release.
# Vale o que o `qa-sandbox.ps1 -Anterior` exige, e mais: o instalador tem de ser o que está
# publicado com aquela versão. A versão nova é a última pública, lida do GitHub na hora.
#
# O script abre o Sandbox, instala a versão anterior e abre o app. Lá dentro, um roteiro só anota
# o que muda no disco e no registro; os cliques no painel de atualização são de uma pessoa:
# "Baixar" quando o aviso aparecer e, depois, "Instalar e reabrir". Daqui de fora o script lê o
# histórico e diz se a sequência aconteceu: consulta registrada, pacote baixado com o tamanho e o
# hash do manifesto público, executável e registro na versão nova, app reaberto em outro processo
# e pacote apagado pelo app novo. Fechar o Sandbox encerra a rodada.
#
# A evidência fica na pasta da rodada e, na rodada inteira, também na pasta de evidências do
# commit da versão nova: `relatorios/release/<versão>-<commit>/atualizacao-vista.json`. Vale a
# mais recente, aprovada ou não. Um Sandbox por vez: com outro aberto, o script para.
#
# Usa o `gh` com a sessão de quem roda, só para ler; nenhum token passa por aqui.
param(
    [Parameter(Mandatory = $true)][string]$Anterior,
    [switch]$Clicar,
    [switch]$AteAConsulta,
    [int]$PrazoEmMinutos = 30,
    # Onde o roteiro de dentro procura o botão do painel; sem isto, vale o que está nele.
    [int]$DeslocamentoDoBotao,
    # Só para teste: outro programa no lugar do gh.
    [string]$Gh = 'gh'
)
. (Join-Path $PSScriptRoot 'comum.ps1')

if (-not (Test-Path "$env:SystemRoot\System32\WindowsSandbox.exe")) { throw 'o Windows Sandbox nao esta habilitado neste computador' }
if ($Clicar -and $AteAConsulta) { throw '-Clicar e -AteAConsulta nao andam juntos: ate a consulta nao ha o que clicar' }
# Um Sandbox que acabou de fechar ainda aparece como processo por alguns segundos.
$fechando = (Get-Date).AddSeconds(30)
while ((Get-Process -Name 'WindowsSandbox*' -ErrorAction SilentlyContinue) -and (Get-Date) -lt $fechando) { Start-Sleep -Seconds 2 }
if (Get-Process -Name 'WindowsSandbox*' -ErrorAction SilentlyContinue) { throw 'ja ha um Windows Sandbox aberto; feche-o antes' }

# A versão nova é a última pública: é a que o app instalado vai achar.
$destino = Get-DestinoDosReleases
$maior = Get-MaiorVersaoPublica (Get-Releases $Gh $destino.Repositorio) $destino.Prefixo
if (-not $maior) { throw 'nao ha versao publica do desktop: o app instalado nao teria para onde atualizar' }
$versao = "$maior"
$etiqueta = "$($destino.Prefixo)$versao"
$commit = [string](Get-CommitDaEtiqueta $Gh $destino.Repositorio $etiqueta)
if ($commit -notmatch '^[0-9a-f]{40}$') { throw "a etiqueta $etiqueta nao aponta para um commit" }
$publicado = Get-ManifestoPublicado $Gh $destino.Repositorio $etiqueta
if (-not $publicado -or [string]$publicado.versao -ne $versao -or [string]$publicado.arquivo -ne "awikabot-$versao-windows-x64.exe" -or
    [string]$publicado.sha256 -notmatch '^[0-9a-f]{64}$' -or -not ($publicado.tamanho -gt 0)) {
    throw "nao deu para ler o manifesto publico da versao $versao"
}

# A versão anterior: conferida contra o manifesto dela, menor que a nova, com assinatura válida,
# porque o Smart App Control fica ligado, e igual à que está publicada.
$versaoDePartida = Resolve-VersaoAnterior $Anterior $versao $true 'a ultima versao publica'
$partida = $versaoDePartida.Partida
$publicadoDaPartida = Get-ManifestoPublicado $Gh $destino.Repositorio "$($destino.Prefixo)$($partida.versao)"
if (-not $publicadoDaPartida -or [string]$publicadoDaPartida.sha256 -ne $partida.sha256) {
    throw "o instalador da versao anterior nao e o que esta publicado como $($partida.versao)"
}

$rodada = Join-Path $script:PastaDeBuild ("ver-atualizacao\" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$entrada = Join-Path $rodada 'entrada'
$saida = Join-Path $rodada 'saida'
New-Item -ItemType Directory -Force $entrada, $saida | Out-Null
Copy-Item -LiteralPath $versaoDePartida.Instalador, $versaoDePartida.Manifesto, (Join-Path $PSScriptRoot 'ver-atualizacao-dentro.ps1') -Destination $entrada

# O roteiro de dentro tem prazo próprio, um pouco maior: se este script morrer, o Sandbox não fica aberto para sempre.
$opcoes = @('-PrazoEmMinutos', ($PrazoEmMinutos + 5))
if ($Clicar) { $opcoes += '-Clicar' }
if ($PSBoundParameters.ContainsKey('DeslocamentoDoBotao')) { $opcoes += @('-DeslocamentoDoBotao', $DeslocamentoDoBotao) }
$configuracao = @"
<Configuration>
  <Networking>Enable</Networking>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <PrinterRedirection>Disable</PrinterRedirection>
  <AudioInput>Disable</AudioInput>
  <VideoInput>Disable</VideoInput>
  <MappedFolders>
    <MappedFolder><HostFolder>$entrada</HostFolder><SandboxFolder>C:\ver\entrada</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$saida</HostFolder><SandboxFolder>C:\ver\saida</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File C:\ver\entrada\ver-atualizacao-dentro.ps1 $($opcoes -join ' ')</Command>
  </LogonCommand>
</Configuration>
"@
$arquivoDoSandbox = Join-Path $rodada 'ver.wsb'
Write-TextoSemBom $arquivoDoSandbox $configuracao

# O histórico é lido enquanto o Sandbox ainda escreve nele: só valem as linhas inteiras.
$arquivoDoHistorico = Join-Path $saida 'historico.jsonl'
function Ler-Historico {
    if (-not (Test-Path $arquivoDoHistorico)) { return }
    try {
        $fluxo = New-Object IO.FileStream($arquivoDoHistorico, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        try { $texto = (New-Object IO.StreamReader($fluxo, [Text.Encoding]::UTF8)).ReadToEnd() } finally { $fluxo.Dispose() }
    } catch { return }
    foreach ($linha in ($texto -split "`n")) {
        if (-not $linha.Trim()) { continue }
        try { $lida = $linha | ConvertFrom-Json } catch { continue }
        if ($lida.estado) { $lida }
    }
}
function Descrever($linha) {
    $estado = $linha.estado
    $partes = @(
        "executavel $(if ($estado.versao_do_executavel) { $estado.versao_do_executavel } else { 'ausente' })",
        "registro $(if ($estado.versao_no_registro) { $estado.versao_no_registro } else { 'ausente' })",
        $(if ($estado.app_aberto) { "app aberto (processo $($estado.processo))" } else { 'app fechado' })
    )
    if ($estado.instalador_rodando) { $partes += 'instalador rodando' }
    if ($estado.preferencias -and $estado.preferencias.ultima_consulta_s) { $partes += 'consulta registrada' }
    $pacotes = @($estado.pacotes | Where-Object { $_ } | ForEach-Object { if ($_.tamanho) { "$($_.nome) ($($_.tamanho) bytes)" } else { $_.nome } })
    if ($pacotes.Count -gt 0) { $partes += "pacotes: $($pacotes -join ', ')" }
    "  $($linha.quando)  $($partes -join '; ')"
}
function Julgar($instalacao, $linhas) {
    return @(Get-PassosDaAtualizacao $instalacao @($linhas | ForEach-Object { $_.estado }) $partida.versao $versao $publicado ([bool]$AteAConsulta))
}

"versao nova: $versao ($etiqueta, commit $($commit.Substring(0, 7))); instalador publicado: $($publicado.arquivo) ($($publicado.sha256))"
"versao anterior: $($partida.instalador) ($($partida.sha256))"
'abrindo o Windows Sandbox, com rede...'
if ($AteAConsulta) { 'ninguem precisa clicar: a rodada para quando o app registrar a consulta' }
elseif ($Clicar) { "ninguem precisa clicar: o roteiro de dentro clica em Baixar e em Instalar e reabrir; se um clique nao pegar, uma pessoa ainda pode clicar, ate $PrazoEmMinutos minutos" }
else {
    "no Sandbox, no painel do app: quando aparecer o aviso da versao $versao, clicar em Baixar e, depois, em Instalar e reabrir"
    "esperando ate $PrazoEmMinutos minutos; fechar o Sandbox encerra a rodada"
}
Start-Process -FilePath "$env:SystemRoot\System32\WindowsSandbox.exe" -ArgumentList "`"$arquivoDoSandbox`""

$inicio = Get-Date
$fim = $inicio.AddMinutes($PrazoEmMinutos)
$instalacao = $null
$linhas = @()
$mostradas = 0
$sandboxVisto = $false
$soFaltaALimpezaDesde = $null
$encerrouPor = 'o prazo acabou'
while ((Get-Date) -lt $fim) {
    Start-Sleep -Seconds 2
    $aberto = [bool](Get-Process -Name 'WindowsSandbox*' -ErrorAction SilentlyContinue)
    if ($aberto) { $sandboxVisto = $true }
    if (-not $instalacao) {
        $instalacao = Read-Evidencia (Join-Path $saida 'partida.json')
        if ($instalacao) { "  instalador da $($partida.versao) saiu com o codigo $($instalacao.codigo_do_instalador); versao instalada: $($instalacao.versao_instalada); janela: $($instalacao.janela)" }
    }
    $linhas = @(Ler-Historico)
    for (; $mostradas -lt $linhas.Count; $mostradas++) { Descrever $linhas[$mostradas] }
    if ($instalacao) {
        $faltam = @(Julgar $instalacao $linhas | Where-Object { -not $_.ok })
        if ($faltam.Count -eq 0) { $encerrouPor = $(if ($AteAConsulta) { 'a consulta foi registrada' } else { 'a sequencia inteira foi vista' }); break }
        if (-not (Julgar $instalacao $linhas)[0].ok) { $encerrouPor = 'a versao anterior nao ficou instalada e aberta'; break }
        # O app novo apaga o pacote ao abrir. Se não apagou em um minuto, não vai apagar.
        if ($faltam.Count -eq 1 -and $faltam[0].passo -like '*apagou o pacote*') {
            if (-not $soFaltaALimpezaDesde) { $soFaltaALimpezaDesde = Get-Date }
            elseif (((Get-Date) - $soFaltaALimpezaDesde).TotalSeconds -ge 60) { $encerrouPor = 'o pacote nao foi apagado em um minuto'; break }
        }
    }
    if ($sandboxVisto -and -not $aberto) { $encerrouPor = 'o Sandbox foi fechado'; break }
    if (-not $sandboxVisto -and ((Get-Date) - $inicio).TotalMinutes -ge 3) { $encerrouPor = 'o Sandbox nao abriu'; break }
}

# Manda o roteiro de dentro parar; ele desliga o Sandbox. Se não desligar, o Sandbox é fechado daqui.
New-Item -ItemType File -Force (Join-Path $saida 'encerrar') | Out-Null
$espera = (Get-Date).AddSeconds(90)
while ((Get-Process -Name 'WindowsSandbox*' -ErrorAction SilentlyContinue) -and (Get-Date) -lt $espera) { Start-Sleep -Seconds 2 }
Get-Process -Name 'WindowsSandbox*' -ErrorAction SilentlyContinue | Stop-Process -Force -Confirm:$false

# Com o Sandbox fechado, o histórico está inteiro: o veredito sai dele.
if (-not $instalacao) { $instalacao = Read-Evidencia (Join-Path $saida 'partida.json') }
$linhas = @(Ler-Historico)
for (; $mostradas -lt $linhas.Count; $mostradas++) { Descrever $linhas[$mostradas] }
$passos = Julgar $instalacao $linhas
$aprovado = @($passos | Where-Object { -not $_.ok }).Count -eq 0

# O que o roteiro de dentro anotou das capturas e dos cliques, e as capturas que voltaram.
$roteiro = @(Get-Content -LiteralPath (Join-Path $saida 'roteiro.jsonl') -ErrorAction SilentlyContinue | ForEach-Object { try { $_ | ConvertFrom-Json } catch { } } | Where-Object { $_ })
$capturas = @(Get-ChildItem -LiteralPath $saida -Filter '*.png' -ErrorAction SilentlyContinue | Sort-Object Name | ForEach-Object { [ordered]@{ nome = $_.Name; sha256 = (Get-Sha256 $_.FullName) } })
$cliquesDoRoteiro = @($roteiro | Where-Object { $_.o_que -like 'clique em *' }).Count
$cliques = 'de uma pessoa, no painel do app'
if ($AteAConsulta) { $cliques = 'nenhum: a rodada parou na consulta' }
elseif ($Clicar -and $cliquesDoRoteiro -ge 2) { $cliques = 'do roteiro de dentro do Sandbox, por coordenada' }
elseif ($Clicar) { $cliques = "o roteiro de dentro fez $cliquesDoRoteiro clique(s); o que faltou ficou para uma pessoa" }

$evidencia = [ordered]@{
    aprovado       = $aprovado
    ate_a_consulta = [bool]$AteAConsulta
    versao         = $versao
    commit         = $commit
    etiqueta       = $etiqueta
    repositorio    = $destino.Repositorio
    instalador     = [string]$publicado.arquivo
    tamanho        = $publicado.tamanho
    sha256         = [string]$publicado.sha256
    anterior       = $partida
    cliques        = $cliques
    capturas       = $capturas
    quando         = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    encerrou_por   = $encerrouPor
    instalacao     = $instalacao
    passos         = $passos
    roteiro        = $roteiro
    historico      = $linhas
}
$texto = ((ConvertTo-Json -InputObject $evidencia -Depth 8) -replace "`r`n", "`n") + "`n"
Write-TextoSemBom (Join-Path $rodada 'evidencia.json') $texto

"a rodada encerrou porque $encerrouPor"
foreach ($passo in $passos) {
    $marca = if ($passo.ok) { 'PASSOU ' } else { 'FALHOU ' }
    "$marca $($passo.passo)" + $(if ($passo.detalhe) { ": $($passo.detalhe)" } else { '' })
}
foreach ($linha in $roteiro) { "  roteiro: $($linha.quando)  $($linha.o_que)" }
"cliques: $cliques"
"evidencia: $(Join-Path $rodada 'evidencia.json')"
if ($capturas.Count -gt 0) { "capturas: $(($capturas | ForEach-Object { $_.nome }) -join ', '), em $saida" }
if ($AteAConsulta) {
    if (-not $aprovado) { throw 'o app instalado nao chegou a registrar a consulta' }
    'ATE A CONSULTA: o app instalado consultou as versoes publicadas; o aviso, o download e a instalacao nao foram conferidos'
    return
}
# Uma cópia vai para a pasta de evidências do commit da versão nova: a mais recente vale, aprovada ou não.
$pastaDaVersao = Get-PastaDeEvidencias $versao ([pscustomobject]@{ Curto = $commit.Substring(0, 7); ComMudancas = $false })
$copia = Join-Path $pastaDaVersao 'atualizacao-vista.json'
Write-TextoSemBom $copia $texto
# As capturas vão junto, com o nome da evidência na frente; as de uma rodada anterior saem antes.
Get-ChildItem -LiteralPath $pastaDaVersao -Filter 'atualizacao-vista-*.png' -ErrorAction SilentlyContinue | Remove-Item -Confirm:$false
foreach ($captura in $capturas) { Copy-Item -LiteralPath (Join-Path $saida $captura.nome) -Destination (Join-Path $pastaDaVersao "atualizacao-vista-$($captura.nome)") }
"copia na pasta da versao: $copia"
if (-not $aprovado) { throw 'a atualizacao nao foi vista inteira no app instalado' }
'atualizacao vista no app instalado: aprovada'
