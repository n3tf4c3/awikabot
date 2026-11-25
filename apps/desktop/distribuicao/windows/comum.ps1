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

# A versão do Inno Setup de onde sai o pacote que pode ser publicado. O carregador do instalador,
# que é o primeiro código a rodar na máquina de quem instala, vem do compilador: trocar de versão
# é mudar este valor, de propósito, como se muda a do Rust em rust-toolchain.toml. Pacote sem
# assinatura (QA e CI) pode sair de outra versão, que fica registrada no build-info.json.
$script:VersaoDoInnoSetup = '6.7.3'

# A versão do Inno Setup que acabou de montar o instalador de uma pasta. O roteiro do instalador a
# grava num arquivo ao lado, que é lido e apagado aqui: ele não faz parte do pacote.
function Read-VersaoDoInnoSetup {
    param([string]$Pasta)
    $arquivo = Join-Path $Pasta 'inno-setup.txt'
    if (-not (Test-Path $arquivo)) { throw 'o roteiro do instalador nao informou a versao do Inno Setup' }
    $versao = (Get-Content -Raw $arquivo).Trim()
    Remove-Item -LiteralPath $arquivo -Confirm:$false
    if ($versao -notmatch '^\d+\.\d+\.\d+$') { throw "versao do Inno Setup fora do formato x.y.z: $versao" }
    return $versao
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

# A linha de comando com que o Inno Setup assina o que ele mesmo monta: o instalador, o
# desinstalador e a cópia do programa de instalação que o instalador extrai e roda. O compilador
# troca `$f` pelo arquivo e `$q` por uma aspa. SHA-256 e carimbo de tempo, como em Invoke-Assinatura.
function Get-ComandoDeAssinatura {
    param([string]$Impressao, [string]$CarimboDeTempo)
    $limpa = ConvertTo-ImpressaoDigital $Impressao
    if ($CarimboDeTempo -notmatch '^https?://[A-Za-z0-9./:_-]+$') { throw 'o endereco do carimbo de tempo esta fora do formato esperado' }
    return '$q' + (Get-Signtool) + '$q sign /sha1 ' + $limpa + ' /fd SHA256 /tr ' + $CarimboDeTempo + ' /td SHA256 $f'
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

# A pasta de evidências do commit de onde um pacote saiu, pelo `build-info.json` dele.
function Get-PastaDeEvidenciasDoPacote {
    param($Informacoes)
    $origem = [pscustomobject]@{ Curto = $Informacoes.commit.Substring(0, 7); ComMudancas = [bool]$Informacoes.com_mudancas }
    return Get-PastaDeEvidencias $Informacoes.versao $origem
}

# O pacote pedido ou, sem pedido, o mais recente.
function Resolve-Pacote {
    param([string]$Pacote)
    if (-not $Pacote) {
        $Pacote = Get-ChildItem (Join-Path $script:PastaDeBuild 'pacotes') -Directory -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
    }
    if (-not $Pacote -or -not (Test-Path $Pacote)) { throw 'nenhum pacote encontrado; rode o empacotar.ps1 antes' }
    return (Resolve-Path $Pacote).Path
}

# O repositório e o começo da etiqueta dos releases, lidos de onde o atualizador do app os lê:
# o que é publicado tem de estar onde o app instalado procura.
function Get-DestinoDosReleases {
    $fonte = Get-Content -Raw (Join-Path $script:PastaDoDesktop 'crates\cliente\src\atualizacao.rs')
    $repositorio = [regex]::Match($fonte, '(?m)^const REPOSITORIO: &str = "([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)";')
    $prefixo = [regex]::Match($fonte, '(?m)^pub const PREFIXO_DA_ETIQUETA: &str = "([a-z0-9-]+)";')
    if (-not $repositorio.Success -or -not $prefixo.Success) { throw 'nao achei o repositorio ou a etiqueta dos releases em atualizacao.rs' }
    return [pscustomobject]@{ Repositorio = $repositorio.Groups[1].Value; Prefixo = $prefixo.Groups[1].Value }
}

# Os releases do repositório no GitHub, rascunhos inclusive, como a API os devolve.
function Get-Releases {
    param([string]$Gh, [string]$Repositorio)
    $texto = (Invoke-Programa $Gh @('api', "repos/$Repositorio/releases?per_page=100") $script:RaizDoRepositorio) -join "`n"
    return @($texto | ConvertFrom-Json | ForEach-Object { $_ })
}

# A etiqueta existe no repositório do GitHub? Devolve o commit para onde ela aponta, ou nada.
function Get-CommitDaEtiqueta {
    param([string]$Gh, [string]$Repositorio, [string]$Etiqueta)
    $texto = (Invoke-Programa $Gh @('api', "repos/$Repositorio/git/matching-refs/tags/$Etiqueta") $script:RaizDoRepositorio) -join "`n"
    $achada = @($texto | ConvertFrom-Json | ForEach-Object { $_ }) | Where-Object { $_.ref -eq "refs/tags/$Etiqueta" } | Select-Object -First 1
    if ($achada) { return $achada.object.sha }
    return $null
}

# A maior versão do desktop já pública: o atualizador só oferece versão maior que a instalada.
function Get-MaiorVersaoPublica {
    param($Releases, [string]$Prefixo)
    $versoes = @($Releases | Where-Object { -not $_.draft -and -not $_.prerelease -and $_.tag_name -like "$Prefixo*" } |
        ForEach-Object { $_.tag_name.Substring($Prefixo.Length) } | Where-Object { $_ -match '^\d+\.\d+\.\d+$' } |
        ForEach-Object { [version]$_ })
    if ($versoes.Count -eq 0) { return $null }
    return ($versoes | Sort-Object -Descending | Select-Object -First 1)
}

# O commit está na `main` do repositório remoto? A `main` é buscada antes, para valer a de agora.
function Test-CommitNaMain {
    param([string]$Commit)
    Invoke-Programa 'git' @('fetch', '--quiet', 'origin', 'main') $script:RaizDoRepositorio | Out-Null
    # O git sai com 1 quando o commit não está na `main`, e com erro quando nem o conhece.
    try { Invoke-Programa 'git' @('merge-base', '--is-ancestor', $Commit, 'origin/main') $script:RaizDoRepositorio | Out-Null; return $true }
    catch { return $false }
}

# A versão que o Cargo declara num commit, lida do Git e não da pasta de trabalho.
function Get-VersaoNoCommit {
    param([string]$Commit)
    $cargo = (Invoke-Programa 'git' @('show', "${Commit}:apps/desktop/Cargo.toml") $script:RaizDoRepositorio) -join "`n"
    $achada = [regex]::Match($cargo, '(?ms)^\[workspace\.package\].*?^version\s*=\s*"(\d+\.\d+\.\d+)"')
    if (-not $achada.Success) { throw "nao achei a versao do desktop no commit $Commit" }
    return $achada.Groups[1].Value
}

function Read-Evidencia {
    param([string]$Arquivo)
    if (-not (Test-Path $Arquivo)) { return $null }
    try { return Get-Content -Raw $Arquivo | ConvertFrom-Json } catch { return $null }
}

# Os três arquivos que vão para o release, pelo nome que o atualizador procura.
function Get-NomesDosPublicados {
    param([string]$Versao)
    return @("awikabot-$Versao-windows-x64.exe", 'awikabot-desktop-windows-x64.json', 'SHA256SUMS')
}

# Grava a evidência da conferência dos artefatos: o hash de cada arquivo que vai para o release.
# É contra ela que a publicação confere o que está subindo. Devolve o arquivo gravado.
function Write-EvidenciaDosArtefatos {
    param([string]$Pacote, [string]$Pasta, [string]$Versao, [string]$Commit)
    $arquivos = [ordered]@{}
    foreach ($nome in (Get-NomesDosPublicados $Versao)) { $arquivos[$nome] = Get-Sha256 (Join-Path $Pacote $nome) }
    $evidencia = [ordered]@{
        aprovado = $true
        versao   = $Versao
        commit   = $Commit
        quando   = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        arquivos = $arquivos
    }
    $arquivo = Join-Path $Pasta 'artefatos.json'
    Write-TextoSemBom $arquivo ((($evidencia | ConvertTo-Json -Depth 4) -replace "`r`n", "`n") + "`n")
    return $arquivo
}

# A evidência de uma rodada de QA no Sandbox: amarra o resultado ao pacote testado e ao tipo de
# rodada. Devolve o nome do arquivo na pasta do candidato e o texto dele. `$Anterior` é a versão
# de onde a rodada também partiu (versão, instalador e SHA-256), ou nada.
function New-EvidenciaDoQa {
    param($Manifesto, $Informacoes, $Resultado, [bool]$ComRede, [bool]$MarcaDeDownload, [bool]$SmartAppControlDesligado, $Anterior = $null)
    $evidencia = [ordered]@{
        aprovado                    = $Resultado.aprovado
        versao                      = $Manifesto.versao
        instalador                  = $Manifesto.arquivo
        sha256                      = $Manifesto.sha256
        assinado                    = $Informacoes.assinado
        commit                      = $Informacoes.commit
        com_rede                    = $ComRede
        marca_de_download           = $MarcaDeDownload
        smart_app_control_desligado = $SmartAppControlDesligado
        anterior                    = $Anterior
        resultado                   = $Resultado
    }
    $nome = if ($ComRede) { 'qa-sandbox-com-rede.json' } else { 'qa-sandbox-sem-rede.json' }
    return [pscustomobject]@{ Nome = $nome; Texto = (($evidencia | ConvertTo-Json -Depth 8) + "`n") }
}

# O que falta nas evidências de um candidato para ele poder ser publicado: as conferências do
# commit, a conferência dos artefatos e as duas rodadas de QA, todas do mesmo commit e do mesmo
# instalador. Devolve um problema por linha; nada, se está tudo lá.
function Get-ProblemasDasEvidencias {
    param([string]$Pasta, [string]$Versao, [string]$Commit)
    $candidato = Read-Evidencia (Join-Path $Pasta 'candidato.json')
    if (-not $candidato) { 'falta a evidencia das conferencias do candidato (candidato.json)' }
    else {
        if (-not $candidato.aprovado) { 'as conferencias do candidato nao foram aprovadas' }
        if ($candidato.commit -ne $Commit) { 'as conferencias do candidato sao de outro commit' }
        if ($candidato.com_mudancas) { 'as conferencias do candidato rodaram com mudancas sem commit' }
        if ($candidato.versao -ne $Versao) { 'as conferencias do candidato sao de outra versao' }
    }
    $instalador = $null
    $artefatos = Read-Evidencia (Join-Path $Pasta 'artefatos.json')
    if (-not $artefatos) { 'falta a evidencia da conferencia dos artefatos (artefatos.json)' }
    else {
        if (-not $artefatos.aprovado) { 'a conferencia dos artefatos nao foi aprovada' }
        if ($artefatos.commit -ne $Commit) { 'a conferencia dos artefatos e de outro commit' }
        if ($artefatos.versao -ne $Versao) { 'a conferencia dos artefatos e de outra versao' }
        $nomes = Get-NomesDosPublicados $Versao
        $registrados = @($artefatos.arquivos.PSObject.Properties | ForEach-Object { $_.Name })
        if ((($registrados | Sort-Object) -join '|') -ne (($nomes | Sort-Object) -join '|')) { 'a conferencia dos artefatos nao registra exatamente os tres arquivos do release' }
        else { $instalador = $artefatos.arquivos.PSObject.Properties[$nomes[0]].Value }
    }
    foreach ($rodada in @(@{ Nome = 'sem rede'; Arquivo = 'qa-sandbox-sem-rede.json'; ComRede = $false }, @{ Nome = 'com rede'; Arquivo = 'qa-sandbox-com-rede.json'; ComRede = $true })) {
        $qa = Read-Evidencia (Join-Path $Pasta $rodada.Arquivo)
        if (-not $qa) { "falta o QA no Sandbox $($rodada.Nome) ($($rodada.Arquivo))"; continue }
        if (-not $qa.aprovado) { "o QA no Sandbox $($rodada.Nome) reprovou o pacote" }
        if ($qa.commit -ne $Commit) { "o QA no Sandbox $($rodada.Nome) e de outro commit" }
        if (-not $instalador -or $qa.sha256 -ne $instalador) { "o QA no Sandbox $($rodada.Nome) testou outro instalador" }
        if (-not $qa.assinado) { "o QA no Sandbox $($rodada.Nome) rodou com pacote sem assinatura" }
        if ($qa.smart_app_control_desligado -ne $false) { "o QA no Sandbox $($rodada.Nome) rodou com o Smart App Control desligado" }
        if ([bool]$qa.com_rede -ne $rodada.ComRede) { "a evidencia do QA $($rodada.Nome) e de outro tipo de rodada" }
        if ($rodada.ComRede -and -not $qa.marca_de_download) { 'o QA com rede rodou sem a marca de download' }
    }
}

# O manifesto que um release público traz, baixado do GitHub: descreve o instalador que as
# pessoas têm instalado. Devolve nada se não der para baixar ou ler.
function Get-ManifestoPublicado {
    param([string]$Gh, [string]$Repositorio, [string]$Etiqueta)
    $nome = 'awikabot-desktop-windows-x64.json'
    $pasta = New-PastaTemporaria 'manifesto-publicado'
    try {
        Invoke-Programa $Gh @('release', 'download', $Etiqueta, '--repo', $Repositorio, '--pattern', $nome, '--dir', $pasta) $script:RaizDoRepositorio | Out-Null
        return Read-Evidencia (Join-Path $pasta $nome)
    } catch {
        return $null
    } finally {
        Remove-Item -LiteralPath $pasta -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue
    }
}

# Quem já tem o app parte da última versão pública: as duas rodadas de QA têm de ter partido
# dela, e do instalador que está publicado, não de outro pacote com o mesmo número. O manifesto
# dessa versão é lido do GitHub. Devolve um problema por linha; nada, se as duas partiram dela.
function Get-ProblemasDaPartidaDoQa {
    param([string]$Pasta, [string]$Gh, $Destino, [version]$UltimaPublica)
    $publicado = Get-ManifestoPublicado $Gh $Destino.Repositorio "$($Destino.Prefixo)$UltimaPublica"
    if (-not $publicado -or [string]$publicado.versao -ne "$UltimaPublica" -or [string]$publicado.sha256 -notmatch '^[0-9a-f]{64}$') {
        "nao deu para ler o manifesto da ultima versao publica, $UltimaPublica"
        return
    }
    foreach ($rodada in @(@{ Nome = 'sem rede'; Arquivo = 'qa-sandbox-sem-rede.json' }, @{ Nome = 'com rede'; Arquivo = 'qa-sandbox-com-rede.json' })) {
        $qa = Read-Evidencia (Join-Path $Pasta $rodada.Arquivo)
        # A falta da rodada já é acusada por Get-ProblemasDasEvidencias.
        if (-not $qa) { continue }
        $partida = $qa.anterior
        if (-not $partida) { "o QA no Sandbox $($rodada.Nome) nao partiu da ultima versao publica, $UltimaPublica" }
        elseif ([string]$partida.versao -ne "$UltimaPublica") { "o QA no Sandbox $($rodada.Nome) partiu da versao $($partida.versao), e a ultima publica e a $UltimaPublica" }
        elseif ([string]$partida.sha256 -ne [string]$publicado.sha256) { "o QA no Sandbox $($rodada.Nome) partiu de um instalador da $UltimaPublica que nao e o publicado" }
    }
}

# A versão anterior, de uma pasta com o instalador e o manifesto dela: a pasta do pacote, ou os
# dois arquivos baixados do release. O que o manifesto diz vira nome de arquivo, então só passa
# no formato esperado, e o instalador tem de ser o do manifesto. `$MenorQue` é a versão para a
# qual o app vai ser atualizado, e `$Qual` diz qual é ela na mensagem. Com `$ExigirAssinatura`,
# o instalador tem de ter assinatura válida: com o Smart App Control ligado, o Sandbox o bloquearia.
function Resolve-VersaoAnterior {
    param([string]$Pasta, [string]$MenorQue, [bool]$ExigirAssinatura, [string]$Qual = 'a do pacote')
    $resolvida = (Resolve-Path -LiteralPath $Pasta).Path
    $arquivoDoManifesto = Join-Path $resolvida 'awikabot-desktop-windows-x64.json'
    if (-not (Test-Path -LiteralPath $arquivoDoManifesto)) { throw "falta o manifesto da versao anterior: $arquivoDoManifesto" }
    $manifesto = Get-Content -Raw -LiteralPath $arquivoDoManifesto | ConvertFrom-Json
    if ([string]$manifesto.versao -notmatch '^\d+\.\d+\.\d+$') { throw 'a versao no manifesto da versao anterior esta fora do formato x.y.z' }
    if ([string]$manifesto.arquivo -ne "awikabot-$($manifesto.versao)-windows-x64.exe") { throw 'o manifesto da versao anterior aponta para um arquivo com outro nome' }
    if ([version]$manifesto.versao -ge [version]$MenorQue) { throw "a versao anterior ($($manifesto.versao)) tem de ser menor que $Qual ($MenorQue)" }
    $instalador = Join-Path $resolvida $manifesto.arquivo
    if (-not (Test-Path -LiteralPath $instalador)) { throw "falta o instalador da versao anterior: $instalador" }
    if ((Get-Sha256 $instalador) -ne $manifesto.sha256) { throw 'o instalador da versao anterior nao e o do manifesto dela' }
    if ($ExigirAssinatura -and (Get-AuthenticodeSignature -LiteralPath $instalador).Status -ne 'Valid') {
        throw 'o instalador da versao anterior nao tem assinatura valida: com o Smart App Control ligado, o Sandbox o bloquearia'
    }
    return [pscustomobject]@{
        Instalador = $instalador
        Manifesto  = $arquivoDoManifesto
        Partida    = [ordered]@{ versao = [string]$manifesto.versao; instalador = [string]$manifesto.arquivo; sha256 = [string]$manifesto.sha256 }
    }
}

# O que o histórico de uma atualização vista num app instalado mostra, passo a passo. `$Partida`
# é o que o Sandbox anotou ao instalar a versão anterior e abrir o app; `$Estados`, os estados do
# disco e do registro que ele anotou depois, na ordem; `$De` e `$Para`, a versão instalada e a
# versão nova; `$Publicado`, o manifesto público da versão nova. Cada passo só vale a partir do
# estado em que o anterior foi visto. Devolve os passos, cada um com `ok` e o que faltou.
function Get-PassosDaAtualizacao {
    param($Partida, $Estados, [string]$De, [string]$Para, $Publicado, [bool]$SoAteAConsulta)
    $lista = @($Estados | Where-Object { $_ })
    # O primeiro estado, de `$desde` em diante, que atende à condição; -1 se nenhum atende.
    function Achar([int]$desde, [scriptblock]$condicao) {
        if ($desde -lt 0) { return -1 }
        for ($i = $desde; $i -lt $lista.Count; $i++) { if (& $condicao $lista[$i]) { return $i } }
        return -1
    }
    function Passo([string]$nome, [bool]$ok, [string]$detalhe) {
        return [ordered]@{ passo = $nome; ok = $ok; detalhe = $(if ($ok) { '' } else { $detalhe }) }
    }
    function PacoteNovo($estado) { @($estado.pacotes | Where-Object { $_.nome -eq $Publicado.arquivo }) | Select-Object -First 1 }

    $falta = ''
    if (-not $Partida) { $falta = 'o Sandbox nao disse como foi a instalacao' }
    elseif ($Partida.erro) { $falta = [string]$Partida.erro }
    elseif (-not $Partida.instalador_conferido) { $falta = 'o instalador que chegou ao Sandbox nao e o do manifesto' }
    elseif ($Partida.codigo_do_instalador -ne 0) { $falta = "o instalador saiu com o codigo $($Partida.codigo_do_instalador)" }
    elseif ([string]$Partida.versao_instalada -ne $De) { $falta = "versao instalada: $($Partida.versao_instalada)" }
    elseif (-not $Partida.janela) { $falta = 'a janela do app nao apareceu' }
    Passo "a versao $De foi instalada e o app abriu" (-not $falta) $falta

    $consulta = Achar 0 { param($e) $e.versao_do_executavel -eq $De -and $e.preferencias -and [double]$e.preferencias.ultima_consulta_s -gt 0 }
    Passo "o app da $De consultou as versoes publicadas" ($consulta -ge 0) 'as preferencias nao registraram a consulta'
    if ($SoAteAConsulta) { return }

    $semOAnterior = 'so vale depois do passo anterior, que nao foi visto'

    $baixado = Achar $consulta { param($e) $p = PacoteNovo $e; $p -and $p.tamanho -eq $Publicado.tamanho -and $p.sha256 -eq $Publicado.sha256 }
    $falta = 'o pacote nao apareceu na pasta de atualizacoes'
    if ($consulta -lt 0) { $falta = $semOAnterior }
    else {
        # Um pacote com o nome certo e outro conteúdo: diz o que foi visto por último.
        for ($i = $consulta; $i -lt $lista.Count; $i++) {
            $p = PacoteNovo $lista[$i]
            if ($p) { $falta = "o pacote baixado tem $($p.tamanho) bytes e hash $($p.sha256)" }
        }
    }
    Passo "o pacote da $Para foi baixado, com o tamanho e o hash do manifesto publico" ($baixado -ge 0) $falta

    $trocado = Achar $baixado { param($e) $e.versao_do_executavel -eq $Para -and $e.versao_no_registro -eq $Para }
    $falta = $semOAnterior
    if ($baixado -ge 0) { $fim = $lista[$lista.Count - 1]; $falta = "no fim, executavel na $($fim.versao_do_executavel) e registro na $($fim.versao_no_registro)" }
    Passo "o executavel e o registro passaram a $Para" ($trocado -ge 0) $falta

    # O processo do app antes da troca: o último visto aberto, ou o que a partida anotou.
    $antes = $Partida.processo
    for ($i = 0; $i -lt $trocado; $i++) { if ($lista[$i].app_aberto -and $lista[$i].processo) { $antes = $lista[$i].processo } }
    $reaberto = Achar $trocado { param($e) $e.app_aberto -and $e.processo -and $e.processo -ne $antes -and $e.versao_do_executavel -eq $Para }
    $falta = $semOAnterior
    if ($trocado -ge 0) {
        $falta = 'o app nao foi visto aberto depois da troca'
        if ((Achar $trocado { param($e) $e.app_aberto -and $e.processo -eq $antes }) -ge 0) { $falta = 'o processo e o mesmo de antes: o app nao foi fechado' }
    }
    Passo "o app reabriu na $Para, em outro processo" ($reaberto -ge 0) $falta

    $limpo = Achar $reaberto { param($e) @($e.pacotes | Where-Object { $_ }).Count -eq 0 }
    $falta = if ($reaberto -ge 0) { 'o pacote continuou na pasta de atualizacoes' } else { $semOAnterior }
    Passo 'o app novo apagou o pacote baixado' ($limpo -ge 0) $falta
}

# De quem foram os cliques no painel de atualização, pelo que o roteiro de dentro do Sandbox
# anotou (`roteiro.jsonl`, de `ver-atualizacao-dentro.ps1`). Só são do roteiro quando ele anotou
# um clique em cada botão: repetir o "Baixar" não vale por "Instalar e reabrir". O que ele não
# clicou ficou para uma pessoa; se alguém clicou, quem diz é o julgamento do histórico.
function Get-AutoriaDosCliques {
    param($Roteiro, [bool]$Clicar, [bool]$SoAteAConsulta)
    if ($SoAteAConsulta) { return 'nenhum: a rodada parou na consulta' }
    if (-not $Clicar) { return 'de uma pessoa, no painel do app' }
    $anotado = @($Roteiro | Where-Object { $_ } | ForEach-Object { [string]$_.o_que })
    $emBaixar = @($anotado | Where-Object { $_ -like 'clique em Baixar,*' }).Count -gt 0
    $emInstalar = @($anotado | Where-Object { $_ -like 'clique em Instalar e reabrir,*' }).Count -gt 0
    if ($emBaixar -and $emInstalar) { return 'do roteiro de dentro do Sandbox, por coordenada' }
    if ($emBaixar) { return 'o roteiro de dentro so clicou em Baixar; Instalar e reabrir ficou para uma pessoa' }
    if ($emInstalar) { return 'o roteiro de dentro so clicou em Instalar e reabrir; Baixar ficou para uma pessoa' }
    return 'o roteiro de dentro nao clicou; os cliques ficaram para uma pessoa'
}

# Os hashes dos arquivos de uma pasta batem com os que a conferência dos artefatos registrou?
# Devolve um problema por arquivo que falta ou difere.
function Get-ProblemasDosArquivos {
    param([string]$Pasta, $Artefatos, [string]$Versao, [string]$Onde)
    foreach ($nome in (Get-NomesDosPublicados $Versao)) {
        $arquivo = Join-Path $Pasta $nome
        $registro = $Artefatos.arquivos.PSObject.Properties[$nome]
        if (-not (Test-Path $arquivo)) { "falta $nome $Onde" }
        elseif (-not $registro -or (Get-Sha256 $arquivo) -ne $registro.Value) { "$nome $Onde nao e o arquivo que foi conferido" }
    }
}

# Uma pasta temporária própria, que quem chama apaga no fim.
function New-PastaTemporaria {
    param([string]$Nome)
    $pasta = Join-Path ([IO.Path]::GetTempPath()) ("awikabot-$Nome-" + [guid]::NewGuid().ToString('N'))
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
