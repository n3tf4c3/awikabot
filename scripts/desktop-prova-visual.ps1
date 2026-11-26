# Prova visual do app de desktop no Windows: abre o app de verdade contra um servidor local com o
# motor simulado e percorre o que só a tela mostra, gravando capturas da janela dele em cada passo:
# parear, criar um bot pelo formulário, aprovar e negar um pedido no cartão, parar uma resposta,
# receber o aviso do sistema com a janela minimizada, fechar e reabrir com a sessão que estava no
# cofre do sistema, no tema claro, e desparear.
#
#   pnpm server:build
#   cargo build -p awikabot-desktop      (em apps/desktop)
#   powershell -ExecutionPolicy Bypass -File scripts/desktop-prova-visual.ps1
#
# As teclas e os cliques vão por mensagem direto para a janela do app, nunca para a janela que
# estiver em foco, e a captura é só da janela dele. Os cliques são por coordenada, contadas para a
# janela no tamanho em que o app abre: mudou o desenho da tela, confira as coordenadas. As imagens
# ficam numa pasta temporária, cujo caminho o script imprime; a pasta de dados do servidor de teste
# é apagada no fim.
#
# O que a prova deixa no sistema e apaga no fim, se foi ela que criou: o item da sessão no
# Gerenciador de Credenciais (um item próprio desta execução, para não tocar na sessão de quem
# desenvolve), os avisos do app na central de notificações e o registro da identidade do build de
# desenvolvimento, que a GPUI grava ao mostrar o primeiro aviso. Durante a prova aparece um aviso
# de verdade na tela: é o que está sendo conferido.
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
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hwnd, int comando);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool PostMessageW(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@

$env:NODE_ENV = 'test'; $env:AWIKA_HOST = '127.0.0.1'; $env:AWIKA_PORTA = "$Porta"; $env:AWIKA_PORTA_GANCHO = "$($Porta + 1)"
$env:AWIKA_DADOS = $dados; $env:AWIKA_MOTOR = 'simulado'
$prova = "visual-" + (Get-Date -Format 'yyyyMMddHHmmss')
$env:AWIKA_COFRE_DE_PROVA = $prova
$itemNoCofre = "sessao.awikabot (prova $prova)"
# A identidade do build de desenvolvimento, como está em apps/desktop/crates/app/src/janela.rs.
$identidade = 'awikabot.desktop.desenvolvimento'
$registroDaIdentidade = "HKCU:\Software\Classes\AppUserModelId\$identidade"
$registroJaExistia = Test-Path $registroDaIdentidade
$base = "http://127.0.0.1:$Porta"
$servidor = Start-Process -FilePath 'node' -ArgumentList "`"$pacote`"" -PassThru -WindowStyle Hidden
$script:app = $null
$script:janela = [IntPtr]::Zero

function AbrirApp([string]$tema) {
    $env:AWIKA_TEMA = $tema
    $script:app = Start-Process -FilePath $exe -PassThru
    $script:janela = [IntPtr]::Zero
    # A primeira abertura depois de um build pode levar perto de dez segundos.
    for ($i = 0; $i -lt 120 -and $script:janela -eq [IntPtr]::Zero; $i++) {
        Start-Sleep -Milliseconds 250
        $script:app.Refresh()
        $script:janela = $script:app.MainWindowHandle
    }
    if ($script:janela -eq [IntPtr]::Zero) { throw 'a janela do app nao apareceu' }
    Start-Sleep -Milliseconds 1500
}
function FecharApp {
    if ($script:app -and -not $script:app.HasExited) { Stop-Process -Id $script:app.Id -Force -Confirm:$false }
    Start-Sleep -Milliseconds 700
}
function NoCofre { [bool](cmdkey /list | Select-String -SimpleMatch $itemNoCofre) }
function Digitar([string]$texto, [int]$pausaMs = 15) {
    foreach ($letra in $texto.ToCharArray()) {
        [JanelaDoApp]::PostMessageW($script:janela, 0x0102, [IntPtr][int]$letra, [IntPtr]1) | Out-Null
        if ($pausaMs -gt 0) { Start-Sleep -Milliseconds $pausaMs }
    }
    Start-Sleep -Milliseconds 300
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
# Os avisos do app que estão na central de notificações do Windows: o titulo e o texto de cada um.
function AvisosDoSistema {
    try {
        $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
        @([Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory($identidade) | ForEach-Object {
            ($_.Content.GetElementsByTagName('text') | ForEach-Object { $_.InnerText }) -join ' | '
        })
    } catch { @("nao foi possivel ler os avisos do sistema: $($_.Exception.Message)") }
}
function LimparAvisosDoSistema {
    try {
        $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
        [Windows.UI.Notifications.ToastNotificationManager]::History.Clear($identidade)
    } catch { }
}
# Um pedido ao servidor como outro aparelho faria. O corpo vai em UTF-8.
function Pedir([string]$metodo, [string]$caminho, $corpo, [string]$token) {
    $cabecalhos = @{ accept = 'application/json' }
    if ($token) { $cabecalhos.authorization = "Bearer $token" }
    $opcoes = @{ Method = $metodo; Uri = "$base$caminho"; Headers = $cabecalhos; TimeoutSec = 10 }
    if ($null -ne $corpo) {
        $opcoes.Body = [Text.Encoding]::UTF8.GetBytes(($corpo | ConvertTo-Json -Compress))
        $opcoes.ContentType = 'application/json'
    }
    Invoke-RestMethod @opcoes
}
function CodigoDePareamento {
    ((& node $pacote parear) -join ' ') -replace '.*?([A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}).*', '$1'
}

# Onde ficam os botões, na janela do tamanho em que o app abre (980 por 680).
$novoBot = @(124, 23)        # no alto da lateral
$aprovar = @(311, 251)       # no cartão de aprovação de uma conversa nova: uma mensagem de uma linha, a resposta e o cartão
$negar = @(383, 251)
$segundoBot = @(120, 115)    # a segunda linha da lista de bots
$parar = @(667, 640)         # no canto do cartão do compositor, no lugar do "Enviar", com o painel de detalhes aberto
$desparear = @(120, 657)     # no pé da lateral

try {
    $no_ar = $false
    for ($i = 0; $i -lt 40 -and -not $no_ar; $i++) {
        Start-Sleep -Milliseconds 250
        try { $no_ar = (Invoke-WebRequest -UseBasicParsing "$base/healthz" -TimeoutSec 2).StatusCode -eq 200 } catch { }
    }
    if (-not $no_ar) { throw "o servidor de teste nao subiu na porta $Porta" }

    # --- Parear -------------------------------------------------------------------
    AbrirApp 'escuro'
    Capturar '01-pareamento.png'
    Digitar $base
    Tecla 0x09                 # Tab
    Digitar (CodigoDePareamento)
    Capturar '02-preenchido.png'
    Tecla 0x0D                 # Enter
    Start-Sleep -Milliseconds 2500
    Capturar '03-pareado.png'

    # --- Bot criado pelo formulário --------------------------------------------------
    Clicar $novoBot[0] $novoBot[1]
    Start-Sleep -Milliseconds 800
    Digitar 'Scout'
    Tecla 0x09
    Tecla 0x09                 # nas instruções, Enter quebra a linha
    # Os acentos vão por código, para não depender de como o PowerShell lê este arquivo.
    $cedilha = [char]0xE7; $til = [char]0xE3; $agudo = [char]0xE1; $e_agudo = [char]0xE9; $o_til = [char]0xF5
    Digitar "Responda curto, em portugu$([char]0xEA)s."
    Tecla 0x0D
    Digitar "Antes de qualquer a$cedilha${til}o no servidor, explique o que vai fazer."
    Capturar '04-formulario.png'
    Tecla 0x09                 # de volta ao nome, onde Enter salva
    Tecla 0x0D
    Start-Sleep -Milliseconds 1500
    Capturar '05-bot-criado.png'

    # --- Cartão de aprovação: aprovar -------------------------------------------------
    Digitar '!comando ls -la /dados'
    Tecla 0x0D
    Start-Sleep -Milliseconds 1800
    Capturar '06-pedido-de-aprovacao.png'
    Clicar $aprovar[0] $aprovar[1]
    Start-Sleep -Milliseconds 2000
    Capturar '07-aprovado.png'

    # --- Mensagem longa no campo, resposta chegando e parar ---------------------------
    $frase = "Uma mensagem longa, com acentua$cedilha${til}o e v${agudo}rias palavras, para a resposta ainda estar chegando quando o bot${til}o de parar for apertado, at$e_agudo o fim. "
    Digitar ($frase * 14) 0
    Start-Sleep -Milliseconds 1500
    Capturar '08-mensagem-longa-no-campo.png'
    Tecla 0x0D
    Start-Sleep -Milliseconds 700
    Capturar '09-respondendo.png'
    Clicar $parar[0] $parar[1]
    Start-Sleep -Milliseconds 1500
    Capturar '10-resposta-parada.png'

    # --- Aviso do sistema com a janela minimizada --------------------------------------
    LimparAvisosDoSistema
    [JanelaDoApp]::ShowWindowAsync($script:janela, 6) | Out-Null      # minimizar
    Start-Sleep -Milliseconds 1200
    # Outro aparelho pareado manda o pedido que vai precisar de aprovação.
    $outro = Pedir 'POST' '/v1/parear' @{ codigo = (CodigoDePareamento); nome = 'Outro aparelho da prova' } $null
    # O pedido vai para um segundo bot, que nem está na tela: a conversa dele é nova, e o cartão cai no lugar conhecido.
    $bot = Pedir 'POST' '/v1/bots' @{ nome = 'Vigia' } $outro.token
    Pedir 'POST' "/v1/bots/$($bot.id)/turnos" @{ texto = '!comando cat /dados/segredo-da-prova.txt' } $outro.token | Out-Null
    Start-Sleep -Milliseconds 3000
    $avisos = AvisosDoSistema
    "avisos do sistema com a janela minimizada: $($avisos.Count)"
    $avisos | ForEach-Object { "  aviso: $_" }
    "algum aviso mostra o conteudo do pedido: $([bool]($avisos | Select-String -SimpleMatch 'segredo-da-prova'))"
    [JanelaDoApp]::ShowWindowAsync($script:janela, 9) | Out-Null      # restaurar
    Start-Sleep -Milliseconds 1800
    Capturar '11-de-volta-ao-app.png'
    Clicar $segundoBot[0] $segundoBot[1]
    Start-Sleep -Milliseconds 1500
    Capturar '11b-pedido-que-chegou-com-a-janela-minimizada.png'
    "avisos do sistema depois de voltar ao app: $(@(AvisosDoSistema).Count)"

    # --- Cartão de aprovação: negar -----------------------------------------------------
    Clicar $negar[0] $negar[1]
    Start-Sleep -Milliseconds 2000
    Capturar '12-negado.png'
    "pedidos ainda pendentes no servidor: $(@((Pedir 'GET' '/v1/aprovacoes' $null $outro.token).aprovacoes).Count)"
    "sessao no cofre do sistema depois de parear: $(NoCofre)"

    # --- Fechar e reabrir, agora no tema claro: a sessão volta do cofre -----------------
    FecharApp
    AbrirApp 'claro'
    Start-Sleep -Milliseconds 1500
    Capturar '13-reaberto-no-tema-claro.png'
    Clicar $novoBot[0] $novoBot[1]
    Start-Sleep -Milliseconds 800
    Capturar '14-formulario-no-tema-claro.png'
    Tecla 0x1B                 # Esc fecha o formulário
    Start-Sleep -Milliseconds 500
    Clicar $desparear[0] $desparear[1]
    Start-Sleep -Milliseconds 1200
    Capturar '15-despareado-no-tema-claro.png'
    "sessao no cofre do sistema depois de desparear: $(NoCofre)"
    "app vivo no fim: $(-not $script:app.HasExited)"
    "capturas em: $saida"
}
finally {
    FecharApp
    if ($servidor -and -not $servidor.HasExited) { Stop-Process -Id $servidor.Id -Force -Confirm:$false }
    Start-Sleep -Milliseconds 500
    # Só a pasta de dados que este script criou, dentro da pasta de saída dele.
    Remove-Item -Recurse -Force $dados -ErrorAction SilentlyContinue
    # E só o item que esta execução criou no cofre, se o desparear não chegou a apagá-lo.
    if (NoCofre) { cmdkey "/delete:$itemNoCofre" | Out-Null }
    # Os avisos do build de desenvolvimento, e o registro da identidade dele, se não existia antes.
    LimparAvisosDoSistema
    if (-not $registroJaExistia -and (Test-Path $registroDaIdentidade)) { Remove-Item -Recurse -Force $registroDaIdentidade -Confirm:$false }
    Remove-Item Env:AWIKA_HOST, Env:AWIKA_PORTA, Env:AWIKA_PORTA_GANCHO, Env:AWIKA_DADOS, Env:AWIKA_MOTOR, Env:NODE_ENV, Env:AWIKA_COFRE_DE_PROVA, Env:AWIKA_TEMA -ErrorAction SilentlyContinue
}
