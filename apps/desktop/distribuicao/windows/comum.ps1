# Funções comuns aos scripts de distribuição do app de desktop no Windows.
# Os textos impressos vão sem acento: o Windows PowerShell 5.1 lê arquivo sem BOM como ANSI.

$ErrorActionPreference = 'Stop'

# apps/desktop, a pasta do workspace Cargo.
$script:PastaDoDesktop = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script:RaizDoRepositorio = (Resolve-Path (Join-Path $script:PastaDoDesktop '..\..')).Path
# O build de distribuição tem pasta própria: as opções dele são outras, e na pasta comum cada
# troca recompilaria tudo.
$script:PastaDeBuild = Join-Path $script:PastaDoDesktop 'target\distribuicao'

# Roda um programa e para se ele falhar. No PowerShell 5.1 o que um programa escreve na saída de
# erro não pode virar erro fatal: vale o código de saída.
function Invoke-Programa {
    param([string]$Programa, [string[]]$Argumentos, [string]$Pasta = $script:PastaDoDesktop)
    Push-Location $Pasta
    try {
        $anterior = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $tudo = & $Programa @Argumentos 2>&1
        $codigo = $LASTEXITCODE
        $ErrorActionPreference = $anterior
        # O que veio pela saída de erro fica separado: só aparece se o programa falhar.
        $erros = @($tudo | Where-Object { $_ -is [Management.Automation.ErrorRecord] } | ForEach-Object { "$_" })
        if ($codigo -ne 0) {
            $fim = ($erros | Select-Object -Last 8) -join "`n"
            throw "$(Split-Path -Leaf $Programa) saiu com o codigo $codigo`n$fim"
        }
        return @($tudo | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] })
    } finally { Pop-Location }
}

# Grava um texto sem BOM, para o hash do arquivo ser o mesmo em qualquer máquina.
function Write-TextoSemBom {
    param([string]$Arquivo, [string]$Texto)
    [IO.File]::WriteAllText($Arquivo, $Texto, (New-Object Text.UTF8Encoding $false))
}

# O compilador do Inno Setup 6, instalado para o usuário ou para a máquina.
function Get-InnoSetup {
    $candidatos = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
        (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe')
    )
    $achado = $candidatos | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $achado) { throw 'o Inno Setup 6 nao esta instalado (winget install --id JRSoftware.InnoSetup)' }
    return $achado
}

# O signtool mais novo do Windows SDK.
function Get-Signtool {
    $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    $achado = Get-ChildItem -Path $kits -Filter signtool.exe -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -like '*\x64\signtool.exe' } |
        Sort-Object { [version]($_.Directory.Parent.Name) } -Descending | Select-Object -First 1
    if (-not $achado) { throw 'o signtool do Windows SDK nao foi encontrado' }
    return $achado.FullName
}

function ConvertTo-ImpressaoDigital {
    param([string]$Texto)
    $limpa = ($Texto -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()
    if ($limpa.Length -ne 40) { throw 'a impressao digital do certificado tem 40 caracteres hexadecimais' }
    return $limpa
}

# Confere, antes de compilar, que o certificado serve: está no repositório do usuário, tem chave
# acessível, é de assinatura de código e está na validade. Falhar aqui evita descobrir no fim.
function Test-CertificadoDeAssinatura {
    param([string]$Impressao)
    $limpa = ConvertTo-ImpressaoDigital $Impressao
    $certificado = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Thumbprint -eq $limpa } | Select-Object -First 1
    if (-not $certificado) { throw 'certificado nao encontrado em CurrentUser\My; a sessao do certificado em nuvem esta aberta?' }
    if (-not $certificado.HasPrivateKey) { throw 'o certificado nao tem chave privada acessivel' }
    $agora = Get-Date
    if ($certificado.NotBefore -gt $agora -or $certificado.NotAfter -lt $agora) { throw 'o certificado esta fora da validade' }
    $usos = @($certificado.EnhancedKeyUsageList | ForEach-Object { $_.ObjectId })
    if ($usos -notcontains '1.3.6.1.5.5.7.3.3') { throw 'o certificado nao e de assinatura de codigo' }
    return $certificado
}

# Assina um arquivo com SHA-256 e carimbo de tempo, e confere a assinatura depois.
function Invoke-Assinatura {
    param([string]$Arquivo, [string]$Impressao, [string]$CarimboDeTempo)
    $limpa = ConvertTo-ImpressaoDigital $Impressao
    $signtool = Get-Signtool
    Invoke-Programa $signtool @('sign', '/sha1', $limpa, '/fd', 'SHA256', '/tr', $CarimboDeTempo, '/td', 'SHA256', $Arquivo) | Out-Null
    Test-Assinatura $Arquivo $limpa
}

# A assinatura vale, é do certificado esperado e tem carimbo de tempo: sem o carimbo, ela deixa
# de valer quando o certificado vence.
function Test-Assinatura {
    param([string]$Arquivo, [string]$Impressao)
    $assinatura = Get-AuthenticodeSignature -LiteralPath $Arquivo
    if ($assinatura.Status -ne 'Valid') { throw "a assinatura de $(Split-Path -Leaf $Arquivo) nao vale: $($assinatura.Status)" }
    if ($assinatura.SignerCertificate.Thumbprint -ne (ConvertTo-ImpressaoDigital $Impressao)) { throw "$(Split-Path -Leaf $Arquivo) foi assinado por outro certificado" }
    if (-not $assinatura.TimeStamperCertificate) { throw "a assinatura de $(Split-Path -Leaf $Arquivo) nao tem carimbo de tempo" }
}

# A versao do app, lida de onde o Cargo a le.
function Get-VersaoDoApp {
    $metadados = (Invoke-Programa 'cargo' @('metadata', '--format-version', '1', '--no-deps', '--locked')) -join '' | ConvertFrom-Json
    $pacote = $metadados.packages | Where-Object { $_.name -eq 'awikabot-desktop' }
    if (-not $pacote) { throw 'o pacote awikabot-desktop nao esta no workspace' }
    if ($pacote.version -notmatch '^\d+\.\d+\.\d+$') { throw "versao fora do formato x.y.z: $($pacote.version)" }
    return $pacote.version
}

# O commit de onde o pacote sai, e se ha mudanca sem commit na pasta.
function Get-Origem {
    $commit = (Invoke-Programa 'git' @('rev-parse', 'HEAD') $script:RaizDoRepositorio | Select-Object -First 1).Trim()
    $pendentes = @(Invoke-Programa 'git' @('status', '--porcelain') $script:RaizDoRepositorio)
    return [pscustomobject]@{ Commit = $commit; Curto = $commit.Substring(0, 7); ComMudancas = ($pendentes.Count -gt 0) }
}

# As pastas desta maquina que o compilador grava nas mensagens de erro do programa, e o nome
# neutro que cada uma recebe no executavel distribuido.
function Get-CaminhosDaMaquina {
    $cargo = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $env:USERPROFILE '.cargo' }
    $rustup = if ($env:RUSTUP_HOME) { $env:RUSTUP_HOME } else { Join-Path $env:USERPROFILE '.rustup' }
    return @(
        [pscustomobject]@{ De = $cargo; Para = 'cargo' },
        [pscustomobject]@{ De = $rustup; Para = 'rustup' },
        [pscustomobject]@{ De = $script:RaizDoRepositorio; Para = 'awikabot' }
    )
}

# Onde ficam as evidências de um candidato: fora do Git e fora de target/, para uma limpeza de
# build não as apagar. A pasta relatorios/ é ignorada pelo Git.
function Get-PastaDeEvidencias {
    param([string]$Versao, $Origem)
    $sufixo = if ($Origem.ComMudancas) { '-com-mudancas' } else { '' }
    $pasta = Join-Path $script:RaizDoRepositorio "relatorios\release\$Versao-$($Origem.Curto)$sufixo"
    New-Item -ItemType Directory -Force $pasta | Out-Null
    return $pasta
}

function Get-Sha256 {
    param([string]$Arquivo)
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Arquivo).Hash.ToLowerInvariant()
}

# Procura um texto dentro de um arquivo binario, como o compilador o gravaria: em bytes simples
# e em UTF-16, sem diferenciar maiusculas.
function Test-TextoNoArquivo {
    param([byte[]]$Bytes, [string]$Texto)
    $simples = [Text.Encoding]::GetEncoding(28591).GetString($Bytes)
    if ($simples.IndexOf($Texto, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
    $largo = [Text.Encoding]::Unicode.GetString($Bytes)
    return ($largo.IndexOf($Texto, [StringComparison]::OrdinalIgnoreCase) -ge 0)
}
