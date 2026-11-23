#!/usr/bin/env node
// Prova da etapa 0 (código descartável): dirige o Claude Code sem tela e confere
// streaming, aprovação respondida por um programa de fora, retomada e memória.
//
//   node prova.mjs tudo      testes 1 a 3 e a primeira metade do teste 4
//   node prova.mjs retomar   segunda metade do teste 4, depois de recriar o contêiner
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const modo = process.argv[2] ?? 'tudo';
const DIR = process.env.AWIKA_TRABALHO ?? '/data/work';
const BIN = (process.env.AWIKA_CLAUDE_BIN ?? 'claude').split(' ').filter(Boolean);
const MODELO = process.env.AWIKA_MODELO ?? '';
const ATRASO_S = Number(process.env.AWIKA_ATRASO_APROVACAO ?? 20);
const PORTA = Number(process.env.AWIKA_BROKER_PORT ?? 8791);
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const ARQ_SETTINGS = path.join(DIR, 'settings-prova.json');
const ARQ_ESTADO = path.join(DIR, 'estado.json');
const ARQ_RELATORIO = path.join(DIR, `relatorio-${modo}.json`);
const LIMITE_TURNO_MS = (600 + ATRASO_S * 3) * 1000;

const log = (texto) => process.stdout.write(`${texto}\n`);

// --- Servidor de aprovação: faz o papel do celular -------------------------
let decisaoAtual = 'allow';
const pedidos = [];
const broker = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/pedido') {
    res.writeHead(404).end();
    return;
  }
  let corpo = '';
  req.on('data', (parte) => { corpo += parte; });
  req.on('end', () => {
    let pedido = {};
    try { pedido = JSON.parse(corpo); } catch { /* corpo ilegível vira pedido vazio */ }
    const registro = {
      ferramenta: pedido.tool_name ?? '(sem nome)',
      entrada: pedido.tool_input ?? null,
      decisao: decisaoAtual,
      recebidoEm: Date.now(),
    };
    pedidos.push(registro);
    log(`    pedido de aprovação: ${registro.ferramenta} ${JSON.stringify(registro.entrada)}`);
    log(`    resposta "${registro.decisao}" em ${ATRASO_S}s`);
    setTimeout(() => {
      registro.respondidoEm = Date.now();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        decisao: registro.decisao,
        motivo: registro.decisao === 'allow' ? 'aprovado pela prova' : 'negado pela prova',
      }));
    }, ATRASO_S * 1000);
  });
});

// --- Memória da árvore de processos do motor -------------------------------
function rssArvoreMb(raiz) {
  let pids;
  try {
    pids = readdirSync('/proc').filter((nome) => /^\d+$/.test(nome)).map(Number);
  } catch {
    return null;
  }
  const pai = new Map();
  const rssKb = new Map();
  for (const pid of pids) {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      pai.set(pid, Number(/^PPid:\s+(\d+)/m.exec(status)?.[1] ?? 0));
      rssKb.set(pid, Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0));
    } catch { /* o processo terminou entre a listagem e a leitura */ }
  }
  let totalKb = 0;
  for (const pid of pai.keys()) {
    let atual = pid;
    for (let salto = 0; salto < 64 && atual > 0; salto += 1) {
      if (atual === raiz) {
        totalKb += rssKb.get(pid) ?? 0;
        break;
      }
      atual = pai.get(atual) ?? 0;
    }
  }
  return totalKb / 1024;
}

// --- Um turno do motor ------------------------------------------------------
function rodarTurno({ prompt, retomar }) {
  return new Promise((resolve) => {
    const args = [
      ...BIN.slice(1),
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--settings', ARQ_SETTINGS,
      '--permission-mode', 'default',
    ];
    if (MODELO) args.push('--model', MODELO);
    if (retomar) args.push('--resume', retomar);

    const inicio = Date.now();
    const turno = {
      tipos: {},
      deltasDeTexto: 0,
      primeiroEventoMs: null,
      primeiroTextoMs: null,
      sessionId: null,
      resultado: null,
      texto: '',
      linhasIlegiveis: 0,
      picoRssMb: null,
      stderr: '',
      codigoSaida: null,
      estourouTempo: false,
    };

    const filho = spawn(BIN[0], args, {
      cwd: DIR,
      env: { ...process.env, AWIKA_BROKER_PORT: String(PORTA) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const amostrador = setInterval(() => {
      const mb = rssArvoreMb(filho.pid);
      if (mb !== null && (turno.picoRssMb === null || mb > turno.picoRssMb)) turno.picoRssMb = mb;
    }, 500);
    const relogio = setTimeout(() => {
      turno.estourouTempo = true;
      filho.kill('SIGKILL');
    }, LIMITE_TURNO_MS);

    const tratarLinha = (linha) => {
      if (!linha.trim()) return;
      let evento;
      try {
        evento = JSON.parse(linha);
      } catch {
        turno.linhasIlegiveis += 1;
        return;
      }
      const agora = Date.now() - inicio;
      if (turno.primeiroEventoMs === null) turno.primeiroEventoMs = agora;
      const tipo = evento.subtype ? `${evento.type}/${evento.subtype}` : String(evento.type);
      turno.tipos[tipo] = (turno.tipos[tipo] ?? 0) + 1;
      if (evento.session_id && !turno.sessionId) turno.sessionId = evento.session_id;
      if (evento.type === 'stream_event' && evento.event?.delta?.type === 'text_delta') {
        turno.deltasDeTexto += 1;
        if (turno.primeiroTextoMs === null) turno.primeiroTextoMs = agora;
      }
      if (evento.type === 'result') {
        turno.resultado = {
          subtype: evento.subtype ?? null,
          erro: evento.is_error ?? null,
          duracaoMs: evento.duration_ms ?? null,
          turnos: evento.num_turns ?? null,
          custoUsd: evento.total_cost_usd ?? null,
        };
        if (typeof evento.result === 'string') turno.texto = evento.result;
      }
    };

    let resto = '';
    filho.stdout.setEncoding('utf8');
    filho.stdout.on('data', (parte) => {
      resto += parte;
      const linhas = resto.split('\n');
      resto = linhas.pop() ?? '';
      linhas.forEach(tratarLinha);
    });
    filho.stderr.setEncoding('utf8');
    filho.stderr.on('data', (parte) => { turno.stderr = (turno.stderr + parte).slice(-2000); });

    const terminar = (codigo) => {
      clearInterval(amostrador);
      clearTimeout(relogio);
      tratarLinha(resto);
      turno.codigoSaida = codigo;
      turno.duracaoMs = Date.now() - inicio;
      resolve(turno);
    };
    filho.on('error', (erro) => {
      turno.stderr += `\nfalha ao iniciar o motor: ${erro.message}`;
      terminar(-1);
    });
    filho.on('close', terminar);
  });
}

const turnoOk = (turno) => turno.codigoSaida === 0
  && turno.resultado !== null
  && turno.resultado.erro !== true
  && !turno.estourouTempo;

const pareceSemLogin = (turno) => !turnoOk(turno)
  && /log ?in|authenticat|api key|oauth|credential|unauthorized|401/i.test(`${turno.texto}\n${turno.stderr}`);

function resumo(turno) {
  const mem = turno.picoRssMb === null ? 'n/d' : `${turno.picoRssMb.toFixed(0)} MB`;
  return `saída ${turno.codigoSaida}, ${(turno.duracaoMs / 1000).toFixed(1)}s, `
    + `1º evento ${turno.primeiroEventoMs ?? 'n/d'} ms, 1º texto ${turno.primeiroTextoMs ?? 'n/d'} ms, `
    + `pico ${mem}, eventos ${JSON.stringify(turno.tipos)}`;
}

// --- Testes -----------------------------------------------------------------
const testes = [];
function registrar(nome, passou, detalhe, turno) {
  testes.push({ nome, passou, detalhe, turno });
  log(`  ${passou ? 'PASSOU' : 'FALHOU'}: ${detalhe}`);
  if (turno) log(`    ${resumo(turno)}`);
  if (turno && !passou && turno.stderr.trim()) log(`    stderr: ${turno.stderr.trim().slice(-600)}`);
  if (turno && !passou && turno.texto) log(`    texto: ${turno.texto.slice(0, 300)}`);
}

async function testeStreaming() {
  log('\n[1] Resposta em eventos');
  const turno = await rodarTurno({ prompt: 'Conte de 1 a 20, um número por linha, sem mais nada.' });
  const passou = turnoOk(turno) && turno.deltasDeTexto >= 2;
  registrar('streaming', passou, `${turno.deltasDeTexto} trechos de texto antes do fim`, turno);
  return turno;
}

async function testeAprovacao(decisao) {
  const arquivo = path.join(DIR, decisao === 'allow' ? 'aprovado.txt' : 'negado.txt');
  log(`\n[${decisao === 'allow' ? 2 : 3}] Pedido de permissão respondido de fora: ${decisao === 'allow' ? 'aprovar' : 'negar'}`);
  rmSync(arquivo, { force: true });
  decisaoAtual = decisao;
  const antes = pedidos.length;
  const turno = await rodarTurno({
    prompt: `Use a ferramenta Bash para executar exatamente este comando: echo awika-ok > ${arquivo}\n`
      + 'Não use outra ferramenta nem outro comando. Depois responda só "feito"; se não for permitido, responda só "negado".',
  });
  const doTurno = pedidos.slice(antes);
  const esperaS = doTurno.length && doTurno[0].respondidoEm
    ? (doTurno[0].respondidoEm - doTurno[0].recebidoEm) / 1000
    : 0;
  const existe = existsSync(arquivo);
  const passou = turnoOk(turno) && doTurno.length >= 1 && existe === (decisao === 'allow');
  registrar(
    decisao === 'allow' ? 'aprovacao' : 'negacao',
    passou,
    `${doTurno.length} pedido(s), espera de ${esperaS.toFixed(0)}s, arquivo ${existe ? 'criado' : 'não criado'}`,
    turno,
  );
}

async function testeGuardar() {
  log('\n[4a] Guardar uma conversa para retomar depois');
  const palavra = `awika-${randomBytes(4).toString('hex')}`;
  const turno = await rodarTurno({
    prompt: `Guarde esta palavra-chave para depois: ${palavra}. Responda só "ok".`,
  });
  const passou = turnoOk(turno) && Boolean(turno.sessionId);
  if (passou) writeFileSync(ARQ_ESTADO, JSON.stringify({ sessionId: turno.sessionId, palavra }));
  registrar('guardar', passou, passou ? `sessão ${turno.sessionId} gravada` : 'sem id de sessão', turno);
}

async function testeRetomar() {
  log('\n[4b] Retomar a conversa depois de recriar o contêiner');
  if (!existsSync(ARQ_ESTADO)) {
    registrar('retomar', false, 'estado.json não existe; rode "tudo" antes', null);
    return;
  }
  const { sessionId, palavra } = JSON.parse(readFileSync(ARQ_ESTADO, 'utf8'));
  const turno = await rodarTurno({
    prompt: 'Qual é a palavra-chave que pedi para guardar? Responda só a palavra.',
    retomar: sessionId,
  });
  const passou = turnoOk(turno) && turno.texto.includes(palavra);
  registrar('retomar', passou, passou ? 'a palavra-chave voltou' : `esperava ${palavra}`, turno);
}

function lerPicoCgroupMb() {
  try {
    return Number(readFileSync('/sys/fs/cgroup/memory.peak', 'utf8').trim()) / 1048576;
  } catch {
    return null;
  }
}

// --- Execução ---------------------------------------------------------------
mkdirSync(DIR, { recursive: true });
writeFileSync(ARQ_SETTINGS, JSON.stringify({
  hooks: {
    PreToolUse: [{
      matcher: 'Bash|Write|Edit',
      hooks: [{ type: 'command', command: `node ${path.join(AQUI, 'hook-aprovacao.mjs')}`, timeout: 900 }],
    }],
  },
}, null, 2));

await new Promise((pronto) => { broker.listen(PORTA, '127.0.0.1', pronto); });
log(`Prova da etapa 0 — modo "${modo}", motor "${BIN.join(' ')}", espera de aprovação ${ATRASO_S}s`);

let codigoFinal = 0;
if (modo === 'tudo') {
  const primeiro = await testeStreaming();
  if (pareceSemLogin(primeiro)) {
    log('\nO motor recusou por falta de login. Faça o login (veja o LEIAME) e rode de novo.');
    codigoFinal = 2;
  } else {
    await testeAprovacao('allow');
    await testeAprovacao('deny');
    await testeGuardar();
  }
} else if (modo === 'retomar') {
  await testeRetomar();
} else {
  log(`Modo desconhecido: ${modo}. Use "tudo" ou "retomar".`);
  codigoFinal = 64;
}
broker.close();

const picoCgroupMb = lerPicoCgroupMb();
const picos = testes.map((t) => t.turno?.picoRssMb ?? 0);
const relatorio = {
  modo,
  motor: BIN.join(' '),
  esperaAprovacaoS: ATRASO_S,
  picoRssMotorMb: picos.length ? Math.max(...picos) : null,
  picoMemoriaConteinerMb: picoCgroupMb,
  testes,
};
writeFileSync(ARQ_RELATORIO, JSON.stringify(relatorio, null, 2));

log('\nResumo');
for (const teste of testes) log(`  ${teste.passou ? 'PASSOU' : 'FALHOU'}  ${teste.nome}`);
if (relatorio.picoRssMotorMb) log(`  pico de memória do motor: ${relatorio.picoRssMotorMb.toFixed(0)} MB`);
if (picoCgroupMb !== null) log(`  pico de memória do contêiner: ${picoCgroupMb.toFixed(0)} MB`);
log(`  relatório: ${ARQ_RELATORIO}`);

if (codigoFinal === 0 && (testes.length === 0 || testes.some((t) => !t.passou))) codigoFinal = 1;
process.exit(codigoFinal);
