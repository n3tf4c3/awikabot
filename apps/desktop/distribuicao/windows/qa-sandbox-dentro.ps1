# Roda DENTRO do Windows Sandbox, chamado pelo qa-sandbox.ps1. Nunca rodar no computador de
# trabalho: ele instala e desinstala o app, mexe no cofre de credenciais e desliga a máquina no fim.
#
# Confere o instalador como uma pessoa o usaria: instala, abre o app, atualiza por cima com o app
# aberto, desinstala, e olha o que sobrou. Com a versão anterior na entrada, instala também a
# dela e atualiza para o pacote. O resultado vai para C:\qa\saida\result.json, que é a única
# coisa que volta para fora.
param(
    # Só para pacote sem assinatura, e só aqui dentro: sem isso o Smart App Control o bloqueia.
    [switch]$DesligarSmartAppControl,
    # Marca o instalador como baixado da Internet, como o navegador faria. Só para pacote assinado.
    [switch]$MarcaDeDownload,
    # Parte também da versão anterior, que veio em C:\qa\entrada\anterior: instala a dela e
    # atualiza para o pacote, como acontece com quem já tem o app.
    [switch]$ComAnterior
)
$ErrorActionPreference = 'Stop'
$entrada = 'C:\qa\entrada'
$saida = 'C:\qa\saida'
$trabalho = 'C:\qa\trabalho'
$identidade = 'awikabot.desktop'
$pastaDoApp = Join-Path $env:LOCALAPPDATA 'Programs\awikabot'
$exeDoApp = Join-Path $pastaDoApp 'awikabot.exe'
$atalho = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\awikabot.lnk'
$registroDaIdentidade = "HKCU:\Software\Classes\AppUserModelId\$identidade"
$itemNoCofre = 'sessao.awikabot'
$pastaDeDados = Join-Path $env:LOCALAPPDATA 'awikabot'
$passos = New-Object System.Collections.ArrayList

function Registrar([string]$passo, [bool]$ok, [string]$detalhe = '') {
    [void]$passos.Add([ordered]@{ passo = $passo; ok = $ok; detalhe = $detalhe })
}
# Roda uma conferência; uma exceção vira falha daquele passo, e o roteiro segue.
function Conferir([string]$passo, [scriptblock]$bloco) {
    try {
        $resultado = & $bloco
        if ($resultado -is [string] -and $resultado) { Registrar $passo $false $resultado } else { Registrar $passo $true }
    } catch { Registrar $passo $false "$_" }
}
function Rodar([string]$programa, [string[]]$argumentos, [int]$prazoS = 180) {
    $processo = Start-Process -FilePath $programa -ArgumentList $argumentos -PassThru
    if (-not $processo.WaitForExit($prazoS * 1000)) { $processo.Kill(); throw "$(Split-Path -Leaf $programa) nao terminou em $prazoS s" }
    return $processo.ExitCode
}
# O desinstalador do Inno Setup se copia para uma pasta temporária e segue de lá: espera também essa cópia.
function RodarDesinstalador([string[]]$argumentos, [int]$prazoS = 120) {
    $codigo = Rodar (Join-Path $pastaDoApp 'unins000.exe') $argumentos $prazoS
    $fim = (Get-Date).AddSeconds($prazoS)
    while ((Get-Process | Where-Object { $_.Name -like '_iu*' -or $_.Name -like 'unins*' }) -and (Get-Date) -lt $fim) { Start-Sleep -Milliseconds 500 }
    Start-Sleep -Seconds 2
    return $codigo
}
function ProcessosDoApp { @(Get-Process -Name awikabot -ErrorAction SilentlyContinue) }
function AppAberto {
    try { [Threading.Mutex]::OpenExisting($identidade).Dispose(); return $true } catch { return $false }
}
function EsperarJanela([int]$prazoS = 90) {
    $fim = (Get-Date).AddSeconds($prazoS)
    while ((Get-Date) -lt $fim) {
        $comJanela = ProcessosDoApp | Where-Object { $_.Refresh(); $_.MainWindowHandle -ne [IntPtr]::Zero }
        if ($comJanela) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}
function FecharApp {
    foreach ($processo in ProcessosDoApp) { [void]$processo.CloseMainWindow() }
    $fim = (Get-Date).AddSeconds(20)
    while ((ProcessosDoApp).Count -gt 0 -and (Get-Date) -lt $fim) { Start-Sleep -Milliseconds 300 }
    foreach ($processo in ProcessosDoApp) { $processo.Kill() }
    Start-Sleep -Milliseconds 500
}
function NoCofre { [bool](cmdkey /list | Select-String -SimpleMatch $itemNoCofre) }
function IdentidadeDoAtalho {
    $shell = New-Object -ComObject Shell.Application
    $pasta = $shell.Namespace((Split-Path -Parent $atalho))
    return $pasta.ParseName((Split-Path -Leaf $atalho)).ExtendedProperty('System.AppUserModel.ID')
}
function EntradaDeDesinstalacao([string]$raiz) {
    Get-ChildItem "$raiz\Software\Microsoft\Windows\CurrentVersion\Uninstall" -ErrorAction SilentlyContinue |
        Where-Object { $_.GetValue('DisplayName') -eq 'awikabot' } | Select-Object -First 1
}

$estadoDoSac = $null
$aprovado = $false
try {
    New-Item -ItemType Directory -Force $trabalho | Out-Null
    $politica = 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy'
    $estadoDoSac = (Get-ItemProperty $politica -ErrorAction SilentlyContinue).VerifiedAndReputablePolicyState
    if ($DesligarSmartAppControl) {
        Conferir 'desligar o Smart App Control, so dentro do Sandbox' {
            Set-ItemProperty $politica -Name VerifiedAndReputablePolicyState -Value 0
            & "$env:SystemRoot\System32\CiTool.exe" -r | Out-Null
        }
    }

    $manifesto = Get-Content -Raw (Join-Path $entrada 'awikabot-desktop-windows-x64.json') | ConvertFrom-Json
    $instalador = Join-Path $trabalho $manifesto.arquivo
    Copy-Item (Join-Path $entrada $manifesto.arquivo) $instalador
    Conferir 'o instalador e o do manifesto' {
        $hash = (Get-FileHash -Algorithm SHA256 $instalador).Hash.ToLowerInvariant()
        if ($hash -ne $manifesto.sha256 -or (Get-Item $instalador).Length -ne $manifesto.tamanho) { 'tamanho ou hash diferente do manifesto' }
    }
    if ($MarcaDeDownload) {
        Set-Content -LiteralPath $instalador -Stream Zone.Identifier -Value "[ZoneTransfer]`r`nZoneId=3"
    }
    $silencioso = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART')

    # --- Instalar ---------------------------------------------------------------
    Conferir 'instalar em silencio' {
        $codigo = Rodar $instalador ($silencioso + "/LOG=$saida\instalacao.log")
        if ($codigo -ne 0) { "o instalador saiu com o codigo $codigo" }
    }
    Conferir 'o executavel esta na pasta do usuario, na versao do manifesto' {
        if (-not (Test-Path $exeDoApp)) { return "nao existe: $exeDoApp" }
        $versao = (Get-Item $exeDoApp).VersionInfo.ProductVersion
        if ($versao -ne $manifesto.versao) { "versao instalada: $versao" }
    }
    Conferir 'as licencas foram instaladas' {
        foreach ($arquivo in @('LICENSE.txt', 'LICENCAS-DE-TERCEIROS.txt')) {
            if (-not (Test-Path (Join-Path $pastaDoApp $arquivo))) { return "falta $arquivo" }
        }
    }
    Conferir 'o atalho do Menu Iniciar existe e carrega a identidade do app' {
        if (-not (Test-Path $atalho)) { return 'o atalho nao existe' }
        $lida = IdentidadeDoAtalho
        if ($lida -ne $identidade) { "identidade do atalho: $lida" }
    }
    Conferir 'a instalacao e so do usuario' {
        if (-not (EntradaDeDesinstalacao 'HKCU:')) { return 'sem entrada de desinstalacao no registro do usuario' }
        if (EntradaDeDesinstalacao 'HKLM:') { return 'ha entrada de desinstalacao no registro da maquina' }
        if ((EntradaDeDesinstalacao 'HKCU:').GetValue('DisplayVersion') -ne $manifesto.versao) { 'a versao no registro nao e a do manifesto' }
    }

    # --- Abrir ------------------------------------------------------------------
    Conferir 'o app abre a janela' {
        Start-Process -FilePath $exeDoApp
        if (-not (EsperarJanela)) { return 'a janela nao apareceu' }
        if (-not (AppAberto)) { 'o app nao criou a marca de aberto' }
    }
    Conferir 'com o app aberto, a desinstalacao em silencio recusa e nao tira nada' {
        $codigo = RodarDesinstalador $silencioso 60
        if ($codigo -eq 0) { return 'o desinstalador disse que deu certo' }
        if (-not (Test-Path $exeDoApp)) { 'o executavel foi apagado com o app aberto' }
    }

    # --- Atualizar por cima, como o atualizador do app faz ------------------------
    Conferir 'atualizar com o app aberto: o instalador fecha o app, troca e reabre' {
        $antes = (ProcessosDoApp | Select-Object -First 1).Id
        if (-not $antes) { return 'o app nao estava aberto para a atualizacao' }
        $codigo = Rodar $instalador ($silencioso + @('/CLOSEAPPLICATIONS', '/REABRIR=1', "/LOG=$saida\atualizacao.log"))
        if ($codigo -ne 0) { return "o instalador saiu com o codigo $codigo" }
        if (-not (EsperarJanela)) { return 'o app nao voltou depois da atualizacao' }
        $depois = (ProcessosDoApp | Select-Object -First 1).Id
        if ($depois -eq $antes) { 'o processo e o mesmo de antes: o app nao foi fechado' }
    }
    FecharApp
    Conferir 'o app fecha pela janela' { if ((ProcessosDoApp).Count -gt 0 -or (AppAberto)) { 'o app continuou aberto' } }

    # --- Desinstalar --------------------------------------------------------------
    # Como se o app tivesse sido usado: um item no cofre e o registro que o primeiro aviso grava.
    cmdkey "/generic:$itemNoCofre" /user:sessao /pass:conteudo-de-teste-que-nao-e-uma-sessao | Out-Null
    New-Item -Path $registroDaIdentidade -Force | Out-Null
    # E as preferencias e um pacote baixado pelo atualizador.
    New-Item -ItemType Directory -Force (Join-Path $pastaDeDados 'atualizacoes') | Out-Null
    Set-Content (Join-Path $pastaDeDados 'preferencias.json') '{}'
    Set-Content (Join-Path $pastaDeDados 'atualizacoes\pacote-de-teste.exe') 'conteudo de teste'
    Conferir 'ha o que limpar antes de desinstalar' { if (-not (NoCofre) -or -not (Test-Path $registroDaIdentidade) -or -not (Test-Path (Join-Path $pastaDeDados 'preferencias.json'))) { 'o item do cofre, o registro ou a pasta de dados de teste nao foram criados' } }
    Conferir 'desinstalar em silencio' {
        $codigo = RodarDesinstalador $silencioso
        if ($codigo -ne 0) { "o desinstalador saiu com o codigo $codigo" }
    }
    Conferir 'nao sobrou arquivo nem atalho' {
        if (Test-Path $pastaDoApp) { return "sobrou: " + ((Get-ChildItem -Recurse -Force $pastaDoApp | ForEach-Object { $_.Name }) -join ', ') }
        if (Test-Path $atalho) { 'sobrou o atalho' }
    }
    Conferir 'nao sobrou registro' {
        if (EntradaDeDesinstalacao 'HKCU:') { return 'sobrou a entrada de desinstalacao' }
        if (Test-Path $registroDaIdentidade) { 'sobrou o registro da identidade do app' }
    }
    Conferir 'nao sobrou a pasta de dados do app' { if (Test-Path $pastaDeDados) { 'sobrou a pasta de dados' } }
    Conferir 'nao sobrou credencial no cofre' { if (NoCofre) { 'o item do app continua no cofre' } }
    Conferir 'nao sobrou processo' { if ((ProcessosDoApp).Count -gt 0) { 'ha processo do app rodando' } }

    # --- A partir da versão anterior ------------------------------------------------
    # Quem já tem o app recebe o pacote por cima da versão publicada. Instala a anterior, abre o
    # app e atualiza como o atualizador dele faz: a versão tem de mudar e as preferências, ficar.
    if ($ComAnterior) {
        $manifestoAnterior = Get-Content -Raw (Join-Path $entrada 'anterior\awikabot-desktop-windows-x64.json') | ConvertFrom-Json
        New-Item -ItemType Directory -Force (Join-Path $trabalho 'anterior') | Out-Null
        $instaladorAnterior = Join-Path $trabalho "anterior\$($manifestoAnterior.arquivo)"
        Copy-Item (Join-Path $entrada "anterior\$($manifestoAnterior.arquivo)") $instaladorAnterior
        Conferir 'o instalador da versao anterior e o do manifesto dela' {
            $hash = (Get-FileHash -Algorithm SHA256 $instaladorAnterior).Hash.ToLowerInvariant()
            if ($hash -ne $manifestoAnterior.sha256 -or (Get-Item $instaladorAnterior).Length -ne $manifestoAnterior.tamanho) { return 'tamanho ou hash diferente do manifesto' }
            if ($manifestoAnterior.versao -eq $manifesto.versao) { 'a versao anterior e a mesma do pacote' }
        }
        if ($MarcaDeDownload) {
            Set-Content -LiteralPath $instaladorAnterior -Stream Zone.Identifier -Value "[ZoneTransfer]`r`nZoneId=3"
        }
        Conferir 'instalar a versao anterior em silencio' {
            $codigo = Rodar $instaladorAnterior ($silencioso + "/LOG=$saida\instalacao-anterior.log")
            if ($codigo -ne 0) { return "o instalador saiu com o codigo $codigo" }
            if (-not (Test-Path $exeDoApp)) { return "nao existe: $exeDoApp" }
            $versao = (Get-Item $exeDoApp).VersionInfo.ProductVersion
            if ($versao -ne $manifestoAnterior.versao) { "versao instalada: $versao" }
        }
        # Uma preferência que a pessoa mudou: não ser avisada de versão nova. Com ela, o app
        # também não consulta a rede durante a rodada.
        $preferencias = Join-Path $pastaDeDados 'preferencias.json'
        New-Item -ItemType Directory -Force $pastaDeDados | Out-Null
        Set-Content $preferencias '{"avisar_de_versao_nova": false}'
        Conferir 'a versao anterior abre a janela' {
            Start-Process -FilePath $exeDoApp
            if (-not (EsperarJanela)) { return 'a janela nao apareceu' }
            if (-not (AppAberto)) { 'o app nao criou a marca de aberto' }
        }
        Conferir 'atualizar a versao anterior com o app aberto: o instalador fecha o app, troca e reabre' {
            $antes = (ProcessosDoApp | Select-Object -First 1).Id
            if (-not $antes) { return 'o app nao estava aberto para a atualizacao' }
            $codigo = Rodar $instalador ($silencioso + @('/CLOSEAPPLICATIONS', '/REABRIR=1', "/LOG=$saida\atualizacao-da-anterior.log"))
            if ($codigo -ne 0) { return "o instalador saiu com o codigo $codigo" }
            if (-not (EsperarJanela)) { return 'o app nao voltou depois da atualizacao' }
            $depois = (ProcessosDoApp | Select-Object -First 1).Id
            if ($depois -eq $antes) { 'o processo e o mesmo de antes: o app nao foi fechado' }
        }
        Conferir 'depois de atualizar, o executavel e o registro estao na versao do pacote' {
            $versao = (Get-Item $exeDoApp).VersionInfo.ProductVersion
            if ($versao -ne $manifesto.versao) { return "versao instalada: $versao" }
            $registrada = (EntradaDeDesinstalacao 'HKCU:').GetValue('DisplayVersion')
            if ($registrada -ne $manifesto.versao) { return "versao no registro: $registrada" }
            if (@(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Where-Object { $_.GetValue('DisplayName') -eq 'awikabot' }).Count -ne 1) { 'ha mais de uma entrada de desinstalacao do app' }
        }
        Conferir 'depois de atualizar, as preferencias continuam as da pessoa' {
            if (-not (Test-Path $preferencias)) { return 'o arquivo de preferencias sumiu' }
            if ((Get-Content -Raw $preferencias | ConvertFrom-Json).avisar_de_versao_nova -ne $false) { 'a preferencia voltou ao valor de fabrica' }
        }
        FecharApp
        Conferir 'depois de atualizar, o app fecha pela janela' { if ((ProcessosDoApp).Count -gt 0 -or (AppAberto)) { 'o app continuou aberto' } }
        Conferir 'desinstalar em silencio depois de atualizar' {
            $codigo = RodarDesinstalador $silencioso
            if ($codigo -ne 0) { "o desinstalador saiu com o codigo $codigo" }
        }
        Conferir 'depois de atualizar e desinstalar, nao sobrou arquivo, atalho, registro nem pasta de dados' {
            if (Test-Path $pastaDoApp) { return "sobrou: " + ((Get-ChildItem -Recurse -Force $pastaDoApp | ForEach-Object { $_.Name }) -join ', ') }
            if (Test-Path $atalho) { return 'sobrou o atalho' }
            if (EntradaDeDesinstalacao 'HKCU:') { return 'sobrou a entrada de desinstalacao' }
            if (Test-Path $pastaDeDados) { return 'sobrou a pasta de dados' }
            if ((ProcessosDoApp).Count -gt 0) { 'ha processo do app rodando' }
        }
    }

    $aprovado = @($passos | Where-Object { -not $_.ok }).Count -eq 0
} catch {
    Registrar 'roteiro' $false "$_"
} finally {
    $eventos = @()
    if (-not $aprovado) {
        # O que o Windows registrou ajuda a entender um bloqueio ou uma queda do app.
        $eventos = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Level = 1, 2; StartTime = (Get-Date).AddMinutes(-30) } -MaxEvents 8 -ErrorAction SilentlyContinue |
            ForEach-Object { "$($_.ProviderName): " + ($_.Message -split "`n" | Select-Object -First 2) -join ' ' })
        $eventos += @(Get-WinEvent -LogName 'Microsoft-Windows-CodeIntegrity/Operational' -MaxEvents 6 -ErrorAction SilentlyContinue |
            ForEach-Object { "CodeIntegrity $($_.Id): " + ($_.Message -split "`n" | Select-Object -First 1) })
    }
    $resultado = [ordered]@{
        aprovado                = $aprovado
        smart_app_control       = $estadoDoSac
        smart_app_control_desligado_no_sandbox = [bool]$DesligarSmartAppControl
        marca_de_download       = [bool]$MarcaDeDownload
        sistema                 = (Get-CimInstance Win32_OperatingSystem).Caption + ' ' + (Get-CimInstance Win32_OperatingSystem).Version
        administrador           = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        passos                  = $passos
        eventos                 = $eventos
    }
    [IO.File]::WriteAllText((Join-Path $saida 'result.json'), ($resultado | ConvertTo-Json -Depth 5))
    Start-Sleep -Seconds 2
    Stop-Computer -Force
}
