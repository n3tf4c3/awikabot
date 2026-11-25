# Teste dos scripts das etapas 5 e 6 do release (publicar-rascunho.ps1 e aprovar.ps1).
#
#   powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/testes/testar-publicacao.ps1
#
# Monta um pacote e as evidências de mentira numa pasta temporária, troca o `gh` por um que não
# fala com a rede (gh-de-mentira.ps1) e roda os dois scripts de verdade. Primeiro o caminho bom;
# depois, um defeito por vez, e o script tem de recusar por aquele motivo, sem criar o rascunho
# nem publicar. Nada toca o GitHub nem a pasta relatorios/. O que é de verdade é o Git: o commit
# do pacote de mentira é um commit da `main`, e a `main` do remoto é buscada.
. (Join-Path $PSScriptRoot '..\comum.ps1')

$publicar = Join-Path $PSScriptRoot '..\publicar-rascunho.ps1'
$aprovar = Join-Path $PSScriptRoot '..\aprovar.ps1'
$gh = Join-Path $PSScriptRoot 'gh-de-mentira.ps1'

Invoke-Programa 'git' @('fetch', '--quiet', 'origin', 'main') $script:RaizDoRepositorio | Out-Null
$commit = (Invoke-Programa 'git' @('merge-base', 'HEAD', 'origin/main') $script:RaizDoRepositorio | Select-Object -First 1).Trim()
$versao = Get-VersaoNoCommit $commit
$destino = Get-DestinoDosReleases
$etiqueta = "$($destino.Prefixo)$versao"
$nomes = Get-NomesDosPublicados $versao

function Gravar-Json([string]$arquivo, $valor) { Write-TextoSemBom $arquivo ((ConvertTo-Json -InputObject $valor -Depth 6) + "`n") }
function Mudar-Json([string]$arquivo, [scriptblock]$mudanca) {
    $valor = Get-Content -Raw $arquivo | ConvertFrom-Json
    & $mudanca $valor
    Gravar-Json $arquivo $valor
}

# Uma versão pública de mentira, menor que a do candidato, e o hash do instalador dela.
$versaoPublica = '0.0.1'
$hashDaPublica = 'a' * 64
if ([version]$versao -le [version]'0.0.2') { throw "o teste precisa de uma versao maior que 0.0.2, e o commit declara $versao" }

# Um candidato inteiro e sem defeito: pacote, evidências e um GitHub de mentira vazio. Com
# -ComVersaoPublica, o GitHub de mentira já tem uma versão pública, e o QA partiu dela.
$area = New-PastaTemporaria 'teste-publicacao'
$numero = 0
function Montar([switch]$ComVersaoPublica) {
    $script:numero++
    $base = Join-Path $area "caso-$script:numero"
    $caso = [pscustomobject]@{ Pacote = (Join-Path $base 'pacote'); Evidencias = (Join-Path $base 'evidencias'); Estado = (Join-Path $base 'gh') }
    New-Item -ItemType Directory -Force $caso.Pacote, $caso.Evidencias, $caso.Estado | Out-Null
    $instalador = Join-Path $caso.Pacote $nomes[0]
    Write-TextoSemBom $instalador "instalador de mentira $script:numero`n"
    $hash = Get-Sha256 $instalador
    Gravar-Json (Join-Path $caso.Pacote $nomes[1]) ([ordered]@{ versao = $versao; plataforma = 'windows-x64'; arquivo = $nomes[0]; tamanho = (Get-Item $instalador).Length; sha256 = $hash })
    Write-TextoSemBom (Join-Path $caso.Pacote $nomes[2]) "$hash  $($nomes[0])`n"
    Gravar-Json (Join-Path $caso.Pacote 'build-info.json') ([ordered]@{ versao = $versao; commit = $commit; com_mudancas = $false; assinado = $true })
    Gravar-Json (Join-Path $caso.Evidencias 'candidato.json') ([ordered]@{ aprovado = $true; versao = $versao; commit = $commit; com_mudancas = $false })
    # As evidências dos artefatos e do QA saem das mesmas funções que os scripts de verdade usam.
    Write-EvidenciaDosArtefatos $caso.Pacote $caso.Evidencias $versao $commit | Out-Null
    $manifesto = Get-Content -Raw (Join-Path $caso.Pacote $nomes[1]) | ConvertFrom-Json
    $informacoes = Get-Content -Raw (Join-Path $caso.Pacote 'build-info.json') | ConvertFrom-Json
    $resultado = [pscustomobject]@{ aprovado = $true; passos = @() }
    $partida = if ($ComVersaoPublica) { [ordered]@{ versao = $versaoPublica; instalador = "awikabot-$versaoPublica-windows-x64.exe"; sha256 = $hashDaPublica } } else { $null }
    foreach ($comRede in @($false, $true)) {
        $evidencia = New-EvidenciaDoQa $manifesto $informacoes $resultado $comRede $comRede $false $partida
        Write-TextoSemBom (Join-Path $caso.Evidencias $evidencia.Nome) $evidencia.Texto
    }
    Write-TextoSemBom (Join-Path $caso.Estado 'releases.json') '[]'
    Write-TextoSemBom (Join-Path $caso.Estado 'etiquetas.json') '[]'
    if ($ComVersaoPublica) { Tornar-Publica $caso $versaoPublica $hashDaPublica }
    return $caso
}

# Roda um dos scripts num processo próprio, com o gh de mentira, e devolve a saída e o código.
function Rodar([string]$roteiro, $caso, [string[]]$opcoes) {
    $env:AWIKA_GH_DE_MENTIRA = $caso.Estado
    $argumentos = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $roteiro, '-Gh', $gh, '-Evidencias', $caso.Evidencias) + $opcoes
    $anterior = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $saida = (& powershell.exe @argumentos 2>&1 | ForEach-Object { "$_" }) -join "`n"
    $codigo = $LASTEXITCODE
    $ErrorActionPreference = $anterior
    $chamadas = if (Test-Path (Join-Path $caso.Estado 'chamadas.log')) { (Get-Content (Join-Path $caso.Estado 'chamadas.log')) -join "`n" } else { '' }
    return [pscustomobject]@{ Codigo = $codigo; Saida = $saida; Chamadas = $chamadas }
}
function Publicar($caso, [string[]]$opcoes = @()) { return Rodar $publicar $caso (@('-Pacote', $caso.Pacote) + $opcoes) }
function Aprovar($caso, [string[]]$opcoes = @(), [string]$qual = $versao) { return Rodar $aprovar $caso (@('-Versao', $qual) + $opcoes) }

$falhas = New-Object System.Collections.ArrayList
$casos = 0
# Um caso passa se o código de saída, o texto e as chamadas ao gh são os esperados.
function Esperar([string]$nome, $resultado, [bool]$aprova, [string]$trecho, [string]$semChamada, [string]$comChamada) {
    $script:casos++
    $motivos = @()
    if (($resultado.Codigo -eq 0) -ne $aprova) { $motivos += "codigo de saida $($resultado.Codigo)" }
    if ($trecho -and $resultado.Saida.IndexOf($trecho, [StringComparison]::Ordinal) -lt 0) { $motivos += "a saida nao traz '$trecho'" }
    if ($semChamada -and $resultado.Chamadas.IndexOf($semChamada, [StringComparison]::Ordinal) -ge 0) { $motivos += "o gh recebeu '$semChamada'" }
    if ($comChamada -and $resultado.Chamadas.IndexOf($comChamada, [StringComparison]::Ordinal) -lt 0) { $motivos += "o gh nao recebeu '$comChamada'" }
    if ($motivos.Count -eq 0) { "PASSOU  $nome" }
    else {
        "FALHOU  ${nome}: $($motivos -join '; ')"
        ($resultado.Saida -split "`n" | Select-Object -Last 12) | ForEach-Object { "          $_" }
        [void]$falhas.Add($nome)
    }
}
# Um defeito plantado num candidato bom: o publicar tem de recusar por ele, sem criar rascunho.
function Recusa-Ao-Publicar([string]$nome, [string]$trecho, [scriptblock]$defeito, [switch]$ComVersaoPublica) {
    $caso = Montar -ComVersaoPublica:$ComVersaoPublica
    & $defeito $caso
    Esperar "publicar recusa: $nome" (Publicar $caso) $false $trecho 'release create' ''
}
# Um defeito plantado depois de um rascunho bom: o aprovar tem de recusar por ele, sem publicar.
function Recusa-Ao-Aprovar([string]$nome, [string]$trecho, [scriptblock]$defeito, [switch]$ComVersaoPublica) {
    $caso = Montar -ComVersaoPublica:$ComVersaoPublica
    $criado = Publicar $caso
    if ($criado.Codigo -ne 0) { Esperar "aprovar recusa: $nome (preparo)" $criado $true '' '' ''; return }
    & $defeito $caso
    Esperar "aprovar recusa: $nome" (Aprovar $caso) $false $trecho 'PATCH' ''
}
function Mudar-Releases($caso, [scriptblock]$mudanca) {
    $arquivo = Join-Path $caso.Estado 'releases.json'
    $lista = @(Get-Content -Raw $arquivo | ConvertFrom-Json | ForEach-Object { $_ })
    $lista = @(& $mudanca $lista)
    Write-TextoSemBom $arquivo (ConvertTo-Json -InputObject @($lista) -Depth 6)
}
function Um-Release([string]$tag, [bool]$rascunho) {
    return [pscustomobject]@{ id = 7; tag_name = $tag; draft = $rascunho; prerelease = $false; target_commitish = $commit; html_url = 'https://github.invalid/x'; assets = @() }
}
# Uma versão já pública no GitHub de mentira, com o manifesto do instalador dela entre os arquivos.
function Tornar-Publica($caso, [string]$qual, [string]$hash) {
    $tag = "$($destino.Prefixo)$qual"
    Mudar-Releases $caso { param($l) $l + (Um-Release $tag $false) }
    $guardados = Join-Path $caso.Estado "arquivos\$tag"
    New-Item -ItemType Directory -Force $guardados | Out-Null
    Gravar-Json (Join-Path $guardados $nomes[1]) ([ordered]@{ versao = $qual; plataforma = 'windows-x64'; arquivo = "awikabot-$qual-windows-x64.exe"; tamanho = 1; sha256 = $hash })
}

try {
    "commit de teste: $($commit.Substring(0, 7)); versao $versao; etiqueta $etiqueta"

    # --- publicar-rascunho.ps1 ---
    $caso = Montar
    Esperar 'publicar, ensaio: confere e nao envia' (Publicar $caso @('-Ensaio')) $true 'ENSAIO: tudo conferido' 'release create' ''
    $caso = Montar
    $resultado = Publicar $caso
    Esperar 'publicar: cria o rascunho e o confere' $resultado $true 'rascunho conferido' '' "release create $etiqueta --repo $($destino.Repositorio) --draft --target $commit"
    $script:casos++
    if (Test-Path (Join-Path $caso.Evidencias 'rascunho.json')) { 'PASSOU  publicar: grava a evidencia do rascunho' } else { 'FALHOU  publicar: grava a evidencia do rascunho'; [void]$falhas.Add('evidencia do rascunho') }
    # As notas: com acento inteiro (este arquivo e lido como ANSI, por isso o caractere vem pelo
    # codigo), com os dados do pacote e sem marcador por preencher.
    $script:casos++
    $arquivoDeNotas = Join-Path $caso.Evidencias 'notas-do-release.md'
    $notas = if (Test-Path $arquivoDeNotas) { [IO.File]::ReadAllText($arquivoDeNotas, [Text.Encoding]::UTF8) } else { '' }
    $hashDoInstalador = Get-Sha256 (Join-Path $caso.Pacote $nomes[0])
    if ($notas.Contains("vers$([char]0xE3)o $versao") -and $notas.Contains($hashDoInstalador) -and $notas.Contains($commit) -and -not $notas.Contains('{')) { 'PASSOU  publicar: as notas do release levam versao, hash e commit' }
    else { 'FALHOU  publicar: as notas do release levam versao, hash e commit'; [void]$falhas.Add('notas do release') }

    Recusa-Ao-Publicar 'pacote com mudancas sem commit' 'o pacote saiu de uma pasta com mudancas' { param($c) Mudar-Json (Join-Path $c.Pacote 'build-info.json') { param($v) $v.com_mudancas = $true } }
    Recusa-Ao-Publicar 'pacote sem assinatura' 'o pacote nao foi assinado' { param($c) Mudar-Json (Join-Path $c.Pacote 'build-info.json') { param($v) $v.assinado = $false } }
    Recusa-Ao-Publicar 'sem as conferencias do candidato' 'falta a evidencia das conferencias do candidato' { param($c) Remove-Item -LiteralPath (Join-Path $c.Evidencias 'candidato.json') }
    Recusa-Ao-Publicar 'conferencias de outro commit' 'as conferencias do candidato sao de outro commit' { param($c) Mudar-Json (Join-Path $c.Evidencias 'candidato.json') { param($v) $v.commit = '1' * 40 } }
    Recusa-Ao-Publicar 'conferencias feitas como ensaio' 'rodaram com mudancas sem commit' { param($c) Mudar-Json (Join-Path $c.Evidencias 'candidato.json') { param($v) $v.com_mudancas = $true } }
    Recusa-Ao-Publicar 'sem a conferencia dos artefatos' 'falta a evidencia da conferencia dos artefatos' { param($c) Remove-Item -LiteralPath (Join-Path $c.Evidencias 'artefatos.json') }
    Recusa-Ao-Publicar 'instalador trocado depois da conferencia' 'no pacote nao e o arquivo que foi conferido' { param($c) Add-Content -LiteralPath (Join-Path $c.Pacote $nomes[0]) -Value 'x' }
    Recusa-Ao-Publicar 'manifesto trocado depois da conferencia' "$($nomes[1]) no pacote nao e o arquivo que foi conferido" { param($c) Mudar-Json (Join-Path $c.Pacote $nomes[1]) { param($v) $v.tamanho = 1 } }
    Recusa-Ao-Publicar 'sem o QA com rede' 'falta o QA no Sandbox com rede' { param($c) Remove-Item -LiteralPath (Join-Path $c.Evidencias 'qa-sandbox-com-rede.json') }
    Recusa-Ao-Publicar 'QA sem rede reprovado' 'o QA no Sandbox sem rede reprovou' { param($c) Mudar-Json (Join-Path $c.Evidencias 'qa-sandbox-sem-rede.json') { param($v) $v.aprovado = $false } }
    Recusa-Ao-Publicar 'QA de outro instalador' 'o QA no Sandbox sem rede testou outro instalador' { param($c) Mudar-Json (Join-Path $c.Evidencias 'qa-sandbox-sem-rede.json') { param($v) $v.sha256 = '0' * 64 } }
    Recusa-Ao-Publicar 'QA com o Smart App Control desligado' 'com o Smart App Control desligado' { param($c) Mudar-Json (Join-Path $c.Evidencias 'qa-sandbox-com-rede.json') { param($v) $v.smart_app_control_desligado = $true } }
    Recusa-Ao-Publicar 'QA com rede sem a marca de download' 'sem a marca de download' { param($c) Mudar-Json (Join-Path $c.Evidencias 'qa-sandbox-com-rede.json') { param($v) $v.marca_de_download = $false } }
    Recusa-Ao-Publicar 'a mesma rodada de QA copiada duas vezes' 'e de outro tipo de rodada' { param($c) Copy-Item -LiteralPath (Join-Path $c.Evidencias 'qa-sandbox-sem-rede.json') -Destination (Join-Path $c.Evidencias 'qa-sandbox-com-rede.json') -Force }
    Recusa-Ao-Publicar 'commit fora da main' 'nao esta na main' { param($c) Mudar-Json (Join-Path $c.Pacote 'build-info.json') { param($v) $v.commit = '1' * 40 } }
    Recusa-Ao-Publicar 'versao que o commit nao declara' 'nao e a que o commit declara' { param($c)
        Mudar-Json (Join-Path $c.Pacote 'build-info.json') { param($v) $v.versao = '9.9.9' }
        Mudar-Json (Join-Path $c.Pacote $nomes[1]) { param($v) $v.versao = '9.9.9' } }
    Recusa-Ao-Publicar 'ja ha rascunho com a etiqueta' 'ja ha um rascunho com a etiqueta' { param($c) Mudar-Releases $c { param($l) $l + (Um-Release $etiqueta $true) } }
    Recusa-Ao-Publicar 'versao ja publica' 'ja ha um release publico com a etiqueta' { param($c) Mudar-Releases $c { param($l) $l + (Um-Release $etiqueta $false) } }
    Recusa-Ao-Publicar 'versao menor que a ultima publica' 'nao e maior que a ultima publica' { param($c) Mudar-Releases $c { param($l) $l + (Um-Release "$($destino.Prefixo)99.0.0" $false) } }
    Recusa-Ao-Publicar 'etiqueta ja existe' "a etiqueta $etiqueta ja existe" { param($c) Write-TextoSemBom (Join-Path $c.Estado 'etiquetas.json') "[{`"ref`":`"refs/tags/$etiqueta`",`"object`":{`"sha`":`"$commit`"}}]" }

    # Com uma versão já pública: as duas rodadas de QA têm de ter partido dela, do instalador publicado.
    $etiquetaDaPublica = "$($destino.Prefixo)$versaoPublica"
    $manifestoDaPublica = "arquivos\$etiquetaDaPublica\$($nomes[1])"
    $baixaDoManifesto = "release download $etiquetaDaPublica --repo $($destino.Repositorio) --pattern $($nomes[1])"
    $qaSemRede = 'qa-sandbox-sem-rede.json'
    $qaComRede = 'qa-sandbox-com-rede.json'
    $caso = Montar -ComVersaoPublica
    Esperar 'publicar, com versao publica, ensaio: confere de onde o QA partiu' (Publicar $caso @('-Ensaio')) $true 'ENSAIO: tudo conferido' 'release create' $baixaDoManifesto
    Esperar 'publicar, com versao publica: cria o rascunho' (Publicar $caso) $true 'rascunho conferido' '' "release create $etiqueta"
    Recusa-Ao-Publicar 'QA sem rede que nao partiu de versao nenhuma' "o QA no Sandbox sem rede nao partiu da ultima versao publica, $versaoPublica" { param($c) Mudar-Json (Join-Path $c.Evidencias $qaSemRede) { param($v) $v.anterior = $null } } -ComVersaoPublica
    Recusa-Ao-Publicar 'QA com rede que nao partiu de versao nenhuma' "o QA no Sandbox com rede nao partiu da ultima versao publica, $versaoPublica" { param($c) Mudar-Json (Join-Path $c.Evidencias $qaComRede) { param($v) $v.anterior = $null } } -ComVersaoPublica
    Recusa-Ao-Publicar 'evidencia de QA de antes de existir o campo' 'o QA no Sandbox sem rede nao partiu da ultima versao publica' { param($c) Mudar-Json (Join-Path $c.Evidencias $qaSemRede) { param($v) $v.PSObject.Properties.Remove('anterior') } } -ComVersaoPublica
    Recusa-Ao-Publicar 'QA sem rede que partiu de outra versao' "o QA no Sandbox sem rede partiu da versao 0.0.0, e a ultima publica e a $versaoPublica" { param($c) Mudar-Json (Join-Path $c.Evidencias $qaSemRede) { param($v) $v.anterior.versao = '0.0.0' } } -ComVersaoPublica
    Recusa-Ao-Publicar 'QA com rede que partiu de outra versao' "o QA no Sandbox com rede partiu da versao 0.0.0, e a ultima publica e a $versaoPublica" { param($c) Mudar-Json (Join-Path $c.Evidencias $qaComRede) { param($v) $v.anterior.versao = '0.0.0' } } -ComVersaoPublica
    Recusa-Ao-Publicar 'QA que partiu de outro instalador da mesma versao' "o QA no Sandbox com rede partiu de um instalador da $versaoPublica que nao e o publicado" { param($c) Mudar-Json (Join-Path $c.Evidencias $qaComRede) { param($v) $v.anterior.sha256 = '0' * 64 } } -ComVersaoPublica
    Recusa-Ao-Publicar 'versao publica sem manifesto que se leia' "nao deu para ler o manifesto da ultima versao publica, $versaoPublica" { param($c) Remove-Item -LiteralPath (Join-Path $c.Estado $manifestoDaPublica) } -ComVersaoPublica
    # Sem versão pública, nada muda: o QA que partiu de uma versão passa como o que não partiu.
    $caso = Montar -ComVersaoPublica
    Write-TextoSemBom (Join-Path $caso.Estado 'releases.json') '[]'
    Esperar 'publicar, sem versao publica: de onde o QA partiu nao e cobrado' (Publicar $caso @('-Ensaio')) $true 'ENSAIO: tudo conferido' 'release download' ''

    $caso = Montar
    New-Item -ItemType File (Join-Path $caso.Estado 'corromper-ao-subir') | Out-Null
    $resultado = Publicar $caso
    Esperar 'publicar: arquivo que chegou diferente ao GitHub e acusado' $resultado $false 'no rascunho nao e o arquivo que foi conferido' '' 'release create'
    $script:casos++
    if (-not (Test-Path (Join-Path $caso.Evidencias 'rascunho.json'))) { 'PASSOU  publicar: rascunho que nao confere nao deixa evidencia' } else { 'FALHOU  publicar: rascunho que nao confere nao deixa evidencia'; [void]$falhas.Add('evidencia de rascunho ruim') }

    # --- aprovar.ps1 ---
    $caso = Montar
    Publicar $caso | Out-Null
    Esperar 'aprovar, ensaio: confere e nao publica' (Aprovar $caso @('-Ensaio')) $true 'ENSAIO: tudo conferido' 'PATCH' ''
    $resultado = Aprovar $caso
    Esperar 'aprovar: publica o rascunho conferido' $resultado $true 'release publico' '' "api --method PATCH repos/$($destino.Repositorio)/releases/4242 -F draft=false"
    $script:casos++
    if (Test-Path (Join-Path $caso.Evidencias 'publicado.json')) { 'PASSOU  aprovar: grava a evidencia da publicacao' } else { 'FALHOU  aprovar: grava a evidencia da publicacao'; [void]$falhas.Add('evidencia da publicacao') }
    Esperar 'aprovar de novo: o que ja e publico nao se publica outra vez' (Aprovar $caso) $false 'ja nao esta em rascunho' '' ''

    $caso = Montar
    Esperar 'aprovar recusa: sem rascunho nas evidencias' (Aprovar $caso) $false 'falta a evidencia do rascunho' 'PATCH' ''
    $caso = Montar
    Publicar $caso | Out-Null
    Esperar 'aprovar recusa: versao escrita que nao e a do rascunho' (Aprovar $caso @() '9.9.9') $false 'nao da 9.9.9' 'PATCH' ''

    Recusa-Ao-Aprovar 'rascunho trocado por outro no GitHub' 'nao e o rascunho que a etapa 5 criou' { param($c) Mudar-Releases $c { param($l) $l | ForEach-Object { $_.id = 99; $_ } } }
    Recusa-Ao-Aprovar 'rascunho apontando para outro commit' 'nao aponta para o commit conferido' { param($c) Mudar-Releases $c { param($l) $l | ForEach-Object { $_.target_commitish = 'main'; $_ } } }
    Recusa-Ao-Aprovar 'rascunho marcado como pre-release' 'pre-release' { param($c) Mudar-Releases $c { param($l) $l | ForEach-Object { $_.prerelease = $true; $_ } } }
    Recusa-Ao-Aprovar 'arquivo trocado no rascunho' 'no rascunho nao e o arquivo que foi conferido' { param($c) Add-Content -LiteralPath (Join-Path $c.Estado "arquivos\$etiqueta\$($nomes[0])") -Value 'x' }
    Recusa-Ao-Aprovar 'arquivo a mais no rascunho' 'nao tem exatamente os tres arquivos' { param($c) Mudar-Releases $c { param($l) $l | ForEach-Object { $_.assets = @($_.assets) + [pscustomobject]@{ name = 'outro.exe' }; $_ } } }
    Recusa-Ao-Aprovar 'rascunho apagado' 'lista 0 releases' { param($c) Write-TextoSemBom (Join-Path $c.Estado 'releases.json') '[]' }
    Recusa-Ao-Aprovar 'QA reprovado depois do rascunho' 'o QA no Sandbox com rede reprovou' { param($c) Mudar-Json (Join-Path $c.Evidencias 'qa-sandbox-com-rede.json') { param($v) $v.aprovado = $false } }
    Recusa-Ao-Aprovar 'outra versao maior ja publica' 'nao e maior que a ultima publica' { param($c) Mudar-Releases $c { param($l) $l + (Um-Release "$($destino.Prefixo)99.0.0" $false) } }
    Recusa-Ao-Aprovar 'etiqueta criada por fora' "a etiqueta $etiqueta ja existe" { param($c) Write-TextoSemBom (Join-Path $c.Estado 'etiquetas.json') "[{`"ref`":`"refs/tags/$etiqueta`",`"object`":{`"sha`":`"$commit`"}}]" }

    # Com uma versão já pública: a aprovação confere de novo de onde o QA partiu, contra o GitHub de agora.
    $caso = Montar -ComVersaoPublica
    Publicar $caso | Out-Null
    Remove-Item -LiteralPath (Join-Path $caso.Estado 'chamadas.log')
    Esperar 'aprovar, com versao publica: confere de onde o QA partiu e publica' (Aprovar $caso) $true 'release publico' '' $baixaDoManifesto
    Recusa-Ao-Aprovar 'QA que deixou de dizer de onde partiu' "o QA no Sandbox com rede nao partiu da ultima versao publica, $versaoPublica" { param($c) Mudar-Json (Join-Path $c.Evidencias $qaComRede) { param($v) $v.anterior = $null } } -ComVersaoPublica
    Recusa-Ao-Aprovar 'outra versao, menor, publicada depois do rascunho' "o QA no Sandbox sem rede partiu da versao $versaoPublica, e a ultima publica e a 0.0.2" { param($c) Tornar-Publica $c '0.0.2' ('b' * 64) } -ComVersaoPublica
    Recusa-Ao-Aprovar 'instalador da versao publica trocado depois do rascunho' "partiu de um instalador da $versaoPublica que nao e o publicado" { param($c) Mudar-Json (Join-Path $c.Estado $manifestoDaPublica) { param($v) $v.sha256 = 'c' * 64 } } -ComVersaoPublica

    $caso = Montar
    Publicar $caso | Out-Null
    New-Item -ItemType File (Join-Path $caso.Estado 'etiqueta-errada') | Out-Null
    $resultado = Aprovar $caso
    Esperar 'aprovar: etiqueta que saiu em outro commit e acusada' $resultado $false 'aponta para outro commit' '' 'PATCH'
    $script:casos++
    if (-not (Test-Path (Join-Path $caso.Evidencias 'publicado.json'))) { 'PASSOU  aprovar: publicacao que nao confere nao deixa evidencia' } else { 'FALHOU  aprovar: publicacao que nao confere nao deixa evidencia'; [void]$falhas.Add('evidencia de publicacao ruim') }
} finally {
    Remove-Item Env:\AWIKA_GH_DE_MENTIRA -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $area -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue
}

if ($falhas.Count -gt 0) { throw "teste da publicacao: $($falhas.Count) de $casos casos falharam" }
"teste da publicacao: $casos de $casos casos passaram"
