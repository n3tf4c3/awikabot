# Um `gh` de mentira para os testes dos scripts de release: guarda releases, etiquetas e
# arquivos numa pasta, e nunca fala com a rede. Só responde aos pedidos que os scripts fazem.
#
# A pasta vem em AWIKA_GH_DE_MENTIRA. Um arquivo vazio com um destes nomes, nela, planta um defeito:
#   corromper-ao-subir   o instalador guardado sai diferente do enviado
#   etiqueta-errada      ao publicar, a etiqueta aponta para outro commit
$ErrorActionPreference = 'Stop'
$estado = $env:AWIKA_GH_DE_MENTIRA
if (-not $estado -or -not (Test-Path $estado)) { [Console]::Error.WriteLine('gh de mentira: falta a pasta de estado'); exit 2 }
Add-Content -LiteralPath (Join-Path $estado 'chamadas.log') -Value ($args -join ' ') -Encoding UTF8

$arquivoDosReleases = Join-Path $estado 'releases.json'
$arquivoDasEtiquetas = Join-Path $estado 'etiquetas.json'
function Ler-Lista([string]$arquivo) { return @(Get-Content -Raw $arquivo | ConvertFrom-Json | ForEach-Object { $_ }) }
function Gravar-Lista([string]$arquivo, $lista) {
    [IO.File]::WriteAllText($arquivo, (ConvertTo-Json -InputObject @($lista) -Depth 6), (New-Object Text.UTF8Encoding $false))
}
# O valor que vem depois de uma opção, na linha de comando recebida.
function Opcao([string[]]$linha, [string]$nome) {
    $posicao = [array]::IndexOf($linha, $nome)
    if ($posicao -lt 0 -or $posicao + 1 -ge $linha.Count) { return $null }
    return $linha[$posicao + 1]
}
$linha = [string[]]$args

# A lista de releases sai em páginas, como no GitHub: `per_page` diz quantos e `page`, qual página.
if ($linha[0] -eq 'api' -and $linha[1] -match '^repos/[^/]+/[^/]+/releases\?per_page=(\d+)&page=([1-9]\d*)$') {
    $porPagina = [int]$Matches[1]
    $pagina = [int]$Matches[2]
    $daPagina = @(@(Ler-Lista $arquivoDosReleases) | Select-Object -Skip (($pagina - 1) * $porPagina) -First $porPagina)
    ConvertTo-Json -InputObject @($daPagina) -Depth 6
    exit 0
}
if ($linha[0] -eq 'api' -and $linha[1] -match '^repos/[^/]+/[^/]+/git/matching-refs/tags/(.+)$') {
    $pedida = $Matches[1]
    $achadas = @(Ler-Lista $arquivoDasEtiquetas | Where-Object { $_.ref -like "refs/tags/$pedida*" })
    ConvertTo-Json -InputObject @($achadas) -Depth 4
    exit 0
}
if ($linha[0] -eq 'api' -and $linha[1] -eq '--method' -and $linha[2] -eq 'PATCH' -and $linha[3] -match '^repos/[^/]+/[^/]+/releases/(\d+)$' -and $linha[4] -eq '-F' -and $linha[5] -eq 'draft=false') {
    $id = [int]$Matches[1]
    $releases = Ler-Lista $arquivoDosReleases
    $release = $releases | Where-Object { $_.id -eq $id } | Select-Object -First 1
    if (-not $release) { [Console]::Error.WriteLine('gh de mentira: release desconhecido'); exit 1 }
    $release.draft = $false
    Gravar-Lista $arquivoDosReleases $releases
    $alvo = if (Test-Path (Join-Path $estado 'etiqueta-errada')) { '0' * 40 } else { $release.target_commitish }
    $etiquetas = @(Ler-Lista $arquivoDasEtiquetas) + [pscustomobject]@{ ref = "refs/tags/$($release.tag_name)"; object = [pscustomobject]@{ sha = $alvo } }
    Gravar-Lista $arquivoDasEtiquetas $etiquetas
    exit 0
}
if ($linha[0] -eq 'release' -and $linha[1] -eq 'create') {
    $etiqueta = $linha[2]
    if ($linha -notcontains '--draft') { [Console]::Error.WriteLine('gh de mentira: so cria rascunho'); exit 1 }
    $notas = Opcao $linha '--notes-file'
    if (-not $notas -or -not (Test-Path $notas)) { [Console]::Error.WriteLine('gh de mentira: faltam as notas'); exit 1 }
    # Os arquivos são o que sobra depois das opções, que têm todas um valor, menos --draft.
    $arquivos = @()
    for ($i = 3; $i -lt $linha.Count; $i++) {
        if ($linha[$i] -eq '--draft') { continue }
        if ($linha[$i].StartsWith('--')) { $i++; continue }
        $arquivos += $linha[$i]
    }
    $guardados = Join-Path $estado "arquivos\$etiqueta"
    New-Item -ItemType Directory -Force $guardados | Out-Null
    foreach ($arquivo in $arquivos) { Copy-Item -LiteralPath $arquivo -Destination $guardados }
    if (Test-Path (Join-Path $estado 'corromper-ao-subir')) {
        Get-ChildItem $guardados -Filter '*.exe' | ForEach-Object { Add-Content -LiteralPath $_.FullName -Value 'x' }
    }
    $release = [pscustomobject]@{
        id               = 4242
        tag_name         = $etiqueta
        draft            = $true
        prerelease       = $false
        target_commitish = (Opcao $linha '--target')
        html_url         = "https://github.invalid/releases/$etiqueta"
        assets           = @($arquivos | ForEach-Object { [pscustomobject]@{ name = (Split-Path -Leaf $_) } })
    }
    Gravar-Lista $arquivoDosReleases (@(Ler-Lista $arquivoDosReleases) + $release)
    exit 0
}
if ($linha[0] -eq 'release' -and $linha[1] -eq 'download') {
    $guardados = Join-Path $estado "arquivos\$($linha[2])"
    $destino = Opcao $linha '--dir'
    # Com --pattern, só o arquivo com aquele nome; sem nenhum que sirva, o gh de verdade também falha.
    $padrao = Opcao $linha '--pattern'
    $pedidos = @()
    if ((Test-Path $guardados) -and $destino) { $pedidos = @(Get-ChildItem $guardados -File | Where-Object { -not $padrao -or $_.Name -eq $padrao }) }
    if ($pedidos.Count -eq 0) { [Console]::Error.WriteLine('gh de mentira: nada para baixar'); exit 1 }
    $pedidos | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $destino }
    exit 0
}
[Console]::Error.WriteLine("gh de mentira: pedido que os scripts nao deveriam fazer: $($linha -join ' ')")
exit 2
