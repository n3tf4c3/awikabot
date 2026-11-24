# Etapa 6 do roteiro de release: torna PUBLICO o rascunho conferido. Decisão do titular.
#
#   powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/aprovar.ps1 -Versao <x.y.z> -Ensaio
#   powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/aprovar.ps1 -Versao <x.y.z>
#
# Publicar não tem volta: cria a etiqueta, e no dia seguinte o app de quem já instalou avisa da
# versão nova. Não há como recolher uma versão de quem a instalou; o conserto é publicar outra,
# maior. Por isso a versão é escrita à mão em -Versao, e quem roda este script sem -Ensaio é o
# titular, nunca um agente.
#
# Antes de publicar, o script confere de novo, contra o GitHub de agora: o rascunho é o mesmo
# que a etapa 5 criou, aponta para o commit conferido, que está na `main`, e os arquivos dele,
# baixados de volta, são os que passaram pela conferência dos artefatos e pelo QA. Depois de
# publicar, confere que o release ficou público e que a etiqueta aponta para o commit, e grava
# `publicado.json` na pasta de evidências.
#
# Com -Ensaio, confere tudo e não publica.
param(
    [Parameter(Mandatory = $true)][string]$Versao,
    [switch]$Ensaio,
    # Só para o teste destes scripts: outro programa no lugar do gh, e outra pasta de evidências.
    [string]$Gh = 'gh',
    [string]$Evidencias
)
. (Join-Path $PSScriptRoot 'comum.ps1')

if ($Versao -notmatch '^\d+\.\d+\.\d+$') { throw 'a versao tem o formato x.y.z' }
$problemas = New-Object System.Collections.ArrayList
function Anotar($achados) { foreach ($problema in @($achados)) { if ($problema) { [void]$problemas.Add([string]$problema) } } }
function Parar([string]$motivo) {
    foreach ($problema in $problemas) { "RECUSADO  $problema" }
    throw "${motivo}: $($problemas.Count) problema(s)"
}

# A pasta de evidências da versão: a que tem o rascunho da etapa 5. Tem de ser uma só.
if (-not $Evidencias) {
    $raiz = Join-Path $script:RaizDoRepositorio 'relatorios\release'
    $candidatas = @(Get-ChildItem $raiz -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match "^$([regex]::Escape($Versao))-[0-9a-f]{7}$" -and (Test-Path (Join-Path $_.FullName 'rascunho.json')) })
    if ($candidatas.Count -eq 0) { throw "nenhum rascunho da versao $Versao nas evidencias; rode o publicar-rascunho.ps1 antes" }
    if ($candidatas.Count -gt 1) { throw "ha mais de um rascunho da versao $Versao nas evidencias; diga qual com -Evidencias" }
    $Evidencias = $candidatas[0].FullName
}
"evidencias: $Evidencias"
$registro = Read-Evidencia (Join-Path $Evidencias 'rascunho.json')
if (-not $registro -or -not $registro.aprovado) { throw 'falta a evidencia do rascunho (rascunho.json); rode o publicar-rascunho.ps1 antes' }
if ($registro.versao -ne $Versao) { throw "o rascunho das evidencias e da versao $($registro.versao), nao da $Versao" }
$commit = [string]$registro.commit

# As evidências das etapas anteriores continuam valendo para este commit e este instalador.
Anotar (Get-ProblemasDasEvidencias $Evidencias $Versao $commit)
$artefatos = Read-Evidencia (Join-Path $Evidencias 'artefatos.json')
if (-not (Test-CommitNaMain $commit)) { Anotar 'o commit do rascunho nao esta na main do repositorio' }

# O destino é o que o atualizador lê hoje, e a etiqueta é a que a etapa 5 registrou.
$destino = Get-DestinoDosReleases
$etiqueta = "$($destino.Prefixo)$Versao"
if ($registro.repositorio -ne $destino.Repositorio) { Anotar 'o rascunho foi criado em outro repositorio que nao o que o atualizador le' }
if ($registro.etiqueta -ne $etiqueta) { Anotar 'a etiqueta do rascunho nao e a que o atualizador procura' }

# O rascunho no GitHub de agora.
$releases = Get-Releases $Gh $destino.Repositorio
$comEstaEtiqueta = @($releases | Where-Object { $_.tag_name -eq $etiqueta })
$rascunho = $null
if ($comEstaEtiqueta.Count -ne 1) {
    Anotar "o GitHub lista $($comEstaEtiqueta.Count) releases com a etiqueta $etiqueta, e deveria listar um"
} else {
    $rascunho = $comEstaEtiqueta[0]
    if ($rascunho.id -ne $registro.id) { Anotar 'o release do GitHub nao e o rascunho que a etapa 5 criou' }
    if (-not $rascunho.draft) { Anotar 'o release ja nao esta em rascunho' }
    if ($rascunho.prerelease) { Anotar 'o rascunho esta marcado como pre-release: o atualizador nao o enxergaria' }
    if ($rascunho.target_commitish -ne $commit) { Anotar 'o rascunho nao aponta para o commit conferido' }
    $nomes = Get-NomesDosPublicados $Versao
    $subidos = @($rascunho.assets | ForEach-Object { $_.name })
    if ((($subidos | Sort-Object) -join '|') -ne (($nomes | Sort-Object) -join '|')) { Anotar 'o rascunho nao tem exatamente os tres arquivos do pacote' }
    if ($artefatos) {
        $baixados = New-PastaTemporaria 'aprovar'
        try {
            Invoke-Programa $Gh @('release', 'download', $etiqueta, '--repo', $destino.Repositorio, '--dir', $baixados) $script:RaizDoRepositorio | Out-Null
            Anotar (Get-ProblemasDosArquivos $baixados $artefatos $Versao 'no rascunho')
        } finally {
            Remove-Item -LiteralPath $baixados -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue
        }
    }
}
if (Get-CommitDaEtiqueta $Gh $destino.Repositorio $etiqueta) { Anotar "a etiqueta $etiqueta ja existe no repositorio" }
$maior = Get-MaiorVersaoPublica $releases $destino.Prefixo
if ($maior -and ([version]$Versao) -le $maior) { Anotar "a versao $Versao nao e maior que a ultima publica, ${maior}: o atualizador nao a ofereceria" }

"versao $Versao, commit $($commit.Substring(0, 7)), etiqueta $etiqueta, repositorio $($destino.Repositorio)"
if ($problemas.Count -gt 0) { Parar 'o rascunho nao pode ser publicado' }
"rascunho: $($rascunho.html_url)"
if ($Ensaio) { 'ENSAIO: tudo conferido; nada foi publicado'; return }

# Publica o release pelo número dele, que é o do rascunho conferido, e não pela etiqueta.
Invoke-Programa $Gh @('api', '--method', 'PATCH', "repos/$($destino.Repositorio)/releases/$($rascunho.id)", '-F', 'draft=false') $script:RaizDoRepositorio | Out-Null
"PUBLICADO: $etiqueta"

# Ficou como devia?
$publicado = @(Get-Releases $Gh $destino.Repositorio | Where-Object { $_.id -eq $rascunho.id }) | Select-Object -First 1
if (-not $publicado) { Anotar 'o GitHub nao lista mais o release' }
else {
    if ($publicado.draft) { Anotar 'o release continua em rascunho' }
    if ($publicado.prerelease) { Anotar 'o release saiu como pre-release' }
    if ($publicado.tag_name -ne $etiqueta) { Anotar 'o release saiu com outra etiqueta' }
}
$apontado = Get-CommitDaEtiqueta $Gh $destino.Repositorio $etiqueta
if (-not $apontado) { Anotar "a etiqueta $etiqueta nao foi criada" }
elseif ($apontado -ne $commit) { Anotar "a etiqueta $etiqueta aponta para outro commit: $apontado" }
if ($problemas.Count -gt 0) {
    'O RELEASE FOI PUBLICADO E NAO CONFERE: veja a pagina dele no GitHub agora'
    Parar 'o release publicado nao confere'
}

$evidencia = [ordered]@{
    aprovado    = $true
    versao      = $Versao
    commit      = $commit
    repositorio = $destino.Repositorio
    etiqueta    = $etiqueta
    id          = $publicado.id
    pagina      = $publicado.html_url
    quando      = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
}
Write-TextoSemBom (Join-Path $Evidencias 'publicado.json') ((($evidencia | ConvertTo-Json) -replace "`r`n", "`n") + "`n")
"evidencia: $(Join-Path $Evidencias 'publicado.json')"
"release publico: $($publicado.html_url)"
'falta conferir num app instalado: o aviso da versao nova aparece, o download passa na conferencia e a instalacao reabre o app na versao nova'
