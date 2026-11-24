# Etapa 5 do roteiro de release: sobe o pacote conferido como release em RASCUNHO no GitHub.
#
#   powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/publicar-rascunho.ps1 -Ensaio
#   powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/publicar-rascunho.ps1
#   ... -Pacote <pasta do pacote>      outro pacote que não o mais recente
#   ... -Notas <arquivo.md>            texto de quem publica, que vai antes dos dados do pacote
#
# Um rascunho não aparece para ninguém de fora nem para o atualizador, e não cria a etiqueta:
# é a etapa 6, `aprovar.ps1`, que o torna público. Mesmo assim, só sobe o que passou por tudo:
# pacote assinado, de um commit que está na `main`, com as conferências do candidato, a
# conferência dos artefatos e as duas rodadas de QA aprovadas para aquele commit e aquele
# instalador, e com os arquivos ainda iguais aos que foram conferidos. A versão tem de ser maior
# que a última pública, e a etiqueta não pode existir.
#
# Com -Ensaio, confere tudo, consulta o GitHub e não envia nada. O script lista todos os
# problemas que achar. Depois de criar o rascunho, baixa os arquivos de volta e os confere; só
# então grava `rascunho.json` na pasta de evidências, que é o que a etapa 6 exige.
#
# Usa o `gh` com a sessão de quem roda; nenhum token passa por aqui.
param(
    [string]$Pacote,
    [switch]$Ensaio,
    [string]$Notas,
    # Só para o teste destes scripts: outro programa no lugar do gh, e outra pasta de evidências.
    [string]$Gh = 'gh',
    [string]$Evidencias
)
. (Join-Path $PSScriptRoot 'comum.ps1')

$Pacote = Resolve-Pacote $Pacote
$problemas = New-Object System.Collections.ArrayList
function Anotar($achados) { foreach ($problema in @($achados)) { if ($problema) { [void]$problemas.Add([string]$problema) } } }
function Parar([string]$motivo) {
    foreach ($problema in $problemas) { "RECUSADO  $problema" }
    throw "${motivo}: $($problemas.Count) problema(s)"
}

"pacote: $Pacote"
$informacoes = Read-Evidencia (Join-Path $Pacote 'build-info.json')
$manifesto = Read-Evidencia (Join-Path $Pacote 'awikabot-desktop-windows-x64.json')
if (-not $informacoes) { Anotar 'falta ou nao se le o build-info.json do pacote' }
if (-not $manifesto) { Anotar 'falta ou nao se le o manifesto do pacote' }
if ($Notas -and -not (Test-Path $Notas)) { Anotar "o arquivo de notas nao existe: $Notas" }
if ($problemas.Count -gt 0) { Parar 'o pacote nao pode ser publicado' }

$versao = [string]$manifesto.versao
$commit = [string]$informacoes.commit
if ($versao -notmatch '^\d+\.\d+\.\d+$') { Anotar 'a versao do manifesto esta fora do formato x.y.z' }
if ($commit -notmatch '^[0-9a-f]{40}$') { Anotar 'o commit do build-info nao e um commit inteiro' }
if ($problemas.Count -gt 0) { Parar 'o pacote nao pode ser publicado' }

# O pacote.
if ($informacoes.com_mudancas) { Anotar 'o pacote saiu de uma pasta com mudancas sem commit' }
if (-not $informacoes.assinado) { Anotar 'o pacote nao foi assinado' }
if ($informacoes.versao -ne $versao) { Anotar 'a versao do manifesto nao e a do build-info' }

# As evidências das etapas 1, 3 e 4, e os arquivos de agora contra os que foram conferidos.
if (-not $Evidencias) { $Evidencias = Get-PastaDeEvidenciasDoPacote $informacoes }
Anotar (Get-ProblemasDasEvidencias $Evidencias $versao $commit)
$artefatos = Read-Evidencia (Join-Path $Evidencias 'artefatos.json')
if ($artefatos) { Anotar (Get-ProblemasDosArquivos $Pacote $artefatos $versao 'no pacote') }

# O commit: na `main` do repositório, e declarando esta versão.
if (Test-CommitNaMain $commit) {
    if ((Get-VersaoNoCommit $commit) -ne $versao) { Anotar 'a versao do pacote nao e a que o commit declara' }
} else {
    Anotar 'o commit do pacote nao esta na main do repositorio'
}

# O GitHub: a etiqueta é nova e a versão é maior que a última pública.
$destino = Get-DestinoDosReleases
$etiqueta = "$($destino.Prefixo)$versao"
$releases = Get-Releases $Gh $destino.Repositorio
$comEstaEtiqueta = @($releases | Where-Object { $_.tag_name -eq $etiqueta })
foreach ($release in $comEstaEtiqueta) {
    if ($release.draft) { Anotar "ja ha um rascunho com a etiqueta $etiqueta; apague-o no GitHub antes de publicar outro" }
    else { Anotar "ja ha um release publico com a etiqueta $etiqueta" }
}
if (Get-CommitDaEtiqueta $Gh $destino.Repositorio $etiqueta) { Anotar "a etiqueta $etiqueta ja existe no repositorio" }
$maior = Get-MaiorVersaoPublica $releases $destino.Prefixo
if ($maior -and ([version]$versao) -le $maior) { Anotar "a versao $versao nao e maior que a ultima publica, ${maior}: o atualizador nao a ofereceria" }

"versao $versao, commit $($commit.Substring(0, 7)), etiqueta $etiqueta, repositorio $($destino.Repositorio)"
"evidencias: $Evidencias"
if ($problemas.Count -gt 0) { Parar 'o pacote nao pode ser publicado' }
$nomes = Get-NomesDosPublicados $versao
foreach ($nome in $nomes) { "  $($artefatos.arquivos.PSObject.Properties[$nome].Value)  $nome" }
if ($Ensaio) { 'ENSAIO: tudo conferido; nada foi enviado ao GitHub'; return }

# As notas do release: o texto de quem publica, se houver, e os dados do pacote.
$modelo = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot 'notas-do-release.md')
$dados = $modelo.Replace('{versao}', $versao).Replace('{instalador}', $nomes[0]).Replace('{sha256}', $manifesto.sha256).Replace('{commit}', $commit)
$texto = if ($Notas) { (Get-Content -Raw -Encoding UTF8 $Notas).TrimEnd() + "`n`n" + $dados } else { $dados }
$arquivoDeNotas = Join-Path $Evidencias 'notas-do-release.md'
Write-TextoSemBom $arquivoDeNotas ($texto -replace "`r`n", "`n")

$argumentos = @('release', 'create', $etiqueta, '--repo', $destino.Repositorio, '--draft', '--target', $commit,
    '--title', "awikabot desktop $versao", '--notes-file', $arquivoDeNotas)
$argumentos += @($nomes | ForEach-Object { Join-Path $Pacote $_ })
Invoke-Programa $Gh $argumentos $script:RaizDoRepositorio | Out-Null
"rascunho criado: $etiqueta"

# O que subiu é o que foi conferido? Lê o rascunho de volta e baixa os arquivos.
$criados = @(Get-Releases $Gh $destino.Repositorio | Where-Object { $_.tag_name -eq $etiqueta })
if ($criados.Count -ne 1) {
    Anotar "o GitHub lista $($criados.Count) releases com a etiqueta $etiqueta, e deveria listar um"
} else {
    $rascunho = $criados[0]
    if (-not $rascunho.draft) { Anotar 'o release criado nao esta em rascunho' }
    if ($rascunho.target_commitish -ne $commit) { Anotar 'o rascunho nao aponta para o commit do pacote' }
    $subidos = @($rascunho.assets | ForEach-Object { $_.name })
    if ((($subidos | Sort-Object) -join '|') -ne (($nomes | Sort-Object) -join '|')) { Anotar 'o rascunho nao tem exatamente os tres arquivos do pacote' }
    $baixados = New-PastaTemporaria 'rascunho'
    try {
        Invoke-Programa $Gh @('release', 'download', $etiqueta, '--repo', $destino.Repositorio, '--dir', $baixados) $script:RaizDoRepositorio | Out-Null
        Anotar (Get-ProblemasDosArquivos $baixados $artefatos $versao 'no rascunho')
    } finally {
        Remove-Item -LiteralPath $baixados -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue
    }
}
if ($problemas.Count -gt 0) {
    'O RASCUNHO FOI CRIADO E NAO CONFERE: apague-o no GitHub antes de tentar de novo'
    Parar 'o rascunho nao confere com o pacote'
}

$evidencia = [ordered]@{
    aprovado    = $true
    versao      = $versao
    commit      = $commit
    repositorio = $destino.Repositorio
    etiqueta    = $etiqueta
    id          = $rascunho.id
    pagina      = $rascunho.html_url
    quando      = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
}
Write-TextoSemBom (Join-Path $Evidencias 'rascunho.json') ((($evidencia | ConvertTo-Json) -replace "`r`n", "`n") + "`n")
"evidencia: $(Join-Path $Evidencias 'rascunho.json')"
"rascunho conferido: $($rascunho.html_url)"
'ainda nao e publico: a etapa 6 (aprovar.ps1) e decisao do titular'
