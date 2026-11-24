# Conferências do candidato: tudo o que precisa passar no commit de onde um pacote vai sair.
#
#   powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/conferir-candidato.ps1
#   ... -PermitirMudancas      ensaio com mudanças sem commit; a evidência sai marcada e não vale para publicar
#
# Roda, nesta ordem: a suíte TypeScript, o runbook `pnpm verificar`, a auditoria das dependências
# do pnpm; rustfmt, clippy e os testes do workspace Cargo; o `cargo deny` (avisos de segurança e
# origem das dependências); a consulta à OSV; e a coleta das licenças de terceiros, que para se
# aparecer licença fora da lista das aceitas. Para na primeira que falhar.
#
# No fim grava a evidência, com o commit, em relatorios/release/<versão>-<commit>/candidato.json.
# A pasta relatorios/ fica fora do Git e fora de target/: uma limpeza de build não a apaga.
param(
    [switch]$PermitirMudancas
)
. (Join-Path $PSScriptRoot 'comum.ps1')

$versao = Get-VersaoDoApp
$origem = Get-Origem
if ($origem.ComMudancas -and -not $PermitirMudancas) {
    throw 'ha mudancas sem commit; um pacote so sai de um commit. Para ensaiar assim mesmo, use -PermitirMudancas'
}
"candidato: awikabot $versao, commit $($origem.Curto), mudancas sem commit: $($origem.ComMudancas)"

$raiz = $script:RaizDoRepositorio
$desktop = $script:PastaDoDesktop
$passos = New-Object System.Collections.ArrayList
function Passo([string]$nome, [string]$programa, [string[]]$argumentos, [string]$pasta) {
    $inicio = Get-Date
    "  $nome..."
    Invoke-Programa $programa $argumentos $pasta | Out-Null
    [void]$passos.Add([ordered]@{ passo = $nome; segundos = [int]((Get-Date) - $inicio).TotalSeconds })
}

Passo 'lint' 'pnpm' @('lint') $raiz
Passo 'build do servidor' 'pnpm' @('server:build') $raiz
Passo 'typecheck' 'pnpm' @('typecheck') $raiz
Passo 'testes TypeScript' 'pnpm' @('test') $raiz
Passo 'pnpm verificar' 'pnpm' @('verificar') $raiz
Passo 'auditoria das dependencias do pnpm' 'pnpm' @('audit') $raiz
Passo 'rustfmt' 'cargo' @('fmt', '--all', '--check') $desktop
Passo 'clippy' 'cargo' @('clippy', '--workspace', '--all-targets', '--locked', '--', '-D', 'warnings') $desktop
Passo 'testes do workspace Cargo' 'cargo' @('test', '--workspace', '--locked') $desktop
Passo 'cargo deny' 'cargo' @('deny', 'check', 'advisories', 'sources') $desktop
Passo 'consulta a OSV' 'node' @((Join-Path $desktop 'distribuicao\avisos-osv.mjs')) $raiz
$licencas = Join-Path $script:PastaDeBuild 'licencas-do-candidato.txt'
New-Item -ItemType Directory -Force $script:PastaDeBuild | Out-Null
Passo 'licencas de terceiros' 'node' @((Join-Path $desktop 'distribuicao\licencas-de-terceiros.mjs'), $licencas) $raiz
Remove-Item -LiteralPath $licencas -ErrorAction SilentlyContinue

$evidencias = Get-PastaDeEvidencias $versao $origem
$evidencia = [ordered]@{
    aprovado     = $true
    versao       = $versao
    commit       = $origem.Commit
    com_mudancas = $origem.ComMudancas
    quando       = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    passos       = $passos
}
Write-TextoSemBom (Join-Path $evidencias 'candidato.json') ((($evidencia | ConvertTo-Json -Depth 4) -replace "`r`n", "`n") + "`n")
"evidencia: $(Join-Path $evidencias 'candidato.json')"
if ($origem.ComMudancas) { 'ENSAIO: havia mudancas sem commit; esta evidencia nao vale para publicar' } else { 'candidato aprovado' }
