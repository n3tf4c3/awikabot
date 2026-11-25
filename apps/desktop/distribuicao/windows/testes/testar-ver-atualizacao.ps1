# Teste do que a conferência depois de publicar (ver-atualizacao.ps1) decide sem o Sandbox: o
# julgamento do histórico e as recusas da versão anterior, que o QA também usa.
#
#   powershell -ExecutionPolicy Bypass -File apps/desktop/distribuicao/windows/testes/testar-ver-atualizacao.ps1
#
# O histórico que o Sandbox anotaria é escrito aqui e passa pelo mesmo JSON: primeiro a
# atualização inteira, depois um defeito por vez, e têm de falhar aquele passo e os que dependem
# dele. As recusas da versão anterior rodam contra uma pasta temporária, com um instalador de
# mentira. Nada é instalado, e o Sandbox não abre. Faz parte das conferências do candidato.
. (Join-Path $PSScriptRoot '..\comum.ps1')

$de = '0.0.1'
$para = '0.0.2'
$pacote = "awikabot-$para-windows-x64.exe"
$publicado = [pscustomobject]@{ versao = $para; arquivo = $pacote; tamanho = 6000; sha256 = 'a' * 64 }

# Um estado como o Sandbox o anota, lido de volta do JSON. `$processo` nulo é o app fechado.
# `$consulta` nula é o app sem arquivo de preferências; 'sem data', o arquivo sem a data da consulta.
function Estado([string]$executavel, [string]$registro, $processo, $consulta, $pacotes = @()) {
    $preferencias = $null
    if ($consulta -eq 'sem data') { $preferencias = [ordered]@{ avisar_de_versao_nova = $true; ultima_consulta_s = $null } }
    elseif ($consulta) { $preferencias = [ordered]@{ avisar_de_versao_nova = $true; ultima_consulta_s = $consulta } }
    $estado = [ordered]@{
        versao_do_executavel = $executavel; versao_no_registro = $registro; app_aberto = [bool]$processo; processo = $processo
        instalador_rodando = $false; pacotes = @($pacotes); preferencias = $preferencias
    }
    return (ConvertTo-Json -InputObject $estado -Compress -Depth 5) | ConvertFrom-Json
}
function Pacote([string]$nome, $tamanho, $hash) { return [ordered]@{ nome = $nome; tamanho = $tamanho; sha256 = $hash } }
function Instalacao([scriptblock]$mudanca) {
    $instalacao = [pscustomobject]@{ instalador_conferido = $true; codigo_do_instalador = 0; versao_instalada = $de; janela = $true; processo = 100; erro = $null }
    if ($mudanca) { & $mudanca $instalacao }
    return $instalacao
}
$chegando = Pacote "$pacote.part" $null $null
$baixado = Pacote $pacote 6000 ('a' * 64)
# A atualização inteira, como foi vista com a 0.1.1: abre, consulta, baixa, troca, reabre, apaga o pacote.
function Historico([hashtable]$com = @{}) {
    $consulta = if ($com.ContainsKey('consulta')) { $com.consulta } else { 1795580999 }
    $noDisco = if ($com.ContainsKey('pacote')) { $com.pacote } else { $baixado }
    $registroNovo = if ($com.ContainsKey('registro')) { $com.registro } else { $para }
    $executavelNovo = if ($com.ContainsKey('executavel')) { $com.executavel } else { $para }
    $processoNovo = if ($com.ContainsKey('processo')) { $com.processo } else { 200 }
    $noFim = if ($com.ContainsKey('sobra')) { @($com.sobra) } else { @() }
    return @(
        (Estado $de $de 100 $null),
        (Estado $de $de 100 $consulta),
        (Estado $de $de 100 $consulta @($chegando)),
        (Estado $de $de 100 $consulta @($noDisco)),
        (Estado $de $de $null $consulta @($noDisco)),
        (Estado $executavelNovo $registroNovo $processoNovo $consulta @($noDisco)),
        (Estado $executavelNovo $registroNovo $processoNovo $consulta $noFim)
    )
}

$falhas = New-Object System.Collections.ArrayList
$casos = 0
function Anotar-Caso([string]$nome, [string[]]$motivos) {
    $script:casos++
    if ($motivos.Count -eq 0) { "PASSOU  $nome" } else { "FALHOU  ${nome}: $($motivos -join '; ')"; [void]$falhas.Add($nome) }
}
# Os passos têm de sair aprovados e reprovados nesta ordem (1 e 0), e o detalhe de um reprovado, trazer o trecho.
function Esperar-Passos([string]$nome, $passos, [string]$padrao, [string]$trecho = '') {
    $motivos = @()
    $visto = (@($passos) | ForEach-Object { if ($_.ok) { '1' } else { '0' } }) -join ''
    if ($visto -ne $padrao) { $motivos += "os passos sairam $visto, e nao $padrao" }
    $detalhes = (@($passos) | ForEach-Object { $_.detalhe }) -join ' | '
    if ($trecho -and $detalhes.IndexOf($trecho, [StringComparison]::Ordinal) -lt 0) { $motivos += "nenhum detalhe traz '$trecho' ($detalhes)" }
    if (@(@($passos) | Where-Object { $_.ok -and $_.detalhe }).Count -gt 0) { $motivos += 'passo aprovado com detalhe de falha' }
    Anotar-Caso $nome $motivos
}
function Julgar($instalacao, $estados, [bool]$soAteAConsulta = $false) {
    return @(Get-PassosDaAtualizacao $instalacao $estados $de $para $publicado $soAteAConsulta)
}
function Esperar-Recusa([string]$nome, [string]$trecho, [scriptblock]$tentativa) {
    $motivos = @()
    try { & $tentativa | Out-Null; $motivos += 'nao recusou' }
    catch { if ("$_".IndexOf($trecho, [StringComparison]::Ordinal) -lt 0) { $motivos += "recusou por outro motivo: $_" } }
    Anotar-Caso $nome $motivos
}

$area = New-PastaTemporaria 'teste-ver-atualizacao'
try {
    # --- O julgamento do histórico ---
    Esperar-Passos 'a atualizacao inteira' (Julgar (Instalacao) (Historico)) '111111'
    Esperar-Passos 'so ate a consulta: dois passos, e passam' (Julgar (Instalacao) (Historico | Select-Object -First 2) $true) '11'
    Esperar-Passos 'so ate a consulta, sem consulta' (Julgar (Instalacao) (Historico | Select-Object -First 1) $true) '10' 'nao registraram a consulta'
    Esperar-Passos 'historico vazio' (Julgar (Instalacao) @()) '100000' 'nao registraram a consulta'

    Esperar-Passos 'o Sandbox nao disse como foi a instalacao' (Julgar $null (Historico)) '011111' 'nao disse como foi a instalacao'
    Esperar-Passos 'o roteiro de dentro parou num erro' (Julgar (Instalacao { param($i) $i.erro = 'bloqueado pelo Windows' }) (Historico)) '011111' 'bloqueado pelo Windows'
    Esperar-Passos 'instalador que nao e o do manifesto' (Julgar (Instalacao { param($i) $i.instalador_conferido = $false }) (Historico)) '011111' 'nao e o do manifesto'
    Esperar-Passos 'instalador que saiu com erro' (Julgar (Instalacao { param($i) $i.codigo_do_instalador = 5 }) (Historico)) '011111' 'saiu com o codigo 5'
    Esperar-Passos 'outra versao instalada na partida' (Julgar (Instalacao { param($i) $i.versao_instalada = $para }) (Historico)) '011111' "versao instalada: $para"
    Esperar-Passos 'a janela nao apareceu' (Julgar (Instalacao { param($i) $i.janela = $false }) (Historico)) '011111' 'a janela do app nao apareceu'

    Esperar-Passos 'sem consulta registrada' (Julgar (Instalacao) (Historico @{ consulta = $null })) '100000' 'nao registraram a consulta'
    Esperar-Passos 'preferencias gravadas sem a data da consulta' (Julgar (Instalacao) (Historico @{ consulta = 'sem data' })) '100000' 'nao registraram a consulta'
    Esperar-Passos 'consulta registrada so depois da troca'(Julgar (Instalacao) @((Estado $de $de 100 $null @($baixado)), (Estado $para $para 200 1795580999))) '100000'
    Esperar-Passos 'pacote que ficou pela metade' (Julgar (Instalacao) (Historico @{ pacote = $chegando })) '110000' 'nao apareceu na pasta'
    Esperar-Passos 'pacote com outro tamanho' (Julgar (Instalacao) (Historico @{ pacote = (Pacote $pacote 5999 ('a' * 64)) })) '110000' 'tem 5999 bytes'
    Esperar-Passos 'pacote com outro hash' (Julgar (Instalacao) (Historico @{ pacote = (Pacote $pacote 6000 ('b' * 64)) })) '110000' ('hash ' + ('b' * 64))
    Esperar-Passos 'pacote de outra versao' (Julgar (Instalacao) (Historico @{ pacote = (Pacote "awikabot-$de-windows-x64.exe" 6000 ('a' * 64)) })) '110000' 'nao apareceu na pasta'
    Esperar-Passos 'pacote visto so antes da consulta' (Julgar (Instalacao) @((Estado $de $de 100 $null @($baixado)), (Estado $de $de 100 1795580999), (Estado $para $para 200 1795580999))) '110000'
    Esperar-Passos 'o executavel nao mudou' (Julgar (Instalacao) (Historico @{ executavel = $de })) '111000' "executavel na $de e registro na $para"
    Esperar-Passos 'o registro nao mudou' (Julgar (Instalacao) (Historico @{ registro = $de })) '111000' "executavel na $para e registro na $de"
    Esperar-Passos 'o app nao reabriu' (Julgar (Instalacao) (Historico @{ processo = $null })) '111100' 'nao foi visto aberto depois da troca'
    Esperar-Passos 'o processo e o mesmo de antes' (Julgar (Instalacao) (Historico @{ processo = 100 })) '111100' 'o processo e o mesmo de antes'
    Esperar-Passos 'o pacote continuou no disco' (Julgar (Instalacao) (Historico @{ sobra = $baixado })) '111110' 'o pacote continuou'
    Esperar-Passos 'passo que depende de outro nao visto diz isso' (Julgar (Instalacao) (Historico @{ consulta = $null })) '100000' 'so vale depois do passo anterior'

    # --- As recusas da versão anterior ---
    $numero = 0
    function Montar-Anterior([string]$versao = $de, [scriptblock]$defeito) {
        $script:numero++
        $pasta = Join-Path $area "anterior-$script:numero"
        New-Item -ItemType Directory -Force $pasta | Out-Null
        $instalador = Join-Path $pasta "awikabot-$versao-windows-x64.exe"
        Write-TextoSemBom $instalador "instalador de mentira $script:numero`n"
        $manifesto = [ordered]@{ versao = $versao; plataforma = 'windows-x64'; arquivo = "awikabot-$versao-windows-x64.exe"; tamanho = (Get-Item $instalador).Length; sha256 = (Get-Sha256 $instalador) }
        if ($defeito) { & $defeito $manifesto $pasta }
        if ($manifesto.Count -gt 0) { Write-TextoSemBom (Join-Path $pasta 'awikabot-desktop-windows-x64.json') ((ConvertTo-Json -InputObject $manifesto) + "`n") }
        return $pasta
    }
    $boa = Montar-Anterior
    $resolvida = Resolve-VersaoAnterior $boa $para $false
    $motivos = @()
    if ($resolvida.Partida.versao -ne $de) { $motivos += "versao de partida: $($resolvida.Partida.versao)" }
    if ($resolvida.Partida.instalador -ne "awikabot-$de-windows-x64.exe") { $motivos += "instalador de partida: $($resolvida.Partida.instalador)" }
    if ($resolvida.Partida.sha256 -ne (Get-Sha256 $resolvida.Instalador)) { $motivos += 'o hash de partida nao e o do instalador' }
    if (-not (Test-Path -LiteralPath $resolvida.Manifesto)) { $motivos += 'o manifesto devolvido nao existe' }
    Anotar-Caso 'versao anterior boa: devolve de onde a rodada parte' $motivos

    Esperar-Recusa 'anterior: sem manifesto' 'falta o manifesto da versao anterior' { Resolve-VersaoAnterior (Montar-Anterior $de { param($m, $p) $m.Clear() }) $para $false }
    Esperar-Recusa 'anterior: versao fora do formato' 'fora do formato x.y.z' { Resolve-VersaoAnterior (Montar-Anterior $de { param($m, $p) $m.versao = '0.0.1-beta' }) $para $false }
    Esperar-Recusa 'anterior: manifesto que aponta para outro arquivo' 'aponta para um arquivo com outro nome' { Resolve-VersaoAnterior (Montar-Anterior $de { param($m, $p) $m.arquivo = '..\outro.exe' }) $para $false }
    Esperar-Recusa 'anterior: a mesma versao' "a versao anterior ($para) tem de ser menor que a do pacote ($para)" { Resolve-VersaoAnterior (Montar-Anterior $para) $para $false }
    Esperar-Recusa 'anterior: versao maior, com o nome que quem chama deu' "tem de ser menor que a ultima versao publica ($para)" { Resolve-VersaoAnterior (Montar-Anterior '0.0.3') $para $false 'a ultima versao publica' }
    Esperar-Recusa 'anterior: sem o instalador' 'falta o instalador da versao anterior' { Resolve-VersaoAnterior (Montar-Anterior $de { param($m, $p) Remove-Item -LiteralPath (Join-Path $p $m.arquivo) }) $para $false }
    Esperar-Recusa 'anterior: instalador trocado' 'nao e o do manifesto dela' { Resolve-VersaoAnterior (Montar-Anterior $de { param($m, $p) Add-Content -LiteralPath (Join-Path $p $m.arquivo) -Value 'x' }) $para $false }
    Esperar-Recusa 'anterior: instalador sem assinatura, com o Smart App Control ligado' 'nao tem assinatura valida' { Resolve-VersaoAnterior (Montar-Anterior) $para $true }
} finally {
    Remove-Item -LiteralPath $area -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue
}

if ($falhas.Count -gt 0) { throw "teste da conferencia da atualizacao: $($falhas.Count) de $casos casos falharam" }
"teste da conferencia da atualizacao: $casos de $casos casos passaram"
