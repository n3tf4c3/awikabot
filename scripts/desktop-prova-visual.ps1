# Prova visual do app de desktop no Windows: abre o app de verdade, leva-o do pareamento até uma
# conversa contra um servidor local com o motor simulado, fecha, reabre para ver a sessão voltar
# do cofre do sistema, despareia, e grava capturas da janela dele em cada passo.
#
#   pnpm server:build
#   cargo build -p awikabot-desktop      (em apps/desktop)
#   powershell -ExecutionPolicy Bypass -File scripts/desktop-prova-visual.ps1
#
# As teclas e os cliques vão por mensagem direto para a janela do app, nunca para a janela que
# estiver em foco, e a captura é só da janela dele. As imagens ficam numa pasta temporária, cujo
# caminho o script imprime; a pasta de dados do servidor de teste é apagada no fim.
#
# A sessão vai para um item próprio desta execução no Gerenciador de Credenciais, apagado no fim:
# a sessão de quem desenvolve não é tocada. Só o build de desenvolvimento aceita esse item à
# parte, e por isso a prova usa ele.
param(
    [int]$Porta = 8893
)
$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot
$pacote = Join-Path $raiz 'apps\server\dist\server.mjs'
$exe = Join-Path $raiz 'apps\desktop\target\debug\awikabot.exe'
foreach ($arquivo in @($pacote, $exe)) {
    if (-not (Test-Path $arquivo)) { throw "falta $arquivo; rode os dois builds do cabecalho deste script" }
}
$saida = Join-Path ([IO.Path]::GetTempPath()) ("awikabot-prova-visual-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$dados = Join-Path $saida 'dados-do-servidor'
New-Item -ItemType Directory -Force $dados | Out-Null

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class JanelaDoApp {
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool PostMessageW(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@

$env:NODE_ENV = 'test'; $env:AWIKA_HOST = '127.0.0.1'; $env:AWIKA_PORTA = "$Porta"; $env:AWIKA_PORTA_GANCHO = "$($Porta + 1)"
$env:AWIKA_DADOS = $dados; $env:AWIKA_MOTOR = 'simulado'
$prova = "visual-" + (Get-Date -Format 'yyyyMMddHHmmss')
$env:AWIKA_COFRE_DE_PROVA = $prova
$itemNoCofre = "sessao.awikabot (prova $prova)"
$base = "http://127.0.0.1:$Porta"
$servidor = Start-Process -FilePath 'node' -ArgumentList "`"$pacote`"" -PassThru -WindowStyle Hidden
$script:app = $null
$script:janela = [IntPtr]::Zero

function AbrirApp {
    $script:app = Start-Process -FilePath $exe -PassThru
    $script:janela = [IntPtr]::Zero
    for ($i = 0; $i -lt 40 -and $script:janela -eq [IntPtr]::Zero; $i++) {
        Start-Sleep -Milliseconds 250
        $script:app.Refresh()
        $script:janela = $script:app.MainWindowHandle
    }
    if ($script:janela -eq [IntPtr]::Zero) { throw 'a janela do app nao apareceu' }
    Start-Sleep -Milliseconds 1200
}
function FecharApp {
    if ($script:app -and -not $script:app.HasExited) { Stop-Process -Id $script:app.Id -Force -Confirm:$false }
    Start-Sleep -Milliseconds 700
}
function NoCofre { [bool](cmdkey /list | Select-String -SimpleMatch $itemNoCofre) }
function Digitar([string]$texto) {
    foreach ($letra in $texto.ToCharArray()) {
        [JanelaDoApp]::PostMessageW($script:janela, 0x0102, [IntPtr][int]$letra, [IntPtr]1) | Out-Null
        Start-Sleep -Milliseconds 15
    }
}
function Tecla([int]$codigoDaTecla) {
    [JanelaDoApp]::PostMessageW($script:janela, 0x0100, [IntPtr]$codigoDaTecla, [IntPtr]1) | Out-Null
    [JanelaDoApp]::PostMessageW($script:janela, 0x0101, [IntPtr]$codigoDaTecla, [IntPtr]0xC0000001) | Out-Null
    Start-Sleep -Milliseconds 120
}
function Clicar([int]$x, [int]$y) {
    $onde = [IntPtr](($y -shl 16) -bor $x)
    [JanelaDoApp]::PostMessageW($script:janela, 0x0200, [IntPtr]0, $onde) | Out-Null
    [JanelaDoApp]::PostMessageW($script:janela, 0x0201, [IntPtr]1, $onde) | Out-Null
    [JanelaDoApp]::PostMessageW($script:janela, 0x0202, [IntPtr]0, $onde) | Out-Null
    Start-Sleep -Milliseconds 400
}
function Capturar([string]$nome) {
    $r = New-Object JanelaDoApp+RECT
    [JanelaDoApp]::GetClientRect($script:janela, [ref]$r) | Out-Null
    $imagem = New-Object System.Drawing.Bitmap ($r.Right - $r.Left), ($r.Bottom - $r.Top)
    $desenho = [System.Drawing.Graphics]::FromImage($imagem)
    $hdc = $desenho.GetHdc(); [JanelaDoApp]::PrintWindow($script:janela, $hdc, 3) | Out-Null; $desenho.ReleaseHdc($hdc); $desenho.Dispose()
    $imagem.Save((Join-Path $saida $nome), [System.Drawing.Imaging.ImageFormat]::Png); $imagem.Dispose()
}

try {
    $no_ar = $false
    for ($i = 0; $i -lt 40 -and -not $no_ar; $i++) {
        Start-Sleep -Milliseconds 250
        try { $no_ar = (Invoke-WebRequest -UseBasicParsing "$base/healthz" -TimeoutSec 2).StatusCode -eq 200 } catch { }
    }
    if (-not $no_ar) { throw "o servidor de teste nao subiu na porta $Porta" }
    $codigo = ((& node $pacote parear) -join ' ') -replace '.*?([A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}).*', '$1'

    AbrirApp
    Capturar '1-pareamento.png'
    Digitar $base
    Tecla 0x09                 # Tab
    Digitar $codigo
    Capturar '2-preenchido.png'
    Tecla 0x0D                 # Enter
    Start-Sleep -Milliseconds 2500
    Capturar '3-pareado.png'
    Clicar 190 27              # botao "Novo bot", no alto da lateral
    Start-Sleep -Milliseconds 1500
    Clicar 500 650             # campo de mensagem
    # Os acentos vao por codigo, para nao depender de como o PowerShell le este arquivo.
    $cedilha = [char]0xE7; $til = [char]0xE3; $agudo = [char]0xE1
    Digitar "Uma mensagem de teste, com acentua$cedilha${til}o e v${agudo}rias palavras, longa o bastante para a resposta do bot ainda estar chegando quando a tela for capturada no meio do caminho, palavra por palavra, at$([char]0xE9) o fim"
    Tecla 0x0D
    Start-Sleep -Milliseconds 120
    Capturar '4-respondendo.png'
    Start-Sleep -Milliseconds 2500
    Capturar '5-conversa.png'
    "sessao no cofre do sistema depois de parear: $(NoCofre)"

    # Fecha e abre de novo: a sessao volta do cofre, sem passar pelo pareamento.
    FecharApp
    AbrirApp
    Start-Sleep -Milliseconds 1500
    Capturar '6-reaberto.png'
    Clicar 119 653             # botao "Desparear", no pe da lateral
    Start-Sleep -Milliseconds 1200
    Capturar '7-despareado.png'
    "sessao no cofre do sistema depois de desparear: $(NoCofre)"
    "app vivo no fim: $(-not $script:app.HasExited)"
    "capturas em: $saida"
}
finally {
    FecharApp
    if ($servidor -and -not $servidor.HasExited) { Stop-Process -Id $servidor.Id -Force -Confirm:$false }
    Start-Sleep -Milliseconds 500
    # So a pasta de dados que este script criou, dentro da pasta de saida dele.
    Remove-Item -Recurse -Force $dados -ErrorAction SilentlyContinue
    # E so o item que esta execucao criou no cofre, se o desparear nao chegou a apaga-lo.
    if (NoCofre) { cmdkey "/delete:$itemNoCofre" | Out-Null }
    Remove-Item Env:AWIKA_HOST, Env:AWIKA_PORTA, Env:AWIKA_PORTA_GANCHO, Env:AWIKA_DADOS, Env:AWIKA_MOTOR, Env:NODE_ENV, Env:AWIKA_COFRE_DE_PROVA -ErrorAction SilentlyContinue
}
