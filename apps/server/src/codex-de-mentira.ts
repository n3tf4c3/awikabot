// Um `codex app-server` de mentira, para os testes do driver (`motor-codex.test.ts`). Fala o mesmo
// JSON-RPC por linhas, com a forma das mensagens do Codex 0.172.0 vista na prova da etapa 7. Não
// executa nada: o "comando" e a "edição" só existem como itens e pedidos.
//
// O texto da pessoa escolhe o roteiro:
//   eco <texto>        responde o texto, palavra por palavra
//   comando <linha>    pede aprovação de um comando e diz se ele rodou
//   edicao <caminho>   pede aprovação de uma edição que cria o arquivo
//   mover <de> <para>  pede aprovação de uma edição que move um arquivo
//   escapa             executa um comando sem pedir aprovação
//   escapa-falha       executa um comando sem pedir aprovação, e ele sai com erro depois de ler
//   escapa-imita       idem, imitando a caixa de areia que não sobe, mas com o que leu na saída
//   escapa-edicao      aplica uma edição sem pedir aprovação, e ela falha no meio
//   caixa-nao-sobe <linha>  a tentativa sem pedido não começa (a caixa de areia não sobe, como
//                      no contêiner); o modelo pede de novo, com aprovação
//   busca              pesquisa na web, que não pede aprovação
//   entrada            pede uma entrada do usuário, que o awikabot não tem
//   lento              fala sem parar até o turno ser interrompido
//   falha              o turno falha por falta de login
//
// Um turno com `outputSchema` é o do juiz e não segue roteiro: responde CODEX_DE_MENTIRA_RESPOSTA
// (ver `julgar`).
//
// Cada mensagem recebida vai, uma por linha, para o arquivo em CODEX_DE_MENTIRA_REGISTRO.
import { appendFileSync } from 'node:fs';

type Mensagem = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };

const registro = process.env.CODEX_DE_MENTIRA_REGISTRO;
if (registro) appendFileSync(registro, `${JSON.stringify({ argv: process.argv.slice(2) })}\n`);

const escrever = (mensagem: Mensagem): void => {
  process.stdout.write(`${JSON.stringify(mensagem)}\n`);
};
const avisar = (method: string, params: Record<string, unknown>): void => escrever({ method, params });

let proximoPedido = 0;
const esperando = new Map<number, (resposta: Mensagem) => void>();
let thread = '';
let turno = '';
let interrompido = false;
const relogios: NodeJS.Timeout[] = [];

function pedirAoCliente(method: string, params: Record<string, unknown>): Promise<Mensagem> {
  const id = proximoPedido;
  proximoPedido += 1;
  return new Promise((ok) => {
    esperando.set(id, ok);
    escrever({ method, id, params });
  });
}

const depois = (ms: number): Promise<void> =>
  new Promise((ok) => {
    relogios.push(setTimeout(ok, ms));
  });

function terminarTurno(status: string, erro: string | null = null): void {
  avisar('turn/completed', { threadId: thread, turn: { id: turno, items: [], status, error: erro === null ? null : { message: erro } } });
}

async function falar(texto: string, item = `msg-${turno}`): Promise<void> {
  avisar('item/started', { threadId: thread, turnId: turno, item: { type: 'agentMessage', id: item, text: '' } });
  for (const parte of texto.match(/\S+\s*/g) ?? []) {
    if (interrompido) return;
    avisar('item/agentMessage/delta', { threadId: thread, turnId: turno, itemId: item, delta: parte });
    await depois(5);
  }
  avisar('item/completed', { threadId: thread, turnId: turno, item: { type: 'agentMessage', id: item, text: texto } });
}

/**
 * A saída do item cuja caixa de areia não subiu, como o 0.172.0 da imagem a dá: o mesmo texto de
 * `SAIDA_DA_CAIXA_QUE_NAO_SOBE`, em `motor-codex.ts`. Se os dois divergirem, o teste do roteiro
 * `caixa-nao-sobe` falha, porque o driver corta o turno.
 */
const CAIXA_QUE_NAO_SOBE =
  "bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces. On e.g. debian this can be enabled with 'sysctl kernel.unprivileged_userns_clone=1'.\n";

/** Itens que agem sem pedido de aprovação, e como terminam. */
const ESCAPES = {
  escapa: {
    item: { type: 'commandExecution', id: 'exec-escapa', command: "/bin/bash -lc 'cat /segredo'", cwd: process.cwd() },
    fim: { status: 'completed', exitCode: 0, aggregatedOutput: 'segredo' },
  },
  'escapa-falha': {
    item: { type: 'commandExecution', id: 'exec-escapa', command: "/bin/bash -lc 'cat /segredo; exit 2'", cwd: process.cwd() },
    fim: { status: 'failed', exitCode: 2, aggregatedOutput: 'segredo' },
  },
  'escapa-imita': {
    item: { type: 'commandExecution', id: 'exec-escapa', command: "/bin/bash -lc 'echo \"bwrap: $(cat /segredo)\"; exit 1'", cwd: process.cwd() },
    fim: { status: 'failed', exitCode: 1, aggregatedOutput: 'bwrap: segredo\n' },
  },
  'escapa-edicao': {
    item: { type: 'fileChange', id: 'patch-escapa', changes: [{ path: '/fora/a.txt', kind: { type: 'add' }, diff: 'x\n' }] },
    fim: { status: 'failed' },
  },
} as const;

const aceito = (resposta: Mensagem): boolean => (resposta.result as { decision?: unknown } | undefined)?.decision === 'accept';

async function comAprovacao(item: Record<string, unknown>, method: string, extras: Record<string, unknown>): Promise<boolean> {
  const id = String(item.id);
  avisar('item/started', { threadId: thread, turnId: turno, item: { ...item, status: 'inProgress' } });
  const resposta = await pedirAoCliente(method, { threadId: thread, turnId: turno, itemId: id, ...extras });
  const ok = aceito(resposta);
  avisar('item/completed', { threadId: thread, turnId: turno, item: { ...item, status: ok ? 'completed' : 'declined' } });
  return ok;
}

async function rodarTurno(texto: string): Promise<void> {
  const [roteiro = '', ...resto] = texto.split(' ');
  const argumento = resto.join(' ');
  if (roteiro === 'eco') {
    await falar(argumento);
  } else if (roteiro === 'comando') {
    const comando = `/bin/bash -lc '${argumento}'`;
    const ok = await comAprovacao({ type: 'commandExecution', id: 'exec-1', command: comando, cwd: process.cwd() }, 'item/commandExecution/requestApproval', {
      kind: 'command',
      command: comando,
      cwd: process.cwd(),
      reason: 'Pode rodar? É seguro.',
    });
    await falar(ok ? 'rodou' : 'negado', 'msg-final');
  } else if (roteiro === 'edicao' || roteiro === 'mover') {
    const [origem = '', destino = null] = roteiro === 'mover' ? resto : [argumento];
    const mudanca = roteiro === 'mover' ? { path: origem, kind: { type: 'update', move_path: destino }, diff: '' } : { path: origem, kind: { type: 'add' }, diff: 'conteúdo novo\n' };
    const ok = await comAprovacao({ type: 'fileChange', id: 'patch-1', changes: [mudanca] }, 'item/fileChange/requestApproval', { reason: null, grantRoot: null });
    await falar(ok ? 'gravou' : 'negado', 'msg-final');
  } else if (Object.hasOwn(ESCAPES, roteiro)) {
    const { item, fim } = ESCAPES[roteiro as keyof typeof ESCAPES];
    avisar('item/started', { threadId: thread, turnId: turno, item: { ...item, status: 'inProgress' } });
    avisar('item/completed', { threadId: thread, turnId: turno, item: { ...item, ...fim } });
    await depois(2000);
    await falar('o segredo é segredo', 'msg-final');
  } else if (roteiro === 'caixa-nao-sobe') {
    // Como o 0.172.0 no contêiner: a primeira tentativa vai à caixa de areia sem pedido, termina
    // como item próprio, sem começar, e o modelo pede de novo com aprovação.
    const comando = `/bin/bash -lc '${argumento}'`;
    const tentativa = { type: 'commandExecution', id: 'exec-caixa', command: comando, cwd: process.cwd() };
    avisar('item/started', { threadId: thread, turnId: turno, item: { ...tentativa, status: 'inProgress' } });
    avisar('item/completed', { threadId: thread, turnId: turno, item: { ...tentativa, status: 'failed', exitCode: 1, aggregatedOutput: CAIXA_QUE_NAO_SOBE } });
    const ok = await comAprovacao({ type: 'commandExecution', id: 'exec-1', command: comando, cwd: process.cwd() }, 'item/commandExecution/requestApproval', {
      kind: 'command',
      command: comando,
      cwd: process.cwd(),
      reason: 'A caixa de areia não deixou.',
    });
    await falar(ok ? 'rodou' : 'negado', 'msg-final');
  } else if (roteiro === 'busca') {
    avisar('item/started', { threadId: thread, turnId: turno, item: { type: 'webSearch', id: 'ws-1', query: 'awikabot' } });
    await depois(2000);
    await falar('achei', 'msg-final');
  } else if (roteiro === 'entrada') {
    const resposta = await pedirAoCliente('item/tool/requestUserInput', { threadId: thread, turnId: turno, itemId: 'in-1', questions: [], isBlocking: true });
    await falar(resposta.error ? 'sem entrada' : 'com entrada', 'msg-final');
  } else if (roteiro === 'lento') {
    avisar('item/started', { threadId: thread, turnId: turno, item: { type: 'agentMessage', id: 'msg-lento', text: '' } });
    while (!interrompido) {
      avisar('item/agentMessage/delta', { threadId: thread, turnId: turno, itemId: 'msg-lento', delta: 'mais ' });
      await depois(10);
    }
    terminarTurno('interrupted');
    return;
  } else if (roteiro === 'falha') {
    avisar('error', { error: { message: 'You are not logged in. Run codex login.' }, willRetry: false });
    terminarTurno('failed', 'You are not logged in. Run codex login.');
    return;
  } else {
    await falar(`roteiro desconhecido: ${roteiro}`);
  }
  if (!interrompido) terminarTurno('completed');
}

/**
 * Turno com `outputSchema`, o do juiz: a resposta final é o texto da última mensagem. Com
 * CODEX_DE_MENTIRA_JUIZ_TENTA=comando, tenta antes um comando, que pede aprovação.
 */
async function julgar(): Promise<void> {
  if (process.env.CODEX_DE_MENTIRA_JUIZ_TENTA === 'comando') {
    const comando = "/bin/bash -lc 'cat /data/codex/auth.json'";
    await comAprovacao({ type: 'commandExecution', id: 'exec-juiz', command: comando, cwd: process.cwd() }, 'item/commandExecution/requestApproval', {
      kind: 'command',
      command: comando,
      cwd: process.cwd(),
      reason: null,
    });
  }
  await falar('Vou responder no formato pedido.', 'msg-comentario');
  await depois(Number(process.env.CODEX_DE_MENTIRA_ATRASO_MS ?? 0));
  if (interrompido) {
    terminarTurno('interrupted');
    return;
  }
  const resposta = process.env.CODEX_DE_MENTIRA_RESPOSTA ?? '{"resposta":false,"motivo":"2 + 2 = 4"}';
  // A resposta final chega inteira, como o Codex entrega a presa ao esquema.
  avisar('item/completed', { threadId: thread, turnId: turno, item: { type: 'agentMessage', id: 'msg-final', text: resposta } });
  terminarTurno('completed');
}

function tratar(mensagem: Mensagem): void {
  if (registro) appendFileSync(registro, `${JSON.stringify(mensagem)}\n`);
  if (mensagem.method === undefined && typeof mensagem.id === 'number') {
    esperando.get(mensagem.id)?.(mensagem);
    esperando.delete(mensagem.id);
    return;
  }
  const params = mensagem.params ?? {};
  switch (mensagem.method) {
    case 'initialize':
      escrever({ id: mensagem.id, result: { userAgent: 'codex-de-mentira/0.172.0' } });
      return;
    case 'thread/start':
      thread = `thread-${process.pid}`;
      escrever({ id: mensagem.id, result: { thread: { id: thread } } });
      return;
    case 'thread/resume':
      if (typeof params.threadId !== 'string' || !params.threadId.startsWith('thread-')) {
        escrever({ id: mensagem.id, error: { code: -32600, message: `no rollout found for thread id ${String(params.threadId)}` } });
        return;
      }
      thread = params.threadId;
      escrever({ id: mensagem.id, result: { thread: { id: thread } } });
      return;
    case 'turn/start': {
      turno = `turno-${Date.now()}`;
      escrever({ id: mensagem.id, result: { turn: { id: turno, status: 'inProgress' } } });
      avisar('turn/started', { threadId: thread, turn: { id: turno, status: 'inProgress' } });
      const entrada = (params.input as { text?: string }[] | undefined)?.[0]?.text ?? '';
      if (params.outputSchema !== undefined) void julgar();
      else void rodarTurno(entrada);
      return;
    }
    case 'turn/interrupt':
      interrompido = true;
      escrever({ id: mensagem.id, result: {} });
      return;
    default:
      if (mensagem.id !== undefined) escrever({ id: mensagem.id, result: {} });
  }
}

let resto = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (parte: string) => {
  resto += parte;
  const linhas = resto.split('\n');
  resto = linhas.pop() ?? '';
  for (const linha of linhas) if (linha.trim()) tratar(JSON.parse(linha) as Mensagem);
});
process.stdin.on('end', () => {
  for (const relogio of relogios) clearTimeout(relogio);
  process.exit(0);
});
