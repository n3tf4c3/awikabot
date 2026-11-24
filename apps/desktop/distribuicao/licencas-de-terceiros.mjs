// Junta num arquivo as licenças de tudo o que entra no executável do app de desktop, e para se
// aparecer uma licença que não está na lista das aceitas.
//
//   node apps/desktop/distribuicao/licencas-de-terceiros.mjs <arquivo de saída> [alvo]
//
// O alvo padrão é o do Windows de 64 bits. Entram as dependências que o executável usa naquele
// alvo; as de teste e as de build ficam de fora, porque não vão no executável. O texto de cada
// licença vem do próprio pacote, como foi publicado. O arquivo sai sempre igual para as mesmas
// dependências, para o hash do pacote não mudar à toa.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Licenças que permitem distribuir o executável sem abrir o código do app. Uma licença nova nas
// dependências para o pacote até alguém decidir se ela entra aqui.
const ACEITAS = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSL-1.0',
  'bzip2-1.0.6',
  'CC0-1.0',
  'CDLA-Permissive-2.0',
  'ISC',
  'MIT',
  'MIT-0',
  'Unicode-3.0',
  'Unlicense',
  'Zlib',
]);
const NOME_DE_LICENCA = /^(licen[sc]e|copying|notice|unlicense|copyright)/i;
const TAMANHO_MAXIMO_DO_TEXTO = 200 * 1024;

const [saida, alvo = 'x86_64-pc-windows-msvc'] = process.argv.slice(2);
if (!saida) {
  console.error('uso: node licencas-de-terceiros.mjs <arquivo de saída> [alvo]');
  process.exit(2);
}

const pastaDoDesktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const metadados = JSON.parse(
  execFileSync('cargo', ['metadata', '--format-version', '1', '--locked', '--filter-platform', alvo], {
    cwd: pastaDoDesktop,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  }),
);

const porId = new Map(metadados.packages.map((pacote) => [pacote.id, pacote]));
const nos = new Map(metadados.resolve.nodes.map((no) => [no.id, no]));
const doApp = metadados.packages.find((pacote) => pacote.name === 'awikabot-desktop');
if (!doApp) throw new Error('o pacote awikabot-desktop não está no workspace');

// Anda pelas dependências comuns a partir do app; `kind` nulo é a dependência que vai no executável.
const usados = new Set();
const fila = [doApp.id];
while (fila.length > 0) {
  const id = fila.pop();
  if (usados.has(id)) continue;
  usados.add(id);
  for (const dependencia of nos.get(id)?.deps ?? []) {
    if (dependencia.dep_kinds.some((tipo) => tipo.kind === null)) fila.push(dependencia.pkg);
  }
}

const doProjeto = new Set(metadados.workspace_members);
const pacotes = [...usados]
  .filter((id) => !doProjeto.has(id))
  .map((id) => porId.get(id))
  .sort((a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en'));

/** Os nomes de licença de uma expressão como "MIT OR Apache-2.0" ou "(MIT OR Apache-2.0) AND Unicode-3.0". */
function licencasDe(expressao) {
  return expressao
    .replace(/[()]/g, ' ')
    .split(/\s+(?:OR|AND|WITH)\s+|\//)
    .map((nome) => nome.trim())
    .filter(Boolean);
}

const recusados = [];
const semTexto = [];
const textos = new Map(); // hash do texto -> { texto, de: [pacote] }
for (const pacote of pacotes) {
  const nome = `${pacote.name} ${pacote.version}`;
  if (!pacote.license) {
    recusados.push(`${nome}: sem licença declarada`);
    continue;
  }
  const fora = licencasDe(pacote.license).filter((licenca) => !ACEITAS.has(licenca));
  if (fora.length > 0) recusados.push(`${nome}: ${pacote.license}`);

  const pasta = dirname(pacote.manifest_path);
  const arquivos = readdirSync(pasta, { withFileTypes: true })
    .filter((item) => item.isFile() && NOME_DE_LICENCA.test(item.name))
    .map((item) => item.name)
    .sort((a, b) => a.localeCompare(b, 'en'));
  if (arquivos.length === 0) semTexto.push(pacote);
  for (const arquivo of arquivos) {
    const texto = readFileSync(join(pasta, arquivo), 'utf8').replace(/\r\n?/g, '\n').trim();
    if (texto.length === 0 || texto.length > TAMANHO_MAXIMO_DO_TEXTO) continue;
    const hash = createHash('sha256').update(texto).digest('hex');
    if (!textos.has(hash)) textos.set(hash, { texto, de: [] });
    textos.get(hash).de.push(nome);
  }
}

if (recusados.length > 0) {
  console.error('licença fora da lista das aceitas; o pacote não sai até alguém decidir:');
  for (const recusado of recusados) console.error(`  ${recusado}`);
  process.exit(1);
}

const linhas = [
  'awikabot: licenças de terceiros',
  '',
  'O awikabot é distribuído sob a licença MIT. O executável inclui os componentes abaixo, cada',
  'um sob a própria licença. O texto das licenças vem depois da lista.',
  '',
  `Componentes (${pacotes.length}):`,
  '',
  ...pacotes.map((pacote) => `- ${pacote.name} ${pacote.version}: ${pacote.license}${pacote.repository ? ` (${pacote.repository})` : ''}`),
  '',
];
if (semTexto.length > 0) {
  linhas.push(
    'Estes componentes foram publicados sem arquivo de licença no pacote; vale a licença declarada',
    'na lista acima, cujo texto aparece adiante, trazido por outros componentes:',
    '',
    ...semTexto.map((pacote) => `- ${pacote.name} ${pacote.version}: ${pacote.license}`),
    '',
  );
}
const emOrdem = [...textos.values()].sort((a, b) => a.de[0].localeCompare(b.de[0], 'en') || a.texto.localeCompare(b.texto, 'en'));
for (const { texto, de } of emOrdem) {
  linhas.push('='.repeat(78), `Usado por: ${de.join(', ')}`, '='.repeat(78), '', texto, '');
}
writeFileSync(saida, `${linhas.join('\n')}\n`);
console.log(`${pacotes.length} componentes, ${textos.size} textos de licença, ${semTexto.length} sem arquivo de licença no pacote`);
