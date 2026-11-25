# QA do instalador no Windows Sandbox: instala, abre, atualiza por cima, desinstala e confere o
# que sobrou, numa máquina descartável. Nada é instalado neste computador.
#
#   powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/qa-sandbox.ps1
#   ... -Pacote <pasta do pacote>           outro pacote que não o mais recente
#   ... -DesligarSmartAppControl             só para pacote sem assinatura; vale só dentro do Sandbox
#   ... -ComRede -MarcaDeDownload            pacote assinado, como se tivesse sido baixado pelo navegador
#   ... -Anterior <pasta>                    parte também da versão anterior: instala a dela e atualiza para o pacote
#
# A pasta de -Anterior tem o instalador e o manifesto da versão já publicada: a pasta do pacote
# dela, em target\distribuicao\pacotes, ou os dois arquivos baixados do release.
#
# O Sandbox abre uma janela e fecha sozinho no fim, em poucos minutos. Ele roda sem rede, sem área
# de transferência, sem impressora, sem microfone e sem câmera, e só enxerga duas pastas daqui:
# uma de entrada, somente leitura, com o pacote e o roteiro, e uma de saída, por onde volta o
# `result.json`. Um Sandbox por vez: com outro aberto, o script para.
param(
    [string]$Pacote,
    [string]$Anterior,
    [switch]$DesligarSmartAppControl,
    [switch]$ComRede,
    [switch]$MarcaDeDownload,
    [int]$PrazoEmMinutos = 20
)
. (Join-Path $PSScriptRoot 'comum.ps1')

if (-not (Test-Path "$env:SystemRoot\System32\WindowsSandbox.exe")) { throw 'o Windows Sandbox nao esta habilitado neste computador' }
if (Get-Process -Name 'WindowsSandbox*' -ErrorAction SilentlyContinue) { throw 'ja ha um Windows Sandbox aberto; feche-o antes' }
if ($MarcaDeDownload -and -not $ComRede) { throw '-MarcaDeDownload pede -ComRede: o Windows consulta a reputacao do arquivo' }

$Pacote = Resolve-Pacote $Pacote
$manifesto = Get-Content -Raw (Join-Path $Pacote 'awikabot-desktop-windows-x64.json') | ConvertFrom-Json
$instalador = Join-Path $Pacote $manifesto.arquivo
$informacoes = Get-Content -Raw (Join-Path $Pacote 'build-info.json') | ConvertFrom-Json
if (-not $informacoes.assinado -and -not $DesligarSmartAppControl) {
    'aviso: o pacote nao esta assinado; se o Smart App Control do Sandbox o bloquear, rode de novo com -DesligarSmartAppControl'
}
if ($MarcaDeDownload -and -not $informacoes.assinado) { throw '-MarcaDeDownload e para pacote assinado: sem assinatura, o Windows para o instalador numa pergunta' }

# A versão anterior: o que o manifesto dela diz vira nome de arquivo, então só passa no formato
# esperado, e o instalador tem de ser o do manifesto.
$partida = $null
if ($Anterior) {
    $pastaAnterior = (Resolve-Path -LiteralPath $Anterior).Path
    $manifestoAnterior = Get-Content -Raw (Join-Path $pastaAnterior 'awikabot-desktop-windows-x64.json') | ConvertFrom-Json
    if ([string]$manifestoAnterior.versao -notmatch '^\d+\.\d+\.\d+$') { throw 'a versao no manifesto da versao anterior esta fora do formato x.y.z' }
    if ([string]$manifestoAnterior.arquivo -ne "awikabot-$($manifestoAnterior.versao)-windows-x64.exe") { throw 'o manifesto da versao anterior aponta para um arquivo com outro nome' }
    if ([version]$manifestoAnterior.versao -ge [version]$manifesto.versao) { throw "a versao anterior ($($manifestoAnterior.versao)) tem de ser menor que a do pacote ($($manifesto.versao))" }
    $instaladorAnterior = Join-Path $pastaAnterior $manifestoAnterior.arquivo
    if (-not (Test-Path -LiteralPath $instaladorAnterior)) { throw "falta o instalador da versao anterior: $instaladorAnterior" }
    if ((Get-Sha256 $instaladorAnterior) -ne $manifestoAnterior.sha256) { throw 'o instalador da versao anterior nao e o do manifesto dela' }
    if (-not $DesligarSmartAppControl -and (Get-AuthenticodeSignature -LiteralPath $instaladorAnterior).Status -ne 'Valid') {
        throw 'o instalador da versao anterior nao tem assinatura valida: com o Smart App Control ligado, o Sandbox o bloquearia'
    }
    $partida = [ordered]@{ versao = [string]$manifestoAnterior.versao; instalador = [string]$manifestoAnterior.arquivo; sha256 = [string]$manifestoAnterior.sha256 }
}

$rodada = Join-Path $script:PastaDeBuild ("qa-sandbox\" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$entrada = Join-Path $rodada 'entrada'
$saida = Join-Path $rodada 'saida'
New-Item -ItemType Directory -Force $entrada, $saida | Out-Null
Copy-Item -LiteralPath $instalador, (Join-Path $Pacote 'awikabot-desktop-windows-x64.json'), (Join-Path $PSScriptRoot 'qa-sandbox-dentro.ps1') -Destination $entrada
if ($partida) {
    New-Item -ItemType Directory -Force (Join-Path $entrada 'anterior') | Out-Null
    Copy-Item -LiteralPath $instaladorAnterior, (Join-Path $pastaAnterior 'awikabot-desktop-windows-x64.json') -Destination (Join-Path $entrada 'anterior')
}

$opcoes = @()
if ($partida) { $opcoes += '-ComAnterior' }
if ($DesligarSmartAppControl) { $opcoes += '-DesligarSmartAppControl' }
if ($MarcaDeDownload) { $opcoes += '-MarcaDeDownload' }
$rede = if ($ComRede) { 'Enable' } else { 'Disable' }
$configuracao = @"
<Configuration>
  <Networking>$rede</Networking>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <PrinterRedirection>Disable</PrinterRedirection>
  <AudioInput>Disable</AudioInput>
  <VideoInput>Disable</VideoInput>
  <MappedFolders>
    <MappedFolder><HostFolder>$entrada</HostFolder><SandboxFolder>C:\qa\entrada</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$saida</HostFolder><SandboxFolder>C:\qa\saida</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\qa\entrada\qa-sandbox-dentro.ps1 $($opcoes -join ' ')</Command>
  </LogonCommand>
</Configuration>
"@
$arquivoDoSandbox = Join-Path $rodada 'qa.wsb'
Write-TextoSemBom $arquivoDoSandbox $configuracao

"pacote: $Pacote"
"instalador: $($manifesto.arquivo) ($($manifesto.sha256)); assinado: $($informacoes.assinado)"
if ($partida) { "versao anterior: $($partida.instalador) ($($partida.sha256))" }
"abrindo o Windows Sandbox (rede: $rede); ele fecha sozinho no fim..."
Start-Process -FilePath "$env:SystemRoot\System32\WindowsSandbox.exe" -ArgumentList "`"$arquivoDoSandbox`""

$resultadoDoSandbox = Join-Path $saida 'result.json'
$fim = (Get-Date).AddMinutes($PrazoEmMinutos)
while (-not (Test-Path $resultadoDoSandbox) -and (Get-Date) -lt $fim) { Start-Sleep -Seconds 3 }
if (-not (Test-Path $resultadoDoSandbox)) {
    Get-Process -Name 'WindowsSandbox*' -ErrorAction SilentlyContinue | Stop-Process -Force -Confirm:$false
    throw "o Sandbox nao devolveu resultado em $PrazoEmMinutos minutos; a rodada ficou em $rodada"
}
Start-Sleep -Seconds 2
$resultado = Get-Content -Raw $resultadoDoSandbox | ConvertFrom-Json
# A evidência amarra o resultado ao pacote que foi testado.
$evidencia = New-EvidenciaDoQa $manifesto $informacoes $resultado ([bool]$ComRede) ([bool]$MarcaDeDownload) ([bool]$DesligarSmartAppControl) $partida
Write-TextoSemBom (Join-Path $rodada 'evidencia.json') $evidencia.Texto
# Uma cópia vai para a pasta de evidências do commit, uma por tipo de rodada: a mais recente vale,
# aprovada ou não. É dela que a publicação lê.
$copia = Join-Path (Get-PastaDeEvidenciasDoPacote $informacoes) $evidencia.Nome
Write-TextoSemBom $copia $evidencia.Texto

"sistema do Sandbox: $($resultado.sistema); Smart App Control: $($resultado.smart_app_control)"
foreach ($passo in $resultado.passos) {
    $marca = if ($passo.ok) { 'PASSOU ' } else { 'FALHOU ' }
    "$marca $($passo.passo)" + $(if ($passo.detalhe) { ": $($passo.detalhe)" } else { '' })
}
foreach ($evento in @($resultado.eventos)) { "  evento: $evento" }
"evidencia: $(Join-Path $rodada 'evidencia.json')"
"copia na pasta do candidato: $copia"
if (-not $resultado.aprovado) { throw 'o QA no Sandbox reprovou o pacote' }
'QA no Sandbox: aprovado'
