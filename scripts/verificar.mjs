#!/usr/bin/env node
// Runbook `verificar` em forma de comando. Percorre os fluxos do mapa
// (docs/fluxos.md) pelo lado do servidor e sai com código diferente de zero
// se algo falhar.
//
// Sem variáveis: constrói o servidor, sobe o pacote de produção numa porta
// dedicada com o motor simulado e um banco descartável, e encerra no fim.
//
// Com AWIKA_VERIFICAR_BASE e AWIKA_VERIFICAR_CODIGO: usa um servidor que já
// está no ar, com o motor real, e um código de pareamento gerado nele. Gasta
// uso da conta do motor e deixa um bot de teste no banco desse servidor.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_EXTERNA = process.env.AWIKA_VERIFICAR_BASE;
const motorReal = Boolean(BASE_EXTERNA);
const PORTA = Number(process.env.AWIKA_VERIFICAR_PORTA ?? 8795);
const BASE = BASE_EXTERNA ?? `http://127.0.0.1:${PORTA}`;
const LIMITE_TURNO_MS = motorReal ? 120_000 : 8_000;
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
    await new Promise((ok) => { setTimeout(ok, 100); });
  }
  return false;
}

async function pedir(caminho, { metodo, corpo, token } = {}) {
  const resposta = await fetch(`${BASE}${caminho}`, {
    method: metodo ?? (corpo === undefined ? 'GET' : 'POST'),
    headers: {
      ...(corpo === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const texto = await resposta.text();
  return { status: resposta.status, corpo: texto ? JSON.parse(texto) : null };
}

/** Abre o fluxo de eventos e guarda o que chega, com o instante de cada evento. */
async function abrirEventos(token) {
  const controle = new AbortController();
  const resposta = await fetch(`${BASE}/v1/eventos`, {
    headers: { authorization: `Bearer ${token}` },
    signal: controle.signal,
  });
  const leitor = resposta.body.getReader();
  const decodificador = new TextDecoder();
  const eventos = [];
  let pendente = '';
  const ler = (async () => {
    try {
      for (;;) {
        const { done, value } = await leitor.read();
        if (done) return;
        pendente += decodificador.decode(value, { stream: true });
        const linhas = pendente.split('\n');
        pendente = linhas.pop() ?? '';
        for (const linha of linhas) {
          if (linha.startsWith('data: {')) eventos.push({ ...JSON.parse(linha.slice(6)), em: Date.now() });
        }
      }
    } catch { /* fluxo cancelado no encerramento */ }
  })();
  return {
    eventos,
    esperarEvento: (condicao, limiteMs = LIMITE_TURNO_MS) => esperar(() => eventos.some(condicao), limiteMs),
    fechar: async () => {
      controle.abort();
      await ler;
    },
  };
}

// 1. Subir (só no modo local).
let local = null;
if (!motorReal) {
  if (await responde()) {
    console.error(`FALHOU  a porta ${PORTA} já tem um servidor respondendo; encerre-o ou mude AWIKA_VERIFICAR_PORTA.`);
    process.exit(1);
  }
  const servidor = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'server');
  const build = spawnSync(process.execPath, ['build.mjs'], { cwd: servidor, encoding: 'utf8' });
  if (build.status !== 0) {
    console.error(build.stderr || build.stdout);
    console.error('FALHOU  build do servidor');
    process.exit(1);
  }
  const dados = mkdtempSync(path.join(os.tmpdir(), 'awikabot-verificar-'));
  const ambiente = {
    ...process.env,
    NODE_ENV: 'test',
    AWIKA_HOST: '127.0.0.1',
    AWIKA_PORTA: String(PORTA),
    AWIKA_DADOS: dados,
    AWIKA_MOTOR: 'simulado',
  };
  const processo = spawn(process.execPath, ['dist/server.mjs'], { cwd: servidor, env: ambiente, stdio: ['ignore', 'pipe', 'pipe'] });
  local = { servidor, dados, ambiente, processo, saida: '', saiu: new Promise((ok) => { processo.once('exit', ok); }) };
  processo.stdout.on('data', (parte) => { local.saida += parte; });
  processo.stderr.on('data', (parte) => { local.saida += parte; });
}

function codigoDePareamento() {
  if (motorReal) return process.env.AWIKA_VERIFICAR_CODIGO;
  const comando = spawnSync(process.execPath, ['dist/server.mjs', 'parear'], { cwd: local.servidor, env: local.ambiente, encoding: 'utf8' });
  return /[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}/.exec(comando.stdout ?? '')?.[0];
}

let fluxo = null;
try {
  // 2. Dirigir e 3. Observar.
  if (!(await esperar(responde, 10_000))) {
    registrar('F0', 'saúde do servidor', false, `sem resposta em ${BASE}/healthz; saída do servidor: ${local?.saida.trim() || '(não disponível)'}`);
  } else {
    const saude = await pedir('/healthz');
    registrar('F0', 'saúde do servidor', saude.status === 200 && saude.corpo.status === 'ok' && Number.isInteger(saude.corpo.protocolo),
      `status ${saude.status}, corpo ${JSON.stringify(saude.corpo)}`);

    // F1: parear.
    const codigo = codigoDePareamento();
    const pareado = codigo ? await pedir('/v1/parear', { corpo: { codigo, nome: 'Runbook' } }) : { status: 0, corpo: null };
    const token = pareado.corpo?.token;
    registrar('F1', 'parear com código do servidor', pareado.status === 200 && typeof token === 'string',
      `código ${codigo ? 'informado' : 'ausente'}, status ${pareado.status}`);
    const repetido = codigo ? await pedir('/v1/parear', { corpo: { codigo, nome: 'Outro' } }) : { status: 0 };
    registrar('F1', 'código não vale duas vezes', repetido.status === 401, `status ${repetido.status}`);
    const semToken = await pedir('/v1/bots');
    registrar('F1', 'rota protegida sem token', semToken.status === 401, `status ${semToken.status}`);

    if (typeof token === 'string') {
      fluxo = await abrirEventos(token);

      // F2: criar e editar um bot.
      const criado = await pedir('/v1/bots', { token, corpo: { nome: 'Scout', instrucoes: 'Responda em português, em uma frase curta.' } });
      const botId = criado.corpo?.id;
      registrar('F2', 'criar bot', criado.status === 201 && criado.corpo?.nome === 'Scout', `status ${criado.status}`);
      const editado = await pedir(`/v1/bots/${botId}`, { token, metodo: 'PATCH', corpo: { nome: 'Scout 2' } });
      const lista = await pedir('/v1/bots', { token });
      const naLista = lista.corpo?.bots?.find((bot) => bot.id === botId);
      registrar('F2', 'editar bot', editado.status === 200 && naLista?.nome === 'Scout 2', `status ${editado.status}, nome na lista "${naLista?.nome}"`);

      // F3: conversar com resposta aos poucos.
      const enviadoEm = Date.now();
      const turno = await pedir(`/v1/bots/${botId}/turnos`, { token, corpo: { texto: motorReal ? 'Diga olá e guarde o número 47 para depois.' : 'olá mundo' } });
      const terminou = await fluxo.esperarEvento((e) => e.tipo === 'turno_terminado');
      const trechos = fluxo.eventos.filter((e) => e.tipo === 'texto');
      const mensagens = await pedir(`/v1/bots/${botId}/mensagens`, { token });
      const resposta = mensagens.corpo?.mensagens?.[1];
      const textoOk = motorReal ? Boolean(resposta?.texto) : resposta?.texto === 'Você disse: olá mundo';
      registrar('F3', 'turno com resposta aos poucos',
        turno.status === 201 && terminou && trechos.length >= (motorReal ? 1 : 2) && textoOk && resposta?.estado === 'completa',
        `status ${turno.status}, ${trechos.length} trechos, primeiro em ${trechos[0] ? trechos[0].em - enviadoEm : 'n/d'} ms, `
        + `resposta (${resposta?.estado}) "${String(resposta?.texto).slice(0, 80)}"`);

      if (motorReal) {
        // A conversa continua na mesma sessão do motor.
        const antes = fluxo.eventos.length;
        await pedir(`/v1/bots/${botId}/turnos`, { token, corpo: { texto: 'Qual número eu pedi para guardar? Responda só o número.' } });
        await fluxo.esperarEvento((e) => e.tipo === 'turno_terminado' && fluxo.eventos.indexOf(e) >= antes);
        const depois = await pedir(`/v1/bots/${botId}/mensagens`, { token });
        const lembrou = depois.corpo?.mensagens?.[3];
        registrar('F3', 'o bot lembra do turno anterior', lembrou?.estado === 'completa' && String(lembrou?.texto).includes('47'),
          `resposta (${lembrou?.estado}) "${String(lembrou?.texto).slice(0, 80)}"`);
      }

      // F3: parar um turno.
      const marca = fluxo.eventos.length;
      const longo = motorReal
        ? 'Conte de 1 a 300, um número por linha, sem mais nada.'
        : Array.from({ length: 80 }, (_, i) => `palavra${i}`).join(' ');
      await pedir(`/v1/bots/${botId}/turnos`, { token, corpo: { texto: longo } });
      await fluxo.esperarEvento((e) => e.tipo === 'texto' && fluxo.eventos.indexOf(e) >= marca);
      const parar = await pedir(`/v1/bots/${botId}/turnos/atual/parar`, { token, metodo: 'POST' });
      const parou = await fluxo.esperarEvento((e) => e.tipo === 'turno_terminado' && e.mensagem.estado === 'parada', 15_000);
      registrar('F3', 'parar um turno', parar.status === 204 && parou, `status ${parar.status}, evento de parada ${parou ? 'recebido' : 'não recebido'}`);
    }
  }
} catch (erro) {
  registrar('--', 'execução do runbook', false, erro instanceof Error ? erro.message : String(erro));
} finally {
  // 4. Encerrar.
  if (fluxo) await fluxo.fechar();
  if (local) {
    local.processo.kill();
    await local.saiu;
    rmSync(local.dados, { recursive: true, force: true });
  }
}
if (local) {
  const portaLivre = await esperar(async () => !(await responde()), 5_000);
  registrar('--', 'encerramento', portaLivre, portaLivre ? `porta ${PORTA} liberada` : `porta ${PORTA} ainda responde`);
}

// 5. Relatar.
const falhas = resultados.filter((resultado) => !resultado.passou);
console.log(`\n${resultados.length - falhas.length} de ${resultados.length} verificações passaram em ${((Date.now() - inicio) / 1000).toFixed(1)}s, com o motor ${motorReal ? 'real' : 'simulado'}.`);
console.log(motorReal
  ? 'Não verificado por este comando: o app no aparelho; os fluxos F4 e F5, que ainda não existem.'
  : 'Não verificado por este comando: o app no aparelho; o motor real; os fluxos F4 e F5, que ainda não existem.');
process.exit(falhas.length === 0 ? 0 : 1);
