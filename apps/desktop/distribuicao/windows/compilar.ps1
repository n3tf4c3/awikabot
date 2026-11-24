# Compila o executável que vai ser distribuído e confere o que saiu.
#
#   powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/compilar.ps1
#
# O que este build tem de diferente do `cargo build --release` comum: os caminhos desta máquina
# (pasta do Cargo, do rustup e do repositório) são trocados por nomes neutros, para o executável
# público não levar o nome de usuário de quem compilou. O runtime do C++ vai embutido, como em
# todo build do app.
#
# O executável sai numa pasta nova, com um `build-info.json` ao lado. Nada é sobrescrito: se a
# pasta daquela versão e daquele commit já existe, o script para. Ele confere antes de entregar:
# a versão gravada no executável é a do `Cargo.toml`; o executável não pede o runtime do C++; e
# nenhum caminho desta máquina ficou dentro dele.
param(
    # Onde criar a pasta do pacote. O padrão fica dentro de target/, fora do Git.
    [string]$Saida
)
. (Join-Path $PSScriptRoot 'comum.ps1')

$versao = Get-VersaoDoApp
$origem = Get-Origem
if (-not $Saida) { $Saida = Join-Path $script:PastaDeBuild 'pacotes' }
$sufixo = if ($origem.ComMudancas) { '-com-mudancas' } else { '' }
$pasta = Join-Path $Saida "$versao-$($origem.Curto)$sufixo"
if (Test-Path $pasta) { throw "a pasta $pasta ja existe; apague-a ou gere o pacote de outro commit" }

$caminhos = Get-CaminhosDaMaquina
$opcoes = @('-C', 'target-feature=+crt-static')
foreach ($caminho in $caminhos) { $opcoes += "--remap-path-prefix=$($caminho.De)=$($caminho.Para)" }
# Separadas por este caractere, as opções podem ter espaço no caminho.
$env:CARGO_ENCODED_RUSTFLAGS = $opcoes -join [char]0x1f
$env:CARGO_TARGET_DIR = $script:PastaDeBuild
try {
    "compilando o awikabot $versao a partir de $($origem.Curto)..."
    $eventos = Invoke-Programa 'cargo' @('build', '--release', '--locked', '-p', 'awikabot-desktop', '--message-format=json')
} finally {
    Remove-Item Env:CARGO_ENCODED_RUSTFLAGS, Env:CARGO_TARGET_DIR -ErrorAction SilentlyContinue
}

# O executável é o que o Cargo diz que gerou, não um caminho presumido.
$executavel = $null
foreach ($linha in $eventos) {
    if ($linha -notlike '{*') { continue }
    $evento = $linha | ConvertFrom-Json
    if ($evento.reason -eq 'compiler-artifact' -and $evento.target.name -eq 'awikabot' -and $evento.executable) { $executavel = $evento.executable }
}
if (-not $executavel -or -not (Test-Path $executavel)) { throw 'o Cargo nao informou o executavel gerado' }

$gravada = (Get-Item $executavel).VersionInfo
if ($gravada.ProductVersion -ne $versao -or $gravada.FileVersion -ne $versao) {
    throw "a versao gravada no executavel ($($gravada.ProductVersion)) nao e a do Cargo.toml ($versao)"
}
if ($gravada.ProductName -ne 'awikabot') { throw 'o executavel saiu sem o nome do produto' }

$bytes = [IO.File]::ReadAllBytes($executavel)
foreach ($biblioteca in @('VCRUNTIME140', 'MSVCP140', 'api-ms-win-crt')) {
    if (Test-TextoNoArquivo $bytes $biblioteca) { throw "o executavel pede o runtime do C++ ($biblioteca)" }
}
$daMaquina = @($caminhos | ForEach-Object { $_.De }) + @($env:USERPROFILE)
foreach ($caminho in $daMaquina) {
    if (Test-TextoNoArquivo $bytes $caminho) { throw "um caminho desta maquina ficou dentro do executavel: $caminho" }
    # O compilador também grava caminhos com a barra para a frente.
    if (Test-TextoNoArquivo $bytes ($caminho -replace '\\', '/')) { throw "um caminho desta maquina ficou dentro do executavel: $caminho" }
}

New-Item -ItemType Directory -Force $pasta | Out-Null
$destino = Join-Path $pasta 'awikabot.exe'
Copy-Item -LiteralPath $executavel -Destination $destino
$informacoes = [ordered]@{
    versao       = $versao
    commit       = $origem.Commit
    com_mudancas = $origem.ComMudancas
    executavel   = 'awikabot.exe'
    tamanho      = (Get-Item $destino).Length
    sha256       = Get-Sha256 $destino
    assinado     = $false
}
# Sem BOM e com fim de linha simples, para o hash do arquivo ser o mesmo em qualquer máquina.
[IO.File]::WriteAllText((Join-Path $pasta 'build-info.json'), (($informacoes | ConvertTo-Json) -replace "`r`n", "`n") + "`n")

"executavel: $destino"
"versao: $versao; commit: $($origem.Curto); mudancas sem commit: $($origem.ComMudancas)"
"tamanho: $($informacoes.tamanho) bytes; sha256: $($informacoes.sha256)"
"conferido: versao gravada, sem runtime do C++, sem caminhos desta maquina"
