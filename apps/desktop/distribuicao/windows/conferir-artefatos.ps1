# Confere um pacote montado pelo empacotar.ps1 antes de ele ir para o QA e para a publicação.
#
#   powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/conferir-artefatos.ps1
#   ... -Pacote <pasta do pacote>      outro pacote que não o mais recente
#
# Só passa um pacote que pode ser publicado: saído de um commit sem mudança pendente, assinado,
# com carimbo de tempo, com os hashes e as versões batendo entre si, e aceito pela mesma regra
# que o atualizador de quem já instalou vai aplicar. Um pacote sem assinatura, como o que o QA de
# desenvolvimento usa, é recusado aqui de propósito.
#
# O script lista tudo o que achou de errado, não só o primeiro problema, e sai com código 1.
param(
    [string]$Pacote
)
. (Join-Path $PSScriptRoot 'comum.ps1')

if (-not $Pacote) {
    $Pacote = Get-ChildItem (Join-Path $script:PastaDeBuild 'pacotes') -Directory -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $Pacote -or -not (Test-Path $Pacote)) { throw 'nenhum pacote encontrado; rode o empacotar.ps1 antes' }

$problemas = New-Object System.Collections.ArrayList
function Anotar([string]$problema) { [void]$problemas.Add($problema) }
function LerJson([string]$nome) {
    $arquivo = Join-Path $Pacote $nome
    if (-not (Test-Path $arquivo)) { Anotar "falta $nome"; return $null }
    try { return Get-Content -Raw $arquivo | ConvertFrom-Json } catch { Anotar "$nome nao e JSON"; return $null }
}

$informacoes = LerJson 'build-info.json'
$manifesto = LerJson 'awikabot-desktop-windows-x64.json'
$executavel = Join-Path $Pacote 'awikabot.exe'
if (-not (Test-Path $executavel)) { Anotar 'falta awikabot.exe' }

if ($informacoes) {
    if ($informacoes.com_mudancas) { Anotar 'o pacote saiu de uma pasta com mudancas sem commit' }
    if (-not $informacoes.assinado) { Anotar 'o pacote nao foi assinado' }
    if (Test-Path $executavel) {
        if ((Get-Sha256 $executavel) -ne $informacoes.sha256) { Anotar 'o executavel nao tem o hash do build-info' }
        if ((Get-Item $executavel).VersionInfo.ProductVersion -ne $informacoes.versao) { Anotar 'a versao do executavel nao e a do build-info' }
    }
}

$instalador = $null
if ($manifesto) {
    if ($manifesto.plataforma -ne 'windows-x64') { Anotar 'o manifesto e de outra plataforma' }
    if ($informacoes -and $manifesto.versao -ne $informacoes.versao) { Anotar 'a versao do manifesto nao e a do build-info' }
    if ($manifesto.arquivo -ne "awikabot-$($manifesto.versao)-windows-x64.exe") { Anotar 'o nome do instalador no manifesto nao e o que o atualizador procura' }
    $instalador = Join-Path $Pacote $manifesto.arquivo
    if (-not (Test-Path $instalador)) {
        Anotar "falta o instalador $($manifesto.arquivo)"
        $instalador = $null
    } else {
        if ((Get-Item $instalador).Length -ne $manifesto.tamanho) { Anotar 'o instalador nao tem o tamanho do manifesto' }
        if ((Get-Sha256 $instalador) -ne $manifesto.sha256) { Anotar 'o instalador nao tem o hash do manifesto' }
        if ((Get-Item $instalador).VersionInfo.ProductVersion.Trim() -ne $manifesto.versao) { Anotar 'a versao do instalador nao e a do manifesto' }
    }
}

# A lista de hashes cobre exatamente o que vai para o release, e bate com os arquivos.
$lista = Join-Path $Pacote 'SHA256SUMS'
if (-not (Test-Path $lista)) {
    Anotar 'falta SHA256SUMS'
} elseif ($manifesto) {
    $esperados = @($manifesto.arquivo, 'awikabot-desktop-windows-x64.json') | Sort-Object
    $linhas = @(Get-Content $lista | Where-Object { $_ })
    $listados = @($linhas | ForEach-Object { ($_ -split '  ', 2)[1] }) | Sort-Object
    if (($listados -join '|') -ne ($esperados -join '|')) { Anotar 'SHA256SUMS nao lista exatamente o instalador e o manifesto' }
    foreach ($linha in $linhas) {
        $hash, $nome = $linha -split '  ', 2
        $arquivo = Join-Path $Pacote $nome
        if ((Test-Path $arquivo) -and (Get-Sha256 $arquivo) -ne $hash) { Anotar "o hash de $nome em SHA256SUMS nao e o do arquivo" }
    }
}

foreach ($texto in @('LICENSE.txt', 'LICENCAS-DE-TERCEIROS.txt')) {
    $arquivo = Join-Path $Pacote $texto
    if (-not (Test-Path $arquivo) -or (Get-Item $arquivo).Length -eq 0) { Anotar "falta $texto" }
}

# As duas assinaturas: validas, com carimbo de tempo, do mesmo certificado, e aceitas pelo app.
$assinados = @($executavel, $instalador) | Where-Object { $_ -and (Test-Path $_) }
$impressoes = @()
foreach ($arquivo in $assinados) {
    $nome = Split-Path -Leaf $arquivo
    $assinatura = Get-AuthenticodeSignature -LiteralPath $arquivo
    if ($assinatura.Status -ne 'Valid') { Anotar "a assinatura de $nome nao vale: $($assinatura.Status)"; continue }
    if (-not $assinatura.TimeStamperCertificate) { Anotar "a assinatura de $nome nao tem carimbo de tempo" }
    $impressoes += $assinatura.SignerCertificate.Thumbprint
    # A regra de verdade: a que o atualizador de quem ja instalou aplica ao pacote baixado.
    $conferencia = Start-Process -FilePath $executavel -ArgumentList @('--conferir-pacote', "`"$arquivo`"") -PassThru -Wait -WindowStyle Hidden
    if ($conferencia.ExitCode -ne 0) { Anotar "o app nao aceita a assinatura de $nome pela regra do atualizador" }
}
if (@($impressoes | Sort-Object -Unique).Count -gt 1) { Anotar 'o executavel e o instalador foram assinados por certificados diferentes' }

"pacote: $Pacote"
if ($problemas.Count -gt 0) {
    foreach ($problema in $problemas) { "RECUSADO  $problema" }
    throw "o pacote nao pode ser publicado: $($problemas.Count) problema(s)"
}
"versao $($manifesto.versao), commit $($informacoes.commit.Substring(0, 7)), instalador $($manifesto.sha256)"
'artefatos conferidos: o pacote pode seguir para o QA e para a publicacao'
