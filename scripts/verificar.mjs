#!/usr/bin/env node
// Runbook `verificar` em forma de comando: constrói o servidor, sobe o build de
// produção numa porta dedicada, percorre os fluxos do mapa que já existem,
// encerra o processo e relata. Sai com código diferente de zero se algo falhar.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVIDOR = path.join(RAIZ, 'apps', 'server');
const PORTA = Number(process.env.AWIKA_VERIFICAR_PORTA ?? 8795);
const BASE = `http://127.0.0.1:${PORTA}`;
const inicio = Date.now();
const resultados = [];

function registrar(id, nome, passou, detalhe) {
  resultados.push({ id, nome, passou });
  console.log(`${passou ? 'PASSOU' : 'FALHOU'}  ${id}  ${nome}: ${detalhe}`);
}

async function responde() {
  try {
    return (await fetch(`${BASE}/healthz`)).ok;
  } catch {
    return false;
  }
}

async function esperar(condicao, limiteMs) {
  const fim = Date.now() + limiteMs;
  while (Date.now() < fim) {
    if (await condicao()) return true;
    await new Promise((ok) => { setTimeout(ok, 150); });
  }
  return false;
}

// 1. Subir: build de produção e servidor em porta dedicada.
if (await responde()) {
  console.error(`FALHOU  a porta ${PORTA} já tem um servidor respondendo; encerre-o ou mude AWIKA_VERIFICAR_PORTA.`);
  process.exit(1);
}
const build = spawnSync(process.execPath, ['build.mjs'], { cwd: SERVIDOR, encoding: 'utf8' });
if (build.status !== 0) {
  console.error(build.stderr || build.stdout);
  console.error('FALHOU  build do servidor');
  process.exit(1);
}
const processo = spawn(process.execPath, ['dist/server.mjs'], {
  cwd: SERVIDOR,
  env: { ...process.env, NODE_ENV: 'production', AWIKA_HOST: '127.0.0.1', AWIKA_PORTA: String(PORTA) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let saida = '';
processo.stdout.on('data', (parte) => { saida += parte; });
processo.stderr.on('data', (parte) => { saida += parte; });
const saiu = new Promise((ok) => { processo.once('exit', ok); });

try {
  // 2. Dirigir e 3. Observar: fluxo F0 do mapa (docs/fluxos.md).
  if (await esperar(responde, 10_000)) {
    const resposta = await fetch(`${BASE}/healthz`);
    const corpo = await resposta.json();
    const contratoOk = resposta.status === 200
      && corpo.status === 'ok'
      && typeof corpo.versao === 'string' && corpo.versao.length > 0
      && Number.isInteger(corpo.protocolo) && corpo.protocolo > 0;
    registrar('F0', 'saúde do servidor', contratoOk, `status ${resposta.status}, corpo ${JSON.stringify(corpo)}`);

    const desconhecida = await fetch(`${BASE}/nao-existe`);
    registrar('F0', 'rota desconhecida', desconhecida.status === 404, `status ${desconhecida.status}`);
  } else {
    registrar('F0', 'saúde do servidor', false, `sem resposta em ${BASE}/healthz; saída do servidor: ${saida.trim() || '(vazia)'}`);
  }
} finally {
  // 4. Encerrar: derrubar o servidor e conferir que a porta ficou livre.
  processo.kill();
  await saiu;
}
const portaLivre = await esperar(async () => !(await responde()), 5_000);
registrar('--', 'encerramento', portaLivre, portaLivre ? `porta ${PORTA} liberada` : `porta ${PORTA} ainda responde`);

// 5. Relatar.
const falhas = resultados.filter((resultado) => !resultado.passou);
console.log(`\n${resultados.length - falhas.length} de ${resultados.length} verificações passaram em ${((Date.now() - inicio) / 1000).toFixed(1)}s.`);
console.log('Não verificado por este comando: o app no aparelho; os fluxos F1 a F5, que ainda não existem.');
process.exit(falhas.length === 0 ? 0 : 1);
