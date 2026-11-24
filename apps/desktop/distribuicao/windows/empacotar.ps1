# Monta o pacote do app de desktop para Windows: executável, licenças, instalador, o manifesto
# que o atualizador lê e a lista de hashes.
#
#   powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/empacotar.ps1
#   powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/empacotar.ps1 -Assinar <impressão digital>
#
# Sem -Assinar, o pacote sai sem assinatura: serve para conferir o instalador no Windows Sandbox,
# nunca para publicar. Com -Assinar, o executável é assinado antes de entrar no instalador, e
# quem assina o instalador é o próprio Inno Setup, enquanto o monta: assim saem assinados também
# o desinstalador e a cópia do programa de instalação que o instalador extrai e roda, que o Smart
# App Control bloquearia. O script só recebe a impressão digital de um certificado que já está no
# repositório de certificados do usuário; senha e token nunca passam por ele.
#
# Precisa do Inno Setup 6 (ISCC.exe), do Node e, para assinar, do signtool do Windows SDK.
param(
    # Impressão digital do certificado de assinatura de código, em CurrentUser\My.
    [string]$Assinar,
    [string]$CarimboDeTempo = 'http://time.certum.pl',
    [string]$Saida
)
. (Join-Path $PSScriptRoot 'comum.ps1')

$iscc = Get-InnoSetup
if ($Assinar) { Test-CertificadoDeAssinatura $Assinar | Out-Null }

# O executável: compilado e conferido pelo compilar.ps1, que imprime onde o deixou.
$argumentos = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'compilar.ps1'))
if ($Saida) { $argumentos += @('-Saida', $Saida) }
$relato = & powershell.exe @argumentos
if ($LASTEXITCODE -ne 0) { $relato; throw 'a compilacao falhou' }
$relato | Where-Object { $_ -notlike 'executavel:*' }
$executavel = ($relato | Where-Object { $_ -like 'executavel: *' } | Select-Object -First 1) -replace '^executavel: ', ''
if (-not $executavel -or -not (Test-Path $executavel)) { throw 'a compilacao nao informou o executavel' }
$pasta = Split-Path -Parent $executavel
$informacoes = Get-Content -Raw (Join-Path $pasta 'build-info.json') | ConvertFrom-Json
$versao = $informacoes.versao

if ($Assinar) { Invoke-Assinatura $executavel $Assinar $CarimboDeTempo }

Copy-Item -LiteralPath (Join-Path $script:RaizDoRepositorio 'LICENSE') -Destination (Join-Path $pasta 'LICENSE.txt')
"licencas de terceiros: " + (Invoke-Programa 'node' @((Join-Path $script:PastaDoDesktop 'distribuicao\licencas-de-terceiros.mjs'), (Join-Path $pasta 'LICENCAS-DE-TERCEIROS.txt')) | Select-Object -Last 1)

$opcoesDoInno = @('/Qp', "/DVersao=$versao", "/DOrigem=$pasta", "/DSaida=$pasta")
if ($Assinar) {
    # O roteiro do instalador liga a assinatura com /DAssinatura e para, antes de assinar, se o
    # Inno Setup nao for o da versao fixada.
    $opcoesDoInno += @('/DAssinatura=1', "/DInnoSetupExigido=$script:VersaoDoInnoSetup", ('/Sawikabot=' + (Get-ComandoDeAssinatura $Assinar $CarimboDeTempo)))
}
Invoke-Programa $iscc ($opcoesDoInno + @((Join-Path $PSScriptRoot 'instalador.iss'))) | Out-Null
$instalador = Join-Path $pasta "awikabot-$versao-windows-x64.exe"
if (-not (Test-Path $instalador)) { throw 'o Inno Setup nao gerou o instalador' }
# O Inno Setup completa o texto da versao com espacos.
if ((Get-Item $instalador).VersionInfo.ProductVersion.Trim() -ne $versao) { throw 'a versao gravada no instalador nao e a do app' }
# A versao do compilador que montou o instalador fica registrada; a do pacote publicavel e fixa.
$innoSetup = Read-VersaoDoInnoSetup $pasta
if ($Assinar -and $innoSetup -ne $script:VersaoDoInnoSetup) {
    throw "o instalador foi montado com o Inno Setup $innoSetup; o pacote que vai ser assinado sai do $script:VersaoDoInnoSetup (comum.ps1)"
}

# O instalador ja saiu assinado do Inno Setup: aqui so se confere que a assinatura vale, e do
# certificado pedido e tem carimbo de tempo.
if ($Assinar) { Test-Assinatura $instalador $Assinar }

# O manifesto que o atualizador do app lê, com o nome que ele procura no release.
$manifesto = [ordered]@{
    versao     = $versao
    plataforma = 'windows-x64'
    arquivo    = Split-Path -Leaf $instalador
    tamanho    = (Get-Item $instalador).Length
    sha256     = Get-Sha256 $instalador
}
$nomeDoManifesto = 'awikabot-desktop-windows-x64.json'
Write-TextoSemBom (Join-Path $pasta $nomeDoManifesto) (($manifesto | ConvertTo-Json -Compress) + "`n")

# O build-info passa a descrever o executável como ele vai no pacote.
$informacoes.sha256 = Get-Sha256 $executavel
$informacoes.tamanho = (Get-Item $executavel).Length
$informacoes.assinado = [bool]$Assinar
$informacoes | Add-Member -NotePropertyName inno_setup -NotePropertyValue $innoSetup
Write-TextoSemBom (Join-Path $pasta 'build-info.json') ((($informacoes | ConvertTo-Json) -replace "`r`n", "`n") + "`n")

# Só o que vai para o release entra na lista de hashes.
$publicados = @((Split-Path -Leaf $instalador), $nomeDoManifesto)
$linhas = $publicados | ForEach-Object { "$(Get-Sha256 (Join-Path $pasta $_))  $_" }
Write-TextoSemBom (Join-Path $pasta 'SHA256SUMS') (($linhas -join "`n") + "`n")

"pacote: $pasta"
"instalador: $(Split-Path -Leaf $instalador), $($manifesto.tamanho) bytes"
"sha256 do instalador: $($manifesto.sha256)"
"inno setup: $innoSetup" + $(if ($innoSetup -ne $script:VersaoDoInnoSetup) { " (o pacote publicavel sai do $script:VersaoDoInnoSetup)" } else { '' })
if ($Assinar) { 'assinado: executavel e instalador' } else { 'SEM ASSINATURA: serve para o QA no Sandbox, nao para publicar' }
