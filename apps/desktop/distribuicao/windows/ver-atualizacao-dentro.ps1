# Roda DENTRO do Windows Sandbox, chamado pelo ver-atualizacao.ps1. Nunca rodar no computador de
# trabalho: ele instala o app e desliga a máquina no fim.
#
# Instala a versão anterior, abre o app e fica anotando cada mudança do que está instalado: a
# versão do executável e a do registro, se o app está aberto, os pacotes que o atualizador
# baixou e as preferências. Guarda também capturas da janela: o aviso da versão nova, o pacote
# baixado e conferido, e o app reaberto. O que volta para fora é `partida.json`, uma vez,
# `historico.jsonl`, uma linha por mudança, `roteiro.jsonl`, uma linha por captura ou clique, e
# as capturas. Para quando aparece o arquivo `encerrar` na pasta de saída, ou no fim do prazo.
#
# Sem -Clicar, o painel de atualização é de quem está na frente do Sandbox. Com -Clicar, o
# roteiro clica em "Baixar" e em "Instalar e reabrir", por mensagens à janela, no lugar onde o
# botão do painel fica na tela de pareamento. Antes de cada clique ele olha a captura: só clica
# se houver ali uma faixa de botão, e só manda instalar quando a faixa é a do botão principal,
# o único colorido da tela. Enquanto o pacote é conferido, o botão dali é "Cancelar", cinza.
param(
    [int]$PrazoEmMinutos = 40,
    [switch]$Clicar,
    # Onde fica o meio do botão do painel, em pontos abaixo do meio da janela, na tela de
    # pareamento da versão anterior. Medido na captura da 0.1.0 e da 0.1.1, com a janela de
    # 980x680 em que o app abre: o botão vai de 497 a 527, e o meio da janela é 340. Mudou o
    # desenho dessa tela, mede-se de novo na captura `1-aviso.png` de uma rodada com -AteAConsulta.
    [int]$DeslocamentoDoBotao = 172
)
# Guarda: só roda na conta do Windows Sandbox. Chamado por engano noutro computador, para aqui,
# antes de instalar qualquer coisa e de chegar ao desligamento do fim. É a primeira instrução do
# roteiro, e o teste confere isso (Get-ProblemasDaGuardaDoSandbox, em comum.ps1).
if ($env:USERNAME -ne 'WDAGUtilityAccount') { throw 'este roteiro so roda dentro do Windows Sandbox: ele instala o app e desliga a maquina no fim' }
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
function Anotar([string]$oQue) {
    $linha = [ordered]@{ quando = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); o_que = $oQue }
    try { [IO.File]::AppendAllText((Join-Path $saida 'roteiro.jsonl'), (ConvertTo-Json -InputObject $linha -Compress) + "`n", $semBom) } catch { }
}

# --- A janela do app: captura, medida e clique ------------------------------------
# Se isto falhar, o roteiro segue sem capturas e sem cliques: o histórico é o que importa.
$comJanela = $true
try {
    Add-Type -AssemblyName System.Drawing
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class JanelaDoApp {
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr contexto);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool PostMessageW(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
    # As medidas da janela têm de vir nos pontos de verdade da tela, não nos de um processo que
    # não conhece a escala: é neles que a captura sai e que o clique chega.
    [JanelaDoApp]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
} catch { $comJanela = $false; Anotar "sem capturas nem cliques: $_" }

function Janela {
    $processo = Get-Process -Name awikabot -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $processo) { return [IntPtr]::Zero }
    $processo.Refresh()
    return $processo.MainWindowHandle
}
# A área de dentro da janela do app, como imagem. Nada, se não há janela.
function Fotografar {
    $janela = Janela
    if (-not $comJanela -or $janela -eq [IntPtr]::Zero) { return $null }
    $r = New-Object JanelaDoApp+RECT
    [JanelaDoApp]::GetClientRect($janela, [ref]$r) | Out-Null
    $largura = $r.Right - $r.Left
    $altura = $r.Bottom - $r.Top
    if ($largura -le 0 -or $altura -le 0) { return $null }
    $imagem = New-Object System.Drawing.Bitmap $largura, $altura
    $desenho = [System.Drawing.Graphics]::FromImage($imagem)
    $hdc = $desenho.GetHdc()
    [JanelaDoApp]::PrintWindow($janela, $hdc, 3) | Out-Null
    $desenho.ReleaseHdc($hdc)
    $desenho.Dispose()
    return $imagem
}
function Guardar($imagem, [string]$nome) {
    if (-not $imagem) { return }
    try { $imagem.Save((Join-Path $saida $nome), [System.Drawing.Imaging.ImageFormat]::Png); Anotar "captura $nome ($($imagem.Width)x$($imagem.Height))" } catch { Anotar "a captura $nome nao foi gravada: $_" }
}
# Onde o botão do painel fica na imagem: no meio da largura, e tantos pontos abaixo do meio da altura.
function LugarDoBotao($imagem) {
    $escala = [JanelaDoApp]::GetDpiForWindow((Janela)) / 96.0
    if ($escala -le 0) { $escala = 1.0 }
    return [pscustomobject]@{ X = [int]($imagem.Width / 2); Y = [int]($imagem.Height / 2 + $DeslocamentoDoBotao * $escala); Escala = $escala }
}
# O que há no lugar do botão: 'principal' (faixa colorida), 'comum' (faixa cinza, diferente do
# fundo da janela) ou 'nada'. A faixa é a largura da coluna do painel: quatro pontos dela, longe
# do rótulo, têm de ter a mesma cor. Os cinzas do app têm os três canais iguais; o botão
# principal é o único colorido.
function NoLugarDoBotao($imagem) {
    $lugar = LugarDoBotao $imagem
    if ($lugar.Y -lt 0 -or $lugar.Y -ge $imagem.Height) { return 'nada' }
    $cores = @()
    foreach ($desvio in -170, -90, 90, 170) {
        $x = [int]($lugar.X + $desvio * $lugar.Escala)
        if ($x -lt 0 -or $x -ge $imagem.Width) { return 'nada' }
        $cores += $imagem.GetPixel($x, $lugar.Y).ToArgb()
    }
    if (@($cores | Select-Object -Unique).Count -ne 1) { return 'nada' }
    $xDoFundo = [int]($lugar.X - 300 * $lugar.Escala)
    if ($xDoFundo -lt 0) { $xDoFundo = 0 }
    if ($cores[0] -eq $imagem.GetPixel($xDoFundo, $lugar.Y).ToArgb()) { return 'nada' }
    $cor = [System.Drawing.Color]::FromArgb($cores[0])
    $canais = @($cor.R, $cor.G, $cor.B) | Sort-Object
    if (($canais[2] - $canais[0]) -ge 48) { return 'principal' }
    return 'comum'
}
# Um clique no lugar do botão, por mensagens à janela; depois o mouse sai de cima, para o botão
# seguinte não ser desenhado como se o mouse estivesse sobre ele.
function ClicarNoBotao($imagem, [string]$qual) {
    $lugar = LugarDoBotao $imagem
    $janela = Janela
    $onde = [IntPtr](($lugar.Y -shl 16) -bor $lugar.X)
    [JanelaDoApp]::PostMessageW($janela, 0x0200, [IntPtr]0, $onde) | Out-Null
    [JanelaDoApp]::PostMessageW($janela, 0x0201, [IntPtr]1, $onde) | Out-Null
    [JanelaDoApp]::PostMessageW($janela, 0x0202, [IntPtr]0, $onde) | Out-Null
    Start-Sleep -Milliseconds 300
    [JanelaDoApp]::PostMessageW($janela, 0x0200, [IntPtr]0, [IntPtr]((4 -shl 16) -bor 4)) | Out-Null
    Anotar "clique em $qual, em ($($lugar.X), $($lugar.Y)) da janela de $($imagem.Width)x$($imagem.Height), escala $($lugar.Escala)"
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
                    if ((Janela) -ne [IntPtr]::Zero -and (AppAberto)) { $partida.janela = $true } else { Start-Sleep -Milliseconds 500 }
                }
                $partida.processo = ProcessoDoApp
            }
        }
    } catch { $partida.erro = "$_" }
    [IO.File]::WriteAllText((Join-Path $saida 'partida.json'), ($partida | ConvertTo-Json -Depth 4), $semBom)

    # --- Anotar cada mudança, até mandarem parar -----------------------------------
    # As fases do painel, vistas pelo disco: aviso (a consulta foi registrada), pacote (o
    # pacote chegou e é conferido), reabertura (o app saiu para o instalador) e fim.
    $historico = Join-Path $saida 'historico.jsonl'
    $ultimo = ''
    $fase = 'aviso'
    $cliques = 0
    $ultimoClique = Get-Date
    $pacoteVisto = $false
    $pacoteAnotado = $false
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
            $consultou = ($estado.preferencias -is [Collections.IDictionary]) -and $estado.preferencias.ultima_consulta_s
            $chegando = @($estado.pacotes | Where-Object { $_.nome -like '*.part' }).Count -gt 0
            $baixado = @($estado.pacotes | Where-Object { $_.nome -notlike '*.part' }).Count -gt 0
            $mesmoApp = $estado.app_aberto -and $estado.processo -eq $partida.processo

            # O aviso aparece junto com a consulta registrada: a captura vem antes de a linha
            # sair, para quem lê de fora só ver a consulta quando a imagem já existe.
            if ($fase -eq 'aviso' -and $consultou -and $mesmoApp) {
                Start-Sleep -Milliseconds 1200
                $imagem = Fotografar
                if ($imagem) {
                    Guardar $imagem '1-aviso.png'
                    $noLugar = NoLugarDoBotao $imagem
                    Anotar "no lugar do botao, depois da consulta: $noLugar"
                    if ($Clicar -and $noLugar -eq 'comum') { ClicarNoBotao $imagem 'Baixar'; $cliques = 1; $ultimoClique = Get-Date }
                    elseif ($Clicar) { Anotar 'nao ha botao de baixar onde o roteiro esperava: o clique fica para uma pessoa' }
                    $imagem.Dispose()
                }
                $fase = 'pacote'
            }
            elseif ($fase -eq 'pacote' -and $mesmoApp) {
                if ($baixado) { $pacoteVisto = $true }
                $imagem = Fotografar
                if ($imagem) {
                    $noLugar = NoLugarDoBotao $imagem
                    if ($baixado) {
                        # A última captura com o pacote no disco e o app aberto é a do pacote conferido.
                        try { $imagem.Save((Join-Path $saida '2-pacote.png'), [System.Drawing.Imaging.ImageFormat]::Png) } catch { }
                        if (-not $pacoteAnotado) { Anotar "captura 2-pacote.png, refeita ate o app sair; no lugar do botao: $noLugar"; $pacoteAnotado = $true }
                        $espera = ((Get-Date) - $ultimoClique).TotalSeconds
                        if ($Clicar -and $noLugar -eq 'principal' -and ($cliques -eq 1 -or ($cliques -lt 4 -and $espera -ge 20))) {
                            ClicarNoBotao $imagem 'Instalar e reabrir'; $cliques++; $ultimoClique = Get-Date
                        }
                    }
                    elseif ($Clicar -and $cliques -eq 1 -and -not $chegando -and $noLugar -eq 'comum' -and ((Get-Date) - $ultimoClique).TotalSeconds -ge 60) {
                        # Um minuto sem nada chegar e o botão continua ali: o primeiro clique não pegou.
                        Anotar 'nada chegou em um minuto: outro clique em Baixar'
                        ClicarNoBotao $imagem 'Baixar'; $ultimoClique = Get-Date
                    }
                    $imagem.Dispose()
                }
            }
            if ($fase -eq 'pacote' -and $pacoteVisto -and -not $mesmoApp) { Anotar 'o app saiu para o instalador'; $fase = 'reabertura' }
            elseif ($fase -eq 'reabertura' -and $estado.app_aberto -and $estado.processo -and $estado.processo -ne $partida.processo) {
                Start-Sleep -Milliseconds 1500
                Guardar (Fotografar) '3-reaberto.png'
                $fase = 'fim'
            }

            $texto = ConvertTo-Json -InputObject $estado -Compress -Depth 5
            if ($texto -ne $ultimo) {
                $linha = '{"quando":"' + (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') + '","estado":' + $texto + '}'
                [IO.File]::AppendAllText($historico, $linha + "`n", $semBom)
                $ultimo = $texto
            }
        } catch { Anotar "volta com erro: $_" }
        Start-Sleep -Seconds 1
    }
} finally {
    Start-Sleep -Seconds 1
    Stop-Computer -Force
}
