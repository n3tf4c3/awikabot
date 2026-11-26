#!/usr/bin/env node
// Prova do orquestrador no Claude Code (código descartável): como ele entrega uma tarefa ao
// servidor, com o motor rodando como no produto, com --setting-sources=user.
//
//   A. ferramenta própria: um servidor MCP dado na linha de comando oferece "delegar"; o gancho
//      PreToolUse vê cada chamada antes de ela rodar.
//   B. lista no fim da resposta: a resposta final é conferida pelo motor contra um esquema.
//
// Nos dois casos a pasta de trabalho tem um .mcp.json e um .claude/settings.json plantados, que
// não podem ser lidos como configuração.
//
//   node prova-orquestrador.mjs            gancho pela opção --settings
//   node prova-orquestrador.mjs gerenciado gancho pela configuração gerenciada, como na imagem
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const GERENCIADO = process.argv[2] === 'gerenciado';
const DIR = '/data/work-orquestrador';
const REGISTROS = '/data/registros';
const DIARIO = path.join(REGISTROS, 'orquestrador-gancho.jsonl');
const MARCA = path.join(REGISTROS, 'gancho-plantado-rodou.txt');
const MODELO = process.env.AWIKA_MODELO_ORQ ?? 'haiku';
const log = (texto) => process.stdout.write(`${texto}\n`);

const PEDIDO = 'A equipe tem dois workers: "redator" e "revisor". O pedido da pessoa é: "Escreva um parágrafo de boas-vindas para o site e depois revise a ortografia dele." '
  + 'Divida o pedido em exatamente duas tarefas, uma para cada worker.';

const ESQUEMA = {
  type: 'object',
  properties: {
    tarefas: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: {
        type: 'object',
        properties: { worker: { type: 'string', enum: ['redator', 'revisor'] }, tarefa: { type: 'string', minLength: 1 } },
        required: ['worker', 'tarefa'],
        additionalProperties: false,
      },
    },
  },
  required: ['tarefas'],
  additionalProperties: false,
};

function prepararPasta() {
  mkdirSync(path.join(DIR, '.claude'), { recursive: true });
  mkdirSync(REGISTROS, { recursive: true });
  rmSync(DIARIO, { force: true });
  rmSync(MARCA, { force: true });
  // Plantados na pasta do bot: um servidor MCP e um gancho. Com --setting-sources=user e
  // --strict-mcp-config, nenhum dos dois pode valer.
  writeFileSync(path.join(DIR, '.mcp.json'), JSON.stringify({ mcpServers: { intruso: { command: 'node', args: [path.join(AQUI, 'servidor-mcp.mjs')] } } }));
  writeFileSync(path.join(DIR, '.claude', 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `sh -c 'echo rodou > ${MARCA}'` }] }] },
  }));
}

function rodar(nome, extras, prompt) {
  return new Promise((resolve) => {
    const args = ['-p', '--output-format=stream-json', '--verbose', '--permission-mode=default', '--setting-sources=user', `--model=${MODELO}`, ...extras];
    if (!GERENCIADO) {
      args.push(`--settings=${JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `node ${path.join(AQUI, 'gancho-orquestrador.mjs')}`, timeout: 60 }] }] } })}`);
    }
    const filho = spawn('claude', args, { cwd: DIR, env: { ...process.env, AWIKA_TURNO_TOKEN: 'token-do-turno-da-prova' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const r = { nome, inicio: null, resultado: null, usos: [], stderr: '', bruto: [] };
    let resto = '';
    const tratar = (linha) => {
      if (!linha.trim()) return;
      r.bruto.push(linha);
      let e;
      try { e = JSON.parse(linha); } catch { return; }
      if (e.type === 'system' && e.subtype === 'init') r.inicio = { tools: e.tools, mcp_servers: e.mcp_servers };
      if (e.type === 'assistant') for (const parte of e.message?.content ?? []) if (parte.type === 'tool_use') r.usos.push({ nome: parte.name, entrada: parte.input });
      if (e.type === 'result') r.resultado = e;
    };
    filho.stdout.setEncoding('utf8');
    filho.stdout.on('data', (parte) => { resto += parte; const linhas = resto.split('\n'); resto = linhas.pop() ?? ''; linhas.forEach(tratar); });
    filho.stderr.setEncoding('utf8');
    filho.stderr.on('data', (parte) => { r.stderr = (r.stderr + parte).slice(-2000); });
    filho.stdin.on('error', () => {});
    filho.stdin.end(prompt);
    filho.on('close', (codigo) => {
      tratar(resto);
      r.codigo = codigo;
      writeFileSync(path.join(REGISTROS, `orquestrador-${nome}${GERENCIADO ? '-gerenciado' : ''}.jsonl`), `${r.bruto.join('\n')}\n--- stderr ---\n${r.stderr}\n`);
      resolve(r);
    });
  });
}

const lerDiario = () => (existsSync(DIARIO) ? readFileSync(DIARIO, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const falhas = [];
const conferir = (ok, texto) => { log(`  ${ok ? 'PASSOU' : 'FALHOU'}: ${texto}`); if (!ok) falhas.push(texto); };

prepararPasta();
log(`Prova do orquestrador no Claude Code — gancho ${GERENCIADO ? 'pela configuração gerenciada' : 'pela opção --settings'}, modelo "${MODELO}"`);

log('\n[A] Ferramenta própria: servidor MCP dado em --mcp-config, ferramentas embutidas só de leitura');
const mcp = { mcpServers: { awika: { command: 'node', args: [path.join(AQUI, 'servidor-mcp.mjs')] } } };
const a = await rodar('ferramenta', ['--strict-mcp-config', `--mcp-config=${JSON.stringify(mcp)}`, '--tools=Read,Glob,Grep'],
  `${PEDIDO} Entregue cada tarefa com a ferramenta "delegar", uma chamada por tarefa. Depois tente rodar o comando "echo oi" no terminal, se tiver como. No fim, diga em uma linha o que fez.`);
const diarioA = lerDiario();
const delegadas = diarioA.filter((d) => d.ferramenta === 'mcp__awika__delegar');
log(`  ferramentas do turno: ${JSON.stringify(a.inicio?.tools)}`);
log(`  servidores MCP: ${JSON.stringify(a.inicio?.mcp_servers)}`);
log(`  chamadas vistas pelo gancho: ${JSON.stringify(diarioA)}`);
conferir(a.codigo === 0 && a.resultado?.is_error === false, `o turno terminou sem erro (saída ${a.codigo})`);
conferir((a.inicio?.mcp_servers ?? []).some((s) => s.name === 'awika' && s.status === 'connected'), 'o servidor MCP da linha de comando conectou');
conferir(!(a.inicio?.mcp_servers ?? []).some((s) => s.name === 'intruso'), 'o servidor do .mcp.json plantado na pasta não foi carregado');
conferir((a.inicio?.tools ?? []).includes('mcp__awika__delegar'), 'a ferramenta "delegar" está na lista do turno');
conferir(!(a.inicio?.tools ?? []).some((t) => ['Bash', 'Write', 'Edit'].includes(t)), 'Bash, Write e Edit não estão na lista do turno');
conferir(delegadas.length >= 2 && delegadas.every((d) => typeof d.entrada?.worker === 'string' && typeof d.entrada?.tarefa === 'string'), `o gancho viu ${delegadas.length} chamada(s) de "delegar", com worker e tarefa, antes de rodarem`);
if (delegadas.length !== 2) log(`  OBSERVADO: o pedido era de duas tarefas e o modelo fez ${delegadas.length} chamadas; uma chamada feita não se desfaz`);
conferir(delegadas.every((d) => d.temTokenDoTurno), 'o gancho recebeu o token do turno pelo ambiente');
conferir(!existsSync(MARCA), 'o gancho plantado em .claude/settings.json não rodou');
log(`  resposta: ${String(a.resultado?.result ?? '').replace(/\s+/g, ' ').slice(0, 300)}`);

log('\n[B] Lista no fim da resposta: --json-schema, sem nenhuma ferramenta');
rmSync(DIARIO, { force: true });
const b = await rodar('lista', ['--strict-mcp-config', '--tools=', `--json-schema=${JSON.stringify(ESQUEMA)}`], PEDIDO);
const lista = b.resultado?.structured_output;
log(`  ferramentas do turno: ${JSON.stringify(b.inicio?.tools)}`);
log(`  structured_output: ${JSON.stringify(lista)}`);
log(`  chamadas vistas pelo gancho: ${JSON.stringify(lerDiario())}`);
conferir(b.codigo === 0 && b.resultado?.is_error === false, `o turno terminou sem erro (saída ${b.codigo})`);
conferir(Array.isArray(lista?.tarefas) && lista.tarefas.length === 2 && lista.tarefas.every((t) => ['redator', 'revisor'].includes(t.worker) && typeof t.tarefa === 'string'), 'a lista veio em structured_output, dentro do esquema');
conferir(lerDiario().some((d) => d.ferramenta === 'StructuredOutput' && Array.isArray(d.entrada?.tarefas)), 'o gancho viu a lista, como a ferramenta StructuredOutput, antes de ela valer');
conferir(!existsSync(MARCA), 'o gancho plantado em .claude/settings.json não rodou');
for (const r of [a, b]) {
  const u = r.resultado;
  log(`  ${r.nome}: ${u?.num_turns} volta(s) do modelo, ${u?.duration_ms} ms, custo dito pelo motor US$ ${u?.total_cost_usd}`);
}

log(`\n${falhas.length === 0 ? 'Tudo passou.' : `${falhas.length} conferência(s) falharam.`}`);
process.exit(falhas.length === 0 ? 0 : 1);
