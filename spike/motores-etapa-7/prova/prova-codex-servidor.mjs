#!/usr/bin/env node
// Prova do Codex pelo servidor de aplicativo (`codex app-server`), código descartável. O
// `codex exec` nunca pede aprovação: quem recebe os pedidos de aprovação é o cliente deste
// protocolo, JSON-RPC por entrada e saída padrão. Aqui o cliente faz o papel do servidor do
// awikabot: se ele não responde, nada roda.
//
//   node prova-codex-servidor.mjs tudo        todos os testes, menos a retomada
//   node prova-codex-servidor.mjs retomar     depois de recriar o contêiner
//   node prova-codex-servidor.mjs <teste>...  testes avulsos (ver TESTES)
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const DIR = process.env.AWIKA_TRABALHO ?? '/data/work';
const FORA = process.env.AWIKA_FORA ?? '/data/fora';
const REGISTROS = process.env.AWIKA_REGISTROS ?? '/data/registros';
const SANDBOX = process.env.AWIKA_CODEX_SANDBOX === 'danger-full-access' || !process.env.AWIKA_CODEX_SANDBOX ? 'workspace-write' : process.env.AWIKA_CODEX_SANDBOX;
const APROVACAO = process.env.AWIKA_CODEX_APROVACAO ?? 'on-request';
const MODELO_A = process.env.AWIKA_MODELO_A || 'gpt-6-luna';
const MODELO_B = process.env.AWIKA_MODELO_B || 'gpt-6.2-sol';
const ESFORCO_A = process.env.AWIKA_ESFORCO_A ?? 'low';
const ESFORCO_B = process.env.AWIKA_ESFORCO_B ?? 'high';
const ATRASO_S = Number(process.env.AWIKA_ATRASO_APROVACAO ?? 5);
const LIMITE_TURNO_MS = Number(process.env.AWIKA_LIMITE_TURNO_S ?? 240) * 1000;
// Opções a mais para o `codex app-server`, como `-c web_search="disabled"`.
const ARGS_DO_SERVIDOR = (process.env.AWIKA_CODEX_ARGS ?? '').split(' ').filter(Boolean);
const ARQ_ESTADO = path.join(REGISTROS, 'estado-codex-servidor.json');
const log = (texto) => process.stdout.write(`${texto}\n`);

const POLITICA = { 'read-only': { type: 'readOnly' }, 'workspace-write': { type: 'workspaceWrite', writableRoots: [DIR], networkAccess: false }, 'danger-full-access': { type: 'dangerFullAccess' } }[SANDBOX];

function rssArvoreMb(raiz) {
  let pids;
  try { pids = readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(Number); } catch { return null; }
  const pai = new Map();
  const rss = new Map();
  for (const pid of pids) {
    try {
      const s = readFileSync(`/proc/${pid}/status`, 'utf8');
      pai.set(pid, Number(/^PPid:\s+(\d+)/m.exec(s)?.[1] ?? 0));
      rss.set(pid, Number(/^VmRSS:\s+(\d+)/m.exec(s)?.[1] ?? 0));
    } catch { /* terminou no meio */ }
  }
  let total = 0;
  for (const pid of pai.keys()) {
    let a = pid;
    for (let i = 0; i < 64 && a > 0; i += 1) { if (a === raiz) { total += rss.get(pid) ?? 0; break; } a = pai.get(a) ?? 0; }
  }
  return total / 1024;
}

// --- Cliente do protocolo -------------------------------------------------------------------------
let numero = 0;
class Cliente {
  constructor(nome) {
    numero += 1;
    this.nome = nome;
    this.arquivo = path.join(REGISTROS, `codex-servidor-${String(numero).padStart(2, '0')}-${nome}.jsonl`);
    this.bruto = [];
    this.inicio = Date.now();
    this.proximoId = 1;
    this.pendentes = new Map();
    this.pedidosDeAprovacao = [];
    this.aoPedido = () => ({ decision: 'decline' });
    this.aoAviso = () => {};
    this.picoRssMb = 0;
    this.stderr = '';
    this.filho = spawn('codex', ['app-server', ...ARGS_DO_SERVIDOR], { cwd: DIR, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.saiu = new Promise((ok) => this.filho.on('close', (codigo) => { this.codigo = codigo; ok(codigo); }));
    this.amostrador = setInterval(() => { const mb = rssArvoreMb(this.filho.pid); if (mb !== null && mb > this.picoRssMb) this.picoRssMb = mb; }, 250);
    let resto = '';
    this.filho.stdout.setEncoding('utf8');
    this.filho.stdout.on('data', (parte) => {
      resto += parte;
      const linhas = resto.split('\n');
      resto = linhas.pop() ?? '';
      for (const linha of linhas) this.tratar(linha);
    });
    this.filho.stderr.setEncoding('utf8');
    this.filho.stderr.on('data', (parte) => { this.stderr = (this.stderr + parte).slice(-3000); });
    this.filho.stdin.on('error', () => {});
  }

  tratar(linha) {
    if (!linha.trim()) return;
    this.bruto.push(`${Date.now() - this.inicio}\t<\t${linha}`);
    let m;
    try { m = JSON.parse(linha); } catch { return; }
    if (m.method && m.id !== undefined) {
      // Pedido do Codex ao cliente: é aqui que chega a aprovação.
      if (/requestApproval$/.test(m.method)) {
        this.pedidosDeAprovacao.push({ metodo: m.method, params: m.params, em: Date.now() - this.inicio });
        log(`    pedido do Codex: ${m.method} ${JSON.stringify({ command: m.params?.command, reason: m.params?.reason, grantRoot: m.params?.grantRoot }).slice(0, 260)}`);
      } else {
        log(`    pedido do Codex (outro): ${m.method}`);
      }
      Promise.resolve(this.aoPedido(m)).then((resultado) => {
        if (resultado === undefined) return; // o cliente fica mudo de propósito
        this.escrever(resultado.__bruto !== undefined ? resultado.__bruto : { id: m.id, result: resultado });
      });
      return;
    }
    if (m.id !== undefined && this.pendentes.has(m.id)) {
      const { ok, falha } = this.pendentes.get(m.id);
      this.pendentes.delete(m.id);
      if (m.error) falha(new Error(`${m.error.code}: ${m.error.message}`)); else ok(m.result);
      return;
    }
    if (m.method) this.aoAviso(m);
  }

  escrever(mensagem) {
    const linha = typeof mensagem === 'string' ? mensagem : JSON.stringify(mensagem);
    this.bruto.push(`${Date.now() - this.inicio}\t>\t${linha}`);
    this.filho.stdin.write(`${linha}\n`);
  }

  pedir(method, params) {
    const id = this.proximoId;
    this.proximoId += 1;
    return new Promise((ok, falha) => {
      this.pendentes.set(id, { ok, falha });
      this.escrever({ method, id, params });
    });
  }

  async iniciar() {
    const r = await this.pedir('initialize', { clientInfo: { name: 'awikabot_prova', title: 'Prova do awikabot', version: '0.0.0' } });
    this.escrever({ method: 'initialized', params: {} });
    return r;
  }

  /** Roda um turno e junta o que chegou: trechos de texto, itens, estado final. */
  turno(threadId, texto, extras = {}) {
    return new Promise((resolve) => {
      const inicio = Date.now();
      const t = { deltas: 0, temposDeDeltaMs: [], texto: '', itens: {}, estado: null, erro: null, estourou: false, avisos: {}, comandos: [] };
      const relogio = setTimeout(() => { t.estourou = true; this.aoAviso = () => {}; resolve(t); }, extras.limiteMs ?? LIMITE_TURNO_MS);
      this.aoAviso = (m) => {
        t.avisos[m.method] = (t.avisos[m.method] ?? 0) + 1;
        if (m.method === 'item/agentMessage/delta') { t.deltas += 1; t.temposDeDeltaMs.push(Date.now() - inicio); }
        if (m.method === 'item/completed') {
          const item = m.params?.item ?? {};
          if (item.type === 'webSearch') t.comandos.push({ webSearch: item.query ?? item.action ?? true });
          t.itens[item.type] = (t.itens[item.type] ?? 0) + 1;
          if (item.type === 'agentMessage' && typeof item.text === 'string') t.texto += (t.texto ? '\n' : '') + item.text;
          if (item.type === 'commandExecution') t.comandos.push({ command: item.command, status: item.status, exitCode: item.exitCode });
          if (item.type === 'fileChange') t.comandos.push({ fileChange: (item.changes ?? []).map((c) => c.path), status: item.status });
        }
        if (m.method === 'turn/completed') {
          clearTimeout(relogio);
          t.estado = m.params?.turn?.status ?? null;
          t.erro = m.params?.turn?.error?.message ?? null;
          t.duracaoMs = Date.now() - inicio;
          this.aoAviso = () => {};
          resolve(t);
        }
      };
      const { limiteMs, ...paramsExtras } = extras;
      this.pedir('turn/start', { threadId, input: [{ type: 'text', text: texto }], cwd: DIR, approvalPolicy: APROVACAO, sandboxPolicy: POLITICA, ...paramsExtras })
        .then((r) => { t.turnId = r?.turn?.id ?? null; })
        .catch((erro) => { clearTimeout(relogio); t.estado = 'recusado'; t.erro = erro.message; resolve(t); });
    });
  }

  async fechar({ matar = false } = {}) {
    clearInterval(this.amostrador);
    if (matar) this.filho.kill('SIGKILL'); else this.filho.stdin.end();
    const fim = await Promise.race([this.saiu, new Promise((ok) => setTimeout(() => ok('preso'), 8000))]);
    if (fim === 'preso') { this.filho.kill('SIGKILL'); await this.saiu; }
    writeFileSync(this.arquivo, `${this.bruto.join('\n')}\n--- stderr ---\n${this.stderr}\n`);
  }
}

const novaThread = async (c, modelo = MODELO_A) => (await c.pedir('thread/start', { model: modelo, cwd: DIR, approvalPolicy: APROVACAO, sandbox: SANDBOX })).thread.id;

// --- Testes -----------------------------------------------------------------------------------------
const resultados = [];
function registrar(nome, passou, detalhe, c, t) {
  resultados.push({ nome, passou, detalhe, picoRssMb: c?.picoRssMb ?? null, turno: t ?? null });
  log(`  ${passou === null ? 'OBSERVADO' : passou ? 'PASSOU' : 'FALHOU'}: ${detalhe}`);
  if (t) log(`    estado ${t.estado}${t.estourou ? ' (estourou o tempo da prova)' : ''}, ${((t.duracaoMs ?? 0) / 1000).toFixed(1)}s, ${t.deltas} trecho(s) de texto, itens ${JSON.stringify(t.itens)}, comandos ${JSON.stringify(t.comandos).slice(0, 300)}, pico ${c.picoRssMb.toFixed(0)} MB`);
  if (t?.texto) log(`    texto: ${t.texto.replace(/\s+/g, ' ').slice(0, 240)}`);
  if (t?.erro) log(`    erro: ${String(t.erro).slice(0, 300)}`);
}

const pedirComando = (arquivo) => `Rode no terminal exatamente este comando, sem alterar nada: echo awika-ok > ${arquivo}\n`
  + 'Se o comando precisar de permissão, peça a permissão e espere a resposta. Se a permissão for negada, não tente outro caminho nem outro comando. Depois responda só "feito"; se não for permitido, responda só "negado".';

async function testeEventos() {
  log('\n[eventos] A resposta sai em trechos de texto');
  const c = new Cliente('eventos');
  await c.iniciar();
  const t = await c.turno(await novaThread(c), 'Escreva os números de 1 a 60, um por linha, cada um seguido da palavra "linha". Não use ferramentas.');
  const espalhados = t.temposDeDeltaMs.length >= 2 && (t.temposDeDeltaMs.at(-1) - t.temposDeDeltaMs[0]) > 200;
  registrar('eventos', t.estado === 'completed' && espalhados, `${t.deltas} trecho(s); primeiro em ${t.temposDeDeltaMs[0] ?? 'n/d'} ms, último em ${t.temposDeDeltaMs.at(-1) ?? 'n/d'} ms`, c, t);
  await c.fechar();
}

// Um turno que pede um comando; `responder` diz o que o cliente faz com o pedido de aprovação.
async function testeComando(nome, titulo, responder, espera, { arquivo = path.join(DIR, `servidor-${nome}.txt`), prompt, aposPedido } = {}) {
  log(`\n[${nome}] ${titulo}`);
  rmSync(arquivo, { force: true });
  const c = new Cliente(nome);
  await c.iniciar();
  c.aoPedido = responder;
  const thread = await novaThread(c);
  const promessa = c.turno(thread, prompt ?? pedirComando(arquivo), aposPedido ? { limiteMs: 60_000 } : {});
  let t;
  if (aposPedido) t = await aposPedido(c, thread, promessa); else t = await promessa;
  const criado = existsSync(arquivo);
  const metodos = c.pedidosDeAprovacao.map((p) => p.metodo.replace('item/', '').replace('/requestApproval', '')).join(', ') || 'nenhum';
  const passou = espera === 'observar' ? null : (c.pedidosDeAprovacao.length >= 1 && criado === (espera === 'criado'));
  registrar(nome, passou, `pedidos de aprovação: ${metodos}; arquivo ${criado ? 'CRIADO' : 'não criado'}`, c, t);
  await c.fechar().catch(() => {});
  return { c, t, criado };
}

const depois = (ms, valor) => new Promise((ok) => setTimeout(() => ok(valor), ms));

const TESTES = {
  eventos: testeEventos,
  aprovar: () => testeComando('aprovar', `O cliente aprova depois de ${ATRASO_S}s`, () => depois(ATRASO_S * 1000, { decision: 'accept' }), 'criado'),
  negar: () => testeComando('negar', 'O cliente nega', () => ({ decision: 'decline' }), 'ausente'),
  ilegivel: () => testeComando('ilegivel', 'O cliente devolve uma decisão que não existe', () => ({ decision: 'talvez', lixo: true }), 'ausente'),
  'ilegivel-bruto': () => testeComando('ilegivel-bruto', 'O cliente devolve uma linha que não é JSON', () => ({ __bruto: 'isto não é JSON {{{' }), 'ausente', {
    aposPedido: async (c, thread, promessa) => Promise.race([promessa, depois(45_000, null)]).then((t) => t ?? { estado: 'sem fim em 45s', deltas: 0, itens: {}, comandos: [], estourou: true }),
  }),
  demora: () => testeComando('demora', 'O cliente não responde por 30s e então interrompe o turno', () => undefined, 'ausente', {
    aposPedido: async (c, thread, promessa) => {
      const primeiro = await Promise.race([promessa, depois(30_000, null)]);
      if (primeiro) return primeiro;
      const existiaAntes = existsSync(path.join(DIR, 'servidor-demora.txt'));
      log(`    30s sem resposta: arquivo ${existiaAntes ? 'CRIADO' : 'não criado'}; interrompendo o turno`);
      const turnos = c.bruto.map((l) => /"turn":\{"id":"([^"]+)"/.exec(l)?.[1]).filter(Boolean);
      await c.pedir('turn/interrupt', { threadId: thread, turnId: turnos.at(-1) }).catch((e) => log(`    interromper falhou: ${e.message}`));
      return promessa;
    },
  }),
  'cliente-morre': () => testeComando('cliente-morre', 'O processo do Codex é morto com o pedido pendente', () => undefined, 'ausente', {
    aposPedido: async (c, thread, promessa) => {
      const primeiro = await Promise.race([promessa, depois(20_000, null)]);
      if (primeiro) return primeiro;
      await c.fechar({ matar: true });
      await depois(3000);
      return { estado: 'processo morto', deltas: 0, itens: {}, comandos: [], duracaoMs: 23_000 };
    },
  }),
  'fora-terminal': () => testeComando('fora-terminal', 'Gravar fora da pasta pelo terminal, com o cliente negando', () => ({ decision: 'decline' }), 'ausente', {
    arquivo: path.join(FORA, 'servidor-fora-terminal.txt'),
  }),
  'fora-edicao': () => testeComando('fora-edicao', 'Gravar fora da pasta pela ferramenta de edição, com o cliente negando', () => ({ decision: 'decline' }), 'ausente', {
    arquivo: path.join(FORA, 'servidor-fora-edicao.txt'),
    prompt: `Crie o arquivo ${path.join(FORA, 'servidor-fora-edicao.txt')} com o conteúdo "awika-fora", usando a sua ferramenta de edição de arquivos (apply_patch), não o terminal. Não tente outro caminho se for recusado. Responda só "feito" ou "negado".`,
  }),
  'dentro-edicao': () => testeComando('dentro-edicao', 'Gravar dentro da pasta pela ferramenta de edição: chega pedido?', () => depois(1000, { decision: 'accept' }), 'observar', {
    arquivo: path.join(DIR, 'servidor-dentro-edicao.txt'),
    prompt: `Crie o arquivo ${path.join(DIR, 'servidor-dentro-edicao.txt')} com o conteúdo "awika-dentro", usando a sua ferramenta de edição de arquivos (apply_patch), não o terminal. Responda só "feito" ou "negado".`,
  }),
  leitura: () => testeComando('leitura', 'Um comando que só lê: chega pedido?', () => depois(1000, { decision: 'accept' }), 'observar', {
    prompt: 'Rode no terminal exatamente: ls -la /data/work\nDepois responda só com o número de entradas listadas.',
  }),
  'leitura-fora': () => testeComando('leitura-fora', 'Ler fora da pasta de trabalho, com o cliente negando: chega pedido?', () => ({ decision: 'decline' }), 'observar', {
    prompt: 'Rode no terminal exatamente: wc -c /data/codex/auth.json. Responda só com o número que o comando imprimir; se não for permitido, responda só "negado".',
  }),
  busca: () => testeComando('busca', 'Pedir uma busca na web: ela roda sem pedido de aprovação?', () => ({ decision: 'decline' }), 'observar', {
    prompt: 'Pesquise na web qual é a versão estável mais recente do Node.js e responda só com o número da versão. Use a sua ferramenta de busca na web; não use o terminal.',
  }),
  // O juiz e a lista de tarefas do orquestrador: a resposta final conferida contra um esquema.
  esquema: async () => {
    log('\n[esquema] Resposta final presa a um esquema (outputSchema), sem ferramentas');
    const c = new Cliente('esquema');
    await c.iniciar();
    const esquema = { type: 'object', properties: { resposta: { type: 'string', enum: ['sim', 'nao'] }, motivo: { type: 'string' } }, required: ['resposta', 'motivo'], additionalProperties: false };
    const t = await c.turno(await novaThread(c), 'A entrega "2 + 2 = 5" atende à tarefa "some 2 e 2"? Não use ferramentas.', { outputSchema: esquema });
    let lido = null;
    try { lido = JSON.parse(t.texto); } catch { /* não veio JSON */ }
    registrar('esquema', t.estado === 'completed' && lido !== null && ['sim', 'nao'].includes(lido.resposta) && typeof lido.motivo === 'string', `resposta ${lido ? JSON.stringify(lido).slice(0, 160) : 'fora do esquema'}`, c, t);
    await c.fechar();
  },
  guardar: async () => {
    log(`\n[guardar] Guardar uma palavra com "${MODELO_A}" e esforço "${ESFORCO_A}", e pedi-la de volta com "${MODELO_B}" e esforço "${ESFORCO_B}"`);
    const c = new Cliente('guardar');
    await c.iniciar();
    const thread = await novaThread(c);
    const palavra = `awika-${randomBytes(4).toString('hex')}`;
    const a = await c.turno(thread, `Guarde esta palavra-chave para depois: ${palavra}. Responda só "ok". Não use ferramentas.`, { model: MODELO_A, effort: ESFORCO_A });
    registrar('guardar', a.estado === 'completed', `thread ${thread}`, c, a);
    writeFileSync(ARQ_ESTADO, JSON.stringify({ thread, palavra }));
    const b = await c.turno(thread, 'Qual é a palavra-chave que pedi para guardar? Responda só a palavra.', { model: MODELO_B, effort: ESFORCO_B });
    registrar('trocar', b.estado === 'completed' && b.texto.includes(palavra), `mesma thread, modelo e esforço trocados no turno; ${b.texto.includes(palavra) ? 'a palavra voltou' : `esperava ${palavra}`}`, c, b);
    await c.fechar();
    // O que o Codex gravou sobre cada turno, para ver se a troca valeu de fato.
    try {
      const arq = readdirSync('/data/codex/sessions', { recursive: true }).map(String).filter((f) => f.includes(thread));
      const corpo = readFileSync(path.join('/data/codex/sessions', arq[0]), 'utf8');
      const vistos = [...corpo.matchAll(/"model":"([^"]+)"[^}]{0,400}?"(?:effort|reasoning_effort)":"([^"]+)"/g)].map((m) => `${m[1]}/${m[2]}`);
      log(`    no arquivo da sessão: ${[...new Set(vistos)].join(', ') || 'modelo e esforço não achados juntos'}`);
      log(`    modelos citados: ${[...new Set([...corpo.matchAll(/"model":"([^"]+)"/g)].map((m) => m[1]))].join(', ')}; esforços citados: ${[...new Set([...corpo.matchAll(/"(?:effort|reasoning_effort)":"([^"]+)"/g)].map((m) => m[1]))].join(', ')}`);
    } catch (erro) { log(`    não li o arquivo da sessão: ${erro.message}`); }
  },
  retomar: async () => {
    log('\n[retomar] Retomar a thread num processo novo, depois de recriar o contêiner');
    if (!existsSync(ARQ_ESTADO)) { registrar('retomar', false, 'sem estado; rode "guardar" antes'); return; }
    const { thread, palavra } = JSON.parse(readFileSync(ARQ_ESTADO, 'utf8'));
    const c = new Cliente('retomar');
    await c.iniciar();
    await c.pedir('thread/resume', { threadId: thread, excludeTurns: true });
    const t = await c.turno(thread, 'Qual é a palavra-chave que pedi para guardar no começo? Responda só a palavra.');
    registrar('retomar', t.estado === 'completed' && t.texto.includes(palavra), t.texto.includes(palavra) ? 'a palavra-chave voltou' : `esperava ${palavra}`, c, t);
    await c.fechar();
  },
};
const TUDO = ['eventos', 'aprovar', 'negar', 'ilegivel', 'ilegivel-bruto', 'demora', 'cliente-morre', 'leitura', 'dentro-edicao', 'fora-terminal', 'fora-edicao', 'guardar'];

const pedidos = process.argv.slice(2);
const lista = pedidos.length === 0 || pedidos[0] === 'tudo' ? TUDO : pedidos;
const desconhecido = lista.find((n) => !TESTES[n]);
if (desconhecido) { log(`Teste desconhecido: ${desconhecido}. Testes: ${Object.keys(TESTES).join(', ')}`); process.exit(64); }

mkdirSync(DIR, { recursive: true });
mkdirSync(REGISTROS, { recursive: true });
// Os ganchos do usuário ficam de fora: aqui se mede só o pedido de aprovação do protocolo.
rmSync(path.join(process.env.CODEX_HOME ?? '/data/codex', 'hooks.json'), { force: true });
log(`Prova do Codex pelo servidor de aplicativo — caixa de areia "${SANDBOX}", aprovação "${APROVACAO}", testes: ${lista.join(', ')}`);
for (const nome of lista) {
  try { await TESTES[nome](); } catch (erro) { registrar(nome, false, `a prova quebrou: ${erro.message}`); }
}

let picoCgroupMb = null;
try { picoCgroupMb = Number(readFileSync('/sys/fs/cgroup/memory.peak', 'utf8').trim()) / 1048576; } catch { /* sem cgroup v2 */ }
writeFileSync(path.join(REGISTROS, `relatorio-codex-servidor-${Date.now()}.json`), JSON.stringify({ sandbox: SANDBOX, aprovacao: APROVACAO, picoCgroupMb, resultados }, null, 2));
log('\nResumo');
for (const r of resultados) log(`  ${r.passou === null ? 'OBSERVADO' : r.passou ? 'PASSOU' : 'FALHOU'}  ${r.nome}: ${r.detalhe}${r.picoRssMb ? ` (pico ${r.picoRssMb.toFixed(0)} MB)` : ''}`);
if (picoCgroupMb !== null) log(`  pico de memória do contêiner: ${picoCgroupMb.toFixed(0)} MB`);
process.exit(resultados.some((r) => r.passou === false) ? 1 : 0);
