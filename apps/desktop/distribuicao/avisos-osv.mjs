// Pergunta à base OSV se alguma dependência do app de desktop tem vulnerabilidade conhecida.
//
//   node apps/desktop/distribuicao/avisos-osv.mjs
//
// Complementa o `cargo deny`, que só enxerga a base RustSec: a OSV junta também os avisos
// publicados só no GitHub. Vai para a rede o nome e a versão de cada dependência pública do
// `Cargo.lock`, e mais nada. Sai com código 1 se houver vulnerabilidade; aviso de dependência
// sem manutenção é listado e não para o pacote, como no `deny.toml`.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OSV = 'https://api.osv.dev/v1';
const REGISTRO = 'registry+https://github.com/rust-lang/crates.io-index';
// Aviso aceito entra aqui com o motivo e a data, nunca em silêncio: { id: 'motivo (data)' }.
const ACEITOS = {};

const arquivo = join(dirname(fileURLToPath(import.meta.url)), '..', 'Cargo.lock');
const pacotes = readFileSync(arquivo, 'utf8')
  .split('[[package]]')
  .slice(1)
  .map((bloco) => ({
    nome: /^name = "(.+)"$/m.exec(bloco)?.[1],
    versao: /^version = "(.+)"$/m.exec(bloco)?.[1],
    origem: /^source = "(.+)"$/m.exec(bloco)?.[1],
  }))
  // Só o que vem do registro público tem entrada na base; o que vem de repositório Git não tem.
  .filter((pacote) => pacote.nome && pacote.versao && pacote.origem === REGISTRO);
if (pacotes.length === 0) throw new Error('nenhuma dependência do registro encontrada no Cargo.lock');

async function pedir(caminho, corpo) {
  const resposta = await fetch(`${OSV}${caminho}`, {
    method: corpo ? 'POST' : 'GET',
    headers: corpo ? { 'content-type': 'application/json' } : {},
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!resposta.ok) throw new Error(`a OSV respondeu ${resposta.status} em ${caminho}`);
  return resposta.json();
}

const consulta = await pedir('/querybatch', {
  queries: pacotes.map((pacote) => ({ package: { name: pacote.nome, ecosystem: 'crates.io' }, version: pacote.versao })),
});
if (consulta.results?.length !== pacotes.length) throw new Error('a OSV devolveu um número de respostas diferente do de perguntas');
if (consulta.results.some((resultado) => resultado.next_page_token)) throw new Error('a OSV cortou uma resposta; rode de novo');

const afetados = new Map(); // id do aviso -> dependências
consulta.results.forEach((resultado, qual) => {
  for (const aviso of resultado.vulns ?? []) {
    if (!afetados.has(aviso.id)) afetados.set(aviso.id, []);
    afetados.get(aviso.id).push(`${pacotes[qual].nome} ${pacotes[qual].versao}`);
  }
});

const vulnerabilidades = [];
const sem_manutencao = [];
for (const [id, dependencias] of [...afetados].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
  const aviso = await pedir(`/vulns/${encodeURIComponent(id)}`);
  const linha = `${id}: ${dependencias.join(', ')}: ${aviso.summary ?? 'sem resumo'}`;
  // O tipo do aviso vem em cada pacote afetado. Só conta como "sem manutenção" o aviso em que
  // todos dizem isso; faltando a marca em algum, vale como vulnerabilidade.
  const so_manutencao = aviso.affected?.length > 0 && aviso.affected.every((afetado) => afetado.database_specific?.informational === 'unmaintained');
  if (so_manutencao) sem_manutencao.push(linha);
  else if (ACEITOS[id]) console.log(`aceito  ${linha} [${ACEITOS[id]}]`);
  else vulnerabilidades.push(linha);
}

console.log(`${pacotes.length} dependências consultadas na OSV`);
for (const linha of sem_manutencao) console.log(`sem manutenção  ${linha}`);
for (const linha of vulnerabilidades) console.log(`VULNERABILIDADE  ${linha}`);
if (vulnerabilidades.length > 0) {
  console.error(`${vulnerabilidades.length} vulnerabilidade(s) conhecida(s): o pacote não sai até cada uma ser corrigida ou aceita por escrito`);
  process.exit(1);
}
console.log('nenhuma vulnerabilidade conhecida');
