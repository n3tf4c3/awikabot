# Roda DENTRO do Windows Sandbox, chamado pelo ver-atualizacao.ps1. Nunca rodar no computador de
# trabalho: ele instala o app e desliga a máquina no fim.
#
# Instala a versão anterior, abre o app e fica anotando cada mudança do que está instalado: a
# versão do executável e a do registro, se o app está aberto, os pacotes que o atualizador
# baixou e as preferências. Não clica em nada: o painel de atualização é de quem está na frente
# do Sandbox. O que volta para fora é `partida.json`, uma vez, e `historico.jsonl`, uma linha por
# mudança. Para quando aparece o arquivo `encerrar` na pasta de saída, ou no fim do prazo.
param(
    [int]$PrazoEmMinutos = 40
)
$ErrorActionPreference = 'Stop'
$entrada = 'C:\ver\entrada'
$saida = 'C:\ver\saida'
$trabalho = 'C:\ver\trabalho'
$identidade = 'awikabot.desktop'
$exeDoApp = Join-Path $env:LOCALAPPDATA 'Programs\awikabot\awikabot.exe'
$pastaDeDados = Join-Path $env:LOCALAPPDATA 'awikabot'
$semBom = New-Object Text.UTF8Encoding $false
$fim = (Get-Date).AddMinutes($PrazoEmMinutos)
$hashes = @{}

function ProcessoDoApp { (Get-Process -Name awikabot -ErrorAction SilentlyContinue | Select-Object -First 1).Id }
function AppAberto {
    try { [Threading.Mutex]::OpenExisting($identidade).Dispose(); return $true } catch { return $false }
}
function VersaoDoExecutavel {
    if (-not (Test-Path $exeDoApp)) { return $null }
    # No meio da troca o arquivo existe e ainda não se deixa ler.
    try { return (Get-Item $exeDoApp).VersionInfo.ProductVersion } catch { return 'em troca' }
}
function VersaoNoRegistro {
    $chave = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
        Where-Object { $_.GetValue('DisplayName') -eq 'awikabot' } | Select-Object -First 1
    if ($chave) { return $chave.GetValue('DisplayVersion') }
    return $null
}
# Os pacotes na pasta do atualizador. O que ainda está chegando (.part) vai só pelo nome; o que
# já tem o nome final vai com tamanho e SHA-256, calculado uma vez por arquivo.
function Pacotes {
    $lista = @()
    foreach ($arquivo in @(Get-ChildItem (Join-Path $pastaDeDados 'atualizacoes') -File -ErrorAction SilentlyContinue | Sort-Object Name)) {
        if ($arquivo.Extension -eq '.part') { $lista += [ordered]@{ nome = $arquivo.Name; tamanho = $null; sha256 = $null }; continue }
        $chave = "$($arquivo.Name)|$($arquivo.Length)|$($arquivo.LastWriteTimeUtc.Ticks)"
        if (-not $hashes.ContainsKey($chave)) {
            try { $hashes[$chave] = (Get-FileHash -Algorithm SHA256 -LiteralPath $arquivo.FullName).Hash.ToLowerInvariant() } catch { }
        }
        $lista += [ordered]@{ nome = $arquivo.Name; tamanho = $arquivo.Length; sha256 = $hashes[$chave] }
    }
    return $lista
}
function Preferencias {
    $arquivo = Join-Path $pastaDeDados 'preferencias.json'
    if (-not (Test-Path $arquivo)) { return $null }
    try {
        $lidas = Get-Content -Raw $arquivo | ConvertFrom-Json
        return [ordered]@{ avisar_de_versao_nova = $lidas.avisar_de_versao_nova; ultima_consulta_s = $lidas.ultima_consulta_s }
    } catch { return 'ilegivel' }
}

try {
    # --- Instalar a versão anterior e abrir o app ---------------------------------
    $partida = [ordered]@{
        instalador_conferido = $false
        codigo_do_instalador = $null
        versao_instalada     = $null
        janela               = $false
        processo             = $null
        smart_app_control    = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -ErrorAction SilentlyContinue).VerifiedAndReputablePolicyState
        sistema              = (Get-CimInstance Win32_OperatingSystem).Caption + ' ' + (Get-CimInstance Win32_OperatingSystem).Version
        erro                 = $null
    }
    try {
        New-Item -ItemType Directory -Force $trabalho | Out-Null
        $manifesto = Get-Content -Raw (Join-Path $entrada 'awikabot-desktop-windows-x64.json') | ConvertFrom-Json
        $instalador = Join-Path $trabalho $manifesto.arquivo
        Copy-Item (Join-Path $entrada $manifesto.arquivo) $instalador
        $hash = (Get-FileHash -Algorithm SHA256 $instalador).Hash.ToLowerInvariant()
        $partida.instalador_conferido = ($hash -eq $manifesto.sha256 -and (Get-Item $instalador).Length -eq $manifesto.tamanho)
        if ($partida.instalador_conferido) {
            $processo = Start-Process -FilePath $instalador -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/LOG=$saida\instalacao.log" -PassThru
            if (-not $processo.WaitForExit(180000)) { $processo.Kill(); throw 'o instalador nao terminou em 180 s' }
            $partida.codigo_do_instalador = $processo.ExitCode
            $partida.versao_instalada = VersaoDoExecutavel
            if ($processo.ExitCode -eq 0 -and (Test-Path $exeDoApp)) {
                Start-Process -FilePath $exeDoApp
                $prazoDaJanela = (Get-Date).AddSeconds(90)
                while (-not $partida.janela -and (Get-Date) -lt $prazoDaJanela) {
                    $comJanela = Get-Process -Name awikabot -ErrorAction SilentlyContinue | Where-Object { $_.Refresh(); $_.MainWindowHandle -ne [IntPtr]::Zero }
                    if ($comJanela -and (AppAberto)) { $partida.janela = $true } else { Start-Sleep -Milliseconds 500 }
                }
                $partida.processo = ProcessoDoApp
            }
        }
    } catch { $partida.erro = "$_" }
    [IO.File]::WriteAllText((Join-Path $saida 'partida.json'), ($partida | ConvertTo-Json -Depth 4), $semBom)

    # --- Anotar cada mudança, até mandarem parar -----------------------------------
    $historico = Join-Path $saida 'historico.jsonl'
    $ultimo = ''
    while ((Get-Date) -lt $fim -and -not (Test-Path (Join-Path $saida 'encerrar'))) {
        # Uma leitura ou gravação que falhe deixa a mudança por anotar: a próxima volta tenta de novo.
        try {
            $estado = [ordered]@{
                versao_do_executavel = VersaoDoExecutavel
                versao_no_registro   = VersaoNoRegistro
                app_aberto           = AppAberto
                processo             = ProcessoDoApp
                instalador_rodando   = [bool](Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'awikabot-*' })
                pacotes              = @(Pacotes)
                preferencias         = Preferencias
            }
            $texto = ConvertTo-Json -InputObject $estado -Compress -Depth 5
            if ($texto -ne $ultimo) {
                $linha = '{"quando":"' + (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') + '","estado":' + $texto + '}'
                [IO.File]::AppendAllText($historico, $linha + "`n", $semBom)
                $ultimo = $texto
            }
        } catch { }
        Start-Sleep -Seconds 1
    }
} finally {
    Start-Sleep -Seconds 1
    Stop-Computer -Force
}
