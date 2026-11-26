#!/usr/bin/env node
// Prova do passo 1 da etapa 7 (código descartável): dirige o Codex e o Antigravity sem tela e
// confere eventos, aprovação respondida por um programa de fora, as falhas desse programa e do
// gancho, gravação fora da pasta, troca de modelo e de esforço, retomada e memória.
//
//   node prova.mjs <codex|agy> tudo        todos os testes, menos a retomada
//   node prova.mjs <codex|agy> retomar     depois de recriar o contêiner
//   node prova.mjs <codex|agy> <teste>...  testes avulsos (ver a lista em TESTES)
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MOTOR = process.argv[2] ?? '';
const pedidosDeTeste = process.argv.slice(3);
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.env.AWIKA_TRABALHO ?? '/data/work';
const FORA = process.env.AWIKA_FORA ?? '/data/fora';
const REGISTROS = process.env.AWIKA_REGISTROS ?? '/data/registros';
const PORTA = Number(process.env.AWIKA_BROKER_PORT ?? 8791);
const CONTROLE = '/tmp/awika-gancho.json';
const DIARIO = '/tmp/awika-gancho.log';
// A chave da API do Gemini, guardada no volume por quem é dono dela (prova/guardar-chave.sh).
const ARQ_CHAVE_GEMINI = process.env.AWIKA_CHAVE_GEMINI ?? '/data/segredos/gemini-api-key';
const ATRASO_S = Number(process.env.AWIKA_ATRASO_APROVACAO ?? 5);
// Prazo que o motor dá ao gancho, em segundos, e o prazo do próprio gancho, que fica abaixo dele.
const PRAZO_MOTOR_S = Number(process.env.AWIKA_PRAZO_MOTOR ?? 40);
const PRAZO_GANCHO_MS = Number(process.env.AWIKA_PRAZO_GANCHO_MS ?? 15_000);
const LIMITE_TURNO_MS = Number(process.env.AWIKA_LIMITE_TURNO_S ?? 420) * 1000;

const OPCOES = {
  codex: {
    // danger-full-access: sem a caixa de areia do Codex, que não sobe no contêiner sem privilégios.
    sandbox: process.env.AWIKA_CODEX_SANDBOX ?? 'danger-full-access',
    aprovacao: process.env.AWIKA_CODEX_APROVACAO ?? 'on-request',
    // Qual evento de gancho consulta o servidor: PreToolUse, PermissionRequest ou os dois.
    ganchos: (process.env.AWIKA_CODEX_GANCHOS ?? 'PreToolUse').split(',').filter(Boolean),
    // "usuario" grava em $CODEX_HOME/hooks.json e pede --dangerously-bypass-hook-trust;
    // "sistema" espera o arquivo já montado em /etc/codex/hooks.json.
    origemDoGancho: process.env.AWIKA_CODEX_ORIGEM_GANCHO ?? 'usuario',
    modeloA: process.env.AWIKA_MODELO_A ?? '',
    modeloB: process.env.AWIKA_MODELO_B ?? '',
    esforcoA: process.env.AWIKA_ESFORCO_A ?? 'low',
    esforcoB: process.env.AWIKA_ESFORCO_B ?? 'high',
  },
  agy: {
    modeloA: process.env.AWIKA_MODELO_A ?? '',
    modeloB: process.env.AWIKA_MODELO_B ?? '',
    esforcoA: process.env.AWIKA_ESFORCO_A ?? 'low',
    esforcoB: process.env.AWIKA_ESFORCO_B ?? 'high',
    extras: (process.env.AWIKA_AGY_EXTRAS ?? '').split(' ').filter(Boolean),
  },
};

const log = (texto) => process.stdout.write(`${texto}\n`);

// --- Servidor de aprovação: faz o papel do servidor do awikabot e do celular -----------------
// modo: allow | deny | mudo (nunca responde) | lixo (responde algo ilegível)
let brokerModo = 'allow';
let brokerAtrasoS = ATRASO_S;
const pedidos = [];
const broker = createServer((req, res) => {
  let corpo = '';
  req.on('data', (parte) => { corpo += parte; });
  req.on('end', () => {
    let lido = {};
    try { lido = JSON.parse(corpo); } catch { /* corpo ilegível vira pedido vazio */ }
    const p = lido.pedido ?? {};
    const registro = {
      evento: lido.evento ?? null,
      ferramenta: p.tool_name ?? p.toolCall?.name ?? '(sem nome)',
      entrada: p.tool_input ?? p.toolCall?.args ?? null,
      modo: brokerModo,
      recebidoEm: Date.now(),
    };
    pedidos.push(registro);
    log(`    pedido: ${registro.evento} ${registro.ferramenta} ${JSON.stringify(registro.entrada).slice(0, 200)} -> ${brokerModo}`);
    if (brokerModo === 'mudo') return;
    setTimeout(() => {
      registro.respondidoEm = Date.now();
      if (brokerModo === 'lixo') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('<html>502 Bad Gateway');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ decisao: registro.modo, motivo: registro.modo === 'allow' ? 'aprovado pela prova' : 'negado pela prova' }));
    }, brokerAtrasoS * 1000);
  });
});
let brokerNoAr = false;
const subirBroker = () => new Promise((ok) => { broker.listen(PORTA, '127.0.0.1', () => { brokerNoAr = true; ok(); }); });
const derrubarBroker = () => new Promise((ok) => {
  if (!brokerNoAr) { ok(); return; }
  broker.close(() => { brokerNoAr = false; ok(); });
  broker.closeAllConnections();
});

function controlarGancho({ defeito = '', porta = PORTA, prazoMs = PRAZO_GANCHO_MS } = {}) {
  writeFileSync(CONTROLE, JSON.stringify({ porta, prazoMs, defeito }));
}
const lerDiario = () => { try { return readFileSync(DIARIO, 'utf8'); } catch { return ''; } };

// --- Memória da árvore de processos do motor ---------------------------------------------------
function rssArvoreMb(raiz) {
  let pids;
  try { pids = readdirSync('/proc').filter((nome) => /^\d+$/.test(nome)).map(Number); } catch { return null; }
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
      if (atual === raiz) { totalKb += rssKb.get(pid) ?? 0; break; }
      atual = pai.get(atual) ?? 0;
    }
  }
  return totalKb / 1024;
}

// --- Configuração do gancho em cada motor ------------------------------------------------------
function instalarGanchos() {
  const comando = `node ${path.join(AQUI, 'gancho.mjs')} ${MOTOR}`;
  if (MOTOR === 'codex') {
    if (OPCOES.codex.origemDoGancho !== 'usuario') return;
    const hooks = {};
    for (const evento of OPCOES.codex.ganchos) {
      hooks[evento] = [{ hooks: [{ type: 'command', command: comando, timeout: PRAZO_MOTOR_S }] }];
    }
    writeFileSync(path.join(process.env.CODEX_HOME, 'hooks.json'), JSON.stringify({ hooks }, null, 2));
  } else {
    // Com a chave no volume, o agy fala direto com a API do Gemini e não abre sessão de conta.
    const ajustes = path.join(process.env.HOME, '.gemini', 'antigravity-cli');
    mkdirSync(ajustes, { recursive: true });
    const arquivo = path.join(ajustes, 'settings.json');
    let atuais = {};
    try { atuais = JSON.parse(readFileSync(arquivo, 'utf8')); } catch { /* ainda não existe */ }
    if (existsSync(ARQ_CHAVE_GEMINI)) atuais.modelProvider = 'gemini'; else delete atuais.modelProvider;
    writeFileSync(arquivo, JSON.stringify(atuais, null, 2), { mode: 0o600 });
    const pasta = path.join(process.env.HOME, '.gemini', 'config');
    mkdirSync(pasta, { recursive: true });
    writeFileSync(path.join(pasta, 'hooks.json'), JSON.stringify({
      hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: comando, timeout: PRAZO_MOTOR_S }] }] },
    }, null, 2));
  }
}

// O ambiente do motor. A chave só vai ao processo do agy, e nunca é escrita em log nem em registro.
function ambienteDoMotor() {
  const ambiente = { ...process.env };
  if (MOTOR === 'agy' && existsSync(ARQ_CHAVE_GEMINI)) ambiente.GEMINI_API_KEY = readFileSync(ARQ_CHAVE_GEMINI, 'utf8').trim();
  return ambiente;
}

// --- A linha de comando de um turno -------------------------------------------------------------
function chamada({ prompt, sessao, modelo, esforco }) {
  if (MOTOR === 'codex') {
    const o = OPCOES.codex;
    const args = ['exec', '--json', '--skip-git-repo-check', '-C', DIR, '-s', o.sandbox, '-c', `approval_policy="${o.aprovacao}"`];
    if (o.origemDoGancho === 'usuario') args.push('--dangerously-bypass-hook-trust');
    if (modelo) args.push('-m', modelo);
    if (esforco) args.push('-c', `model_reasoning_effort="${esforco}"`);
    if (sessao) args.push('resume', sessao);
    args.push('-');
    return { bin: 'codex', args, stdin: prompt };
  }
  const args = ['-p', prompt, '--output-format', 'stream-json', ...OPCOES.agy.extras];
  if (modelo) args.push('--model', modelo);
  if (esforco) args.push('--effort', esforco);
  if (sessao) args.push('--conversation', sessao);
  return { bin: 'agy', args, stdin: '' };
}

// --- Leitura dos eventos de cada motor ----------------------------------------------------------
function lerEvento(evento, turno, agoraMs) {
  if (MOTOR === 'codex') {
    const tipo = evento.item?.type ? `${evento.type}:${evento.item.type}` : String(evento.type);
    turno.tipos[tipo] = (turno.tipos[tipo] ?? 0) + 1;
    if (evento.type === 'thread.started' && evento.thread_id) turno.sessao = evento.thread_id;
    if (evento.item?.type === 'agent_message') {
      turno.eventosDeTexto += 1;
      turno.temposDeTextoMs.push(agoraMs);
      if (evento.type === 'item.completed' && typeof evento.item.text === 'string') turno.texto += (turno.texto ? '\n' : '') + evento.item.text;
    }
    if (evento.type === 'turn.completed') { turno.fim = 'completo'; turno.uso = evento.usage ?? null; }
    if (evento.type === 'turn.failed' || evento.type === 'error') { turno.fim = turno.fim ?? 'falhou'; turno.erro = evento.error?.message ?? evento.message ?? null; }
    return;
  }
  const corpo = evento.step_update ?? evento.result ?? evento.init ?? {};
  const nome = String(evento.event ?? evento.type ?? Object.keys(evento)[0]);
  const tipo = corpo.step_type ? `${nome}:${corpo.step_type}:${corpo.state ?? ''}` : nome;
  turno.tipos[tipo] = (turno.tipos[tipo] ?? 0) + 1;
  if (corpo.conversation_id) turno.sessao = corpo.conversation_id;
  if (nome === 'init') turno.inicio = corpo;
  if (typeof corpo.text_delta === 'string' && corpo.text_delta !== '') {
    turno.eventosDeTexto += 1;
    turno.temposDeTextoMs.push(agoraMs);
  }
  if (nome === 'result') {
    turno.fim = corpo.status === 'SUCCESS' ? 'completo' : 'falhou';
    turno.texto = String(corpo.response ?? '');
    turno.erro = corpo.error ?? null;
    turno.uso = corpo.usage ?? null;
  }
}

// --- Um turno do motor ---------------------------------------------------------------------------
let numeroDoTurno = 0;
function rodarTurno(nome, pedido) {
  return new Promise((resolve) => {
    const { bin, args, stdin } = chamada(pedido);
    numeroDoTurno += 1;
    const arquivo = path.join(REGISTROS, `${MOTOR}-${String(numeroDoTurno).padStart(2, '0')}-${nome}.jsonl`);
    const bruto = [];
    const inicio = Date.now();
    const turno = {
      nome, args: args.map((a) => (a === pedido.prompt ? '<prompt>' : a)), tipos: {}, eventosDeTexto: 0, temposDeTextoMs: [],
      primeiroEventoMs: null, sessao: null, fim: null, erro: null, uso: null, texto: '', linhasIlegiveis: 0,
      picoRssMb: null, stderr: '', codigoSaida: null, estourouTempo: false,
    };
    const filho = spawn(bin, args, { cwd: DIR, env: ambienteDoMotor(), stdio: ['pipe', 'pipe', 'pipe'] });
    const amostrador = setInterval(() => {
      const mb = rssArvoreMb(filho.pid);
      if (mb !== null && (turno.picoRssMb === null || mb > turno.picoRssMb)) turno.picoRssMb = mb;
    }, 250);
    const relogio = setTimeout(() => { turno.estourouTempo = true; filho.kill('SIGKILL'); }, LIMITE_TURNO_MS);

    const tratarLinha = (linha) => {
      if (!linha.trim()) return;
      const agora = Date.now() - inicio;
      bruto.push(`${agora}\t${linha}`);
      let evento;
      try { evento = JSON.parse(linha); } catch { turno.linhasIlegiveis += 1; return; }
      if (turno.primeiroEventoMs === null) turno.primeiroEventoMs = agora;
      lerEvento(evento, turno, agora);
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
    filho.stderr.on('data', (parte) => { turno.stderr = (turno.stderr + parte).slice(-3000); });
    filho.stdin.on('error', () => {});
    filho.stdin.end(stdin);

    const terminar = (codigo) => {
      clearInterval(amostrador);
      clearTimeout(relogio);
      tratarLinha(resto);
      turno.codigoSaida = codigo;
      turno.duracaoMs = Date.now() - inicio;
      writeFileSync(arquivo, `${bruto.join('\n')}\n--- stderr ---\n${turno.stderr}\n`);
      resolve(turno);
    };
    filho.on('error', (erro) => { turno.stderr += `\nfalha ao iniciar o motor: ${erro.message}`; terminar(-1); });
    filho.on('close', terminar);
  });
}

const turnoOk = (t) => t.codigoSaida === 0 && t.fim === 'completo' && !t.estourouTempo;

function resumo(t) {
  const mem = t.picoRssMb === null ? 'n/d' : `${t.picoRssMb.toFixed(0)} MB`;
  const textos = t.temposDeTextoMs.length ? `textos em ${t.temposDeTextoMs.slice(0, 6).join(', ')} ms` : 'sem texto';
  return `saída ${t.codigoSaida}, fim ${t.fim}, ${(t.duracaoMs / 1000).toFixed(1)}s, 1º evento ${t.primeiroEventoMs ?? 'n/d'} ms, ${textos}, pico ${mem}, eventos ${JSON.stringify(t.tipos)}`;
}

// --- Testes ---------------------------------------------------------------------------------------
const resultados = [];
function registrar(nome, passou, detalhe, turno) {
  resultados.push({ nome, passou, detalhe, turno });
  log(`  ${passou === null ? 'OBSERVADO' : passou ? 'PASSOU' : 'FALHOU'}: ${detalhe}`);
  if (turno) log(`    ${resumo(turno)}`);
  if (turno && turno.texto) log(`    texto: ${turno.texto.replace(/\s+/g, ' ').slice(0, 240)}`);
  if (turno && (passou === false || turno.erro) && turno.stderr.trim()) log(`    stderr: ${turno.stderr.trim().slice(-500)}`);
  if (turno?.erro) log(`    erro: ${String(turno.erro).slice(0, 300)}`);
}

const pedirComando = (arquivo) => `Rode no terminal exatamente este comando, sem alterar nada: echo awika-ok > ${arquivo}\n`
  + 'Não use outra ferramenta nem outro comando, e não tente de novo se for recusado. Depois responda só "feito"; se não for permitido, responda só "negado".';

async function testeEventos() {
  log('\n[eventos] A resposta sai em eventos, aos poucos');
  controlarGancho();
  const t = await rodarTurno('eventos', { prompt: 'Escreva os números de 1 a 60, um por linha, cada um seguido da palavra "linha". Não use ferramentas.', modelo: OPCOES[MOTOR].modeloA });
  const espalhados = t.temposDeTextoMs.length >= 2 && (t.temposDeTextoMs.at(-1) - t.temposDeTextoMs[0]) > 200;
  registrar('eventos', turnoOk(t) && espalhados, `${t.eventosDeTexto} evento(s) de texto; ${espalhados ? 'chegam espalhados no tempo' : 'o texto chega de uma vez'}`, t);
}

// Um turno que pede um comando, com o servidor de aprovação e o gancho num estado dado.
async function testeComando(nome, titulo, { modo = 'allow', atrasoS = ATRASO_S, noAr = true, defeito = '', espera }) {
  log(`\n[${nome}] ${titulo}`);
  const arquivo = path.join(DIR, `${nome}.txt`);
  rmSync(arquivo, { force: true });
  brokerModo = modo;
  brokerAtrasoS = atrasoS;
  if (noAr) await subirBrokerSeFaltar(); else await derrubarBroker();
  controlarGancho({ defeito });
  const antes = pedidos.length;
  const diarioAntes = lerDiario().length;
  const t = await rodarTurno(nome, { prompt: pedirComando(arquivo), modelo: OPCOES[MOTOR].modeloA });
  const doTurno = pedidos.slice(antes);
  const ganchoChamado = lerDiario().slice(diarioAntes).includes('chamado');
  const criado = existsSync(arquivo);
  const esperaS = doTurno[0]?.respondidoEm ? ((doTurno[0].respondidoEm - doTurno[0].recebidoEm) / 1000).toFixed(0) : '-';
  const detalhe = `gancho ${ganchoChamado ? 'chamado' : 'NÃO chamado'}, ${doTurno.length} pedido(s) ao servidor, espera ${esperaS}s, arquivo ${criado ? 'CRIADO' : 'não criado'}`;
  const passou = ganchoChamado && criado === (espera === 'criado');
  registrar(nome, passou, detalhe, t);
  await subirBrokerSeFaltar();
}
const subirBrokerSeFaltar = async () => { if (!brokerNoAr) await subirBroker(); };

async function testeForaDaPasta() {
  log('\n[fora-da-pasta] Gravar fora da pasta de trabalho, com o servidor aprovando tudo');
  // O servidor aprova de propósito: o que se mede é a trava do próprio motor, não a política.
  brokerModo = 'allow';
  brokerAtrasoS = 0;
  controlarGancho();
  for (const [via, instrucao] of [
    ['edicao', 'Crie o arquivo ARQ com o conteúdo "awika-fora", usando a sua ferramenta de edição de arquivos, não o terminal.'],
    ['terminal', 'Rode no terminal exatamente: echo awika-fora > ARQ'],
  ]) {
    const arquivo = path.join(FORA, `fora-${via}.txt`);
    rmSync(arquivo, { force: true });
    const antes = pedidos.length;
    const t = await rodarTurno(`fora-${via}`, {
      prompt: `${instrucao.replace('ARQ', arquivo)}\nNão tente outro caminho se for recusado. Responda só "feito" ou "negado".`,
      modelo: OPCOES[MOTOR].modeloA,
    });
    const criado = existsSync(arquivo);
    const vistos = pedidos.slice(antes).map((p) => `${p.evento}:${p.ferramenta}`).join(', ') || 'nenhum';
    registrar(`fora-${via}`, !criado, `pela ${via}: arquivo ${criado ? 'CRIADO fora da pasta' : 'não criado'}; pedidos: ${vistos}`, t);
  }
}

const ARQ_ESTADO = path.join(REGISTROS, `estado-${MOTOR}.json`);

async function testeGuardarETrocar() {
  const o = OPCOES[MOTOR];
  log(`\n[guardar] Guardar uma palavra com o modelo "${o.modeloA || 'padrão'}" e esforço "${o.esforcoA}"`);
  controlarGancho();
  const palavra = `awika-${randomBytes(4).toString('hex')}`;
  const a = await rodarTurno('guardar', { prompt: `Guarde esta palavra-chave para depois: ${palavra}. Responda só "ok". Não use ferramentas.`, modelo: o.modeloA, esforco: o.esforcoA });
  const guardou = turnoOk(a) && Boolean(a.sessao);
  registrar('guardar', guardou, guardou ? `sessão ${a.sessao}` : 'sem id de sessão', a);
  if (!guardou) return;
  writeFileSync(ARQ_ESTADO, JSON.stringify({ sessao: a.sessao, palavra }));

  log(`\n[trocar] Mesma conversa, agora com o modelo "${o.modeloB || 'padrão'}" e esforço "${o.esforcoB}"`);
  const b = await rodarTurno('trocar', { prompt: 'Qual é a palavra-chave que pedi para guardar? Responda só a palavra.', sessao: a.sessao, modelo: o.modeloB, esforco: o.esforcoB });
  const voltou = turnoOk(b) && b.texto.includes(palavra);
  registrar('trocar', voltou, `${voltou ? 'a palavra voltou' : `esperava ${palavra}`}; sessão ${b.sessao === a.sessao ? 'a mesma' : `mudou para ${b.sessao}`}; uso A ${JSON.stringify(a.uso)}; uso B ${JSON.stringify(b.uso)}`, b);
}

async function testeRetomar() {
  log('\n[retomar] Retomar a conversa depois de recriar o contêiner');
  if (!existsSync(ARQ_ESTADO)) { registrar('retomar', false, `${ARQ_ESTADO} não existe; rode "guardar" antes`, null); return; }
  controlarGancho();
  const { sessao, palavra } = JSON.parse(readFileSync(ARQ_ESTADO, 'utf8'));
  const t = await rodarTurno('retomar', { prompt: 'Qual é a palavra-chave que pedi para guardar no começo? Responda só a palavra.', sessao });
  const voltou = turnoOk(t) && t.texto.includes(palavra);
  registrar('retomar', voltou, voltou ? 'a palavra-chave voltou' : `esperava ${palavra}`, t);
}

const TESTES = {
  eventos: testeEventos,
  aprovar: () => testeComando('aprovar', 'O servidor aprova depois de uma espera', { modo: 'allow', espera: 'criado' }),
  negar: () => testeComando('negar', 'O servidor nega', { modo: 'deny', espera: 'ausente' }),
  'fora-do-ar': () => testeComando('fora-do-ar', 'O servidor de aprovação está fora do ar', { noAr: false, espera: 'ausente' }),
  demora: () => testeComando('demora', `O servidor não responde; o gancho desiste em ${PRAZO_GANCHO_MS / 1000}s`, { modo: 'mudo', espera: 'ausente' }),
  ilegivel: () => testeComando('ilegivel', 'O servidor devolve algo ilegível', { modo: 'lixo', atrasoS: 0, espera: 'ausente' }),
  // Daqui para baixo o defeito é do próprio gancho: mede-se o motor.
  'gancho-sai1': () => testeComando('gancho-sai1', 'O gancho sai com código 1', { defeito: 'sai1', espera: 'ausente' }),
  'gancho-lixo': () => testeComando('gancho-lixo', 'O gancho imprime algo que não é JSON', { defeito: 'lixo', espera: 'ausente' }),
  'gancho-mudo': () => testeComando('gancho-mudo', 'O gancho sai com 0 sem dizer nada', { defeito: 'mudo', espera: 'ausente' }),
  'gancho-trava': () => testeComando('gancho-trava', `O gancho trava; o motor o corta em ${PRAZO_MOTOR_S}s`, { defeito: 'trava', espera: 'ausente' }),
  'fora-da-pasta': testeForaDaPasta,
  guardar: testeGuardarETrocar,
  retomar: testeRetomar,
};
const TUDO = ['eventos', 'aprovar', 'negar', 'fora-do-ar', 'demora', 'ilegivel', 'gancho-sai1', 'gancho-lixo', 'gancho-mudo', 'gancho-trava', 'fora-da-pasta', 'guardar'];

// --- Execução --------------------------------------------------------------------------------------
if (!OPCOES[MOTOR]) { log('Uso: node prova.mjs <codex|agy> <tudo|retomar|teste...>'); process.exit(64); }
const lista = pedidosDeTeste.length === 0 || pedidosDeTeste[0] === 'tudo' ? TUDO : pedidosDeTeste;
const desconhecido = lista.find((nome) => !TESTES[nome]);
if (desconhecido) { log(`Teste desconhecido: ${desconhecido}. Testes: ${Object.keys(TESTES).join(', ')}`); process.exit(64); }

mkdirSync(DIR, { recursive: true });
mkdirSync(REGISTROS, { recursive: true });
instalarGanchos();
await subirBroker();
log(`Prova do passo 1 da etapa 7 — motor "${MOTOR}", testes: ${lista.join(', ')}`);
log(`  opções: ${JSON.stringify(OPCOES[MOTOR])}`);
if (MOTOR === 'agy') log(`  acesso: ${existsSync(ARQ_CHAVE_GEMINI) ? 'chave da API do Gemini, lida do volume' : 'conta guardada pelo próprio agy'}`);
for (const nome of lista) await TESTES[nome]();
await derrubarBroker();

let picoCgroupMb = null;
try { picoCgroupMb = Number(readFileSync('/sys/fs/cgroup/memory.peak', 'utf8').trim()) / 1048576; } catch { /* sem cgroup v2 */ }
const picos = resultados.map((r) => r.turno?.picoRssMb ?? 0);
const relatorio = { motor: MOTOR, opcoes: OPCOES[MOTOR], picoRssMotorMb: picos.length ? Math.max(...picos) : null, picoMemoriaConteinerMb: picoCgroupMb, resultados };
const arquivoRelatorio = path.join(REGISTROS, `relatorio-${MOTOR}-${Date.now()}.json`);
writeFileSync(arquivoRelatorio, JSON.stringify(relatorio, null, 2));

log('\nResumo');
for (const r of resultados) log(`  ${r.passou === null ? 'OBSERVADO' : r.passou ? 'PASSOU' : 'FALHOU'}  ${r.nome}: ${r.detalhe}`);
if (relatorio.picoRssMotorMb) log(`  pico de memória do motor (árvore de processos): ${relatorio.picoRssMotorMb.toFixed(0)} MB`);
if (picoCgroupMb !== null) log(`  pico de memória do contêiner: ${picoCgroupMb.toFixed(0)} MB`);
log(`  relatório: ${arquivoRelatorio}`);
process.exit(resultados.some((r) => r.passou === false) ? 1 : 0);
