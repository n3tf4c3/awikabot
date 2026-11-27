// Um `agy acp` de mentira, para os testes do driver (`motor-antigravity.test.ts`). Fala o mesmo
// JSON-RPC 2.0 por linhas, com a forma das mensagens do Antigravity 1.5.18 vista na prova da etapa
// 7. Não executa nada: o "comando", a "gravação" e a "leitura" só existem como chamadas e pedidos.
//
// O texto da pessoa escolhe o roteiro:
//   eco <texto>          responde o texto, palavra por palavra
//   comando <linha>      pede permissão para um comando e diz se ele rodou
//   gravar <caminho>     pede permissão para criar o arquivo
//   editar <caminho>     pede permissão para trocar um trecho do arquivo
//   ler <caminho>        pede permissão para ler o arquivo
//   sem-linha            pede permissão para um comando sem dizer a linha
//   para-sempre <linha>  pede permissão só com a opção que vale para a sessão inteira
//   escapa               roda um comando sem pedir permissão
//   busca                tenta a busca na web, que o gancho nega
//   busca-escapa         a busca na web roda, como rodaria sem o gancho
//   estranho             pede permissão para um tipo de ferramenta que o awikabot não conhece
//   entrada              pede ao cliente uma coisa que ele não oferece
//   lento                fala sem parar até o turno ser cancelado
//   falha                o turno falha por falta de login
//
// Cada mensagem recebida vai, uma por linha, para o arquivo em ANTIGRAVITY_DE_MENTIRA_REGISTRO.
// ANTIGRAVITY_DE_MENTIRA_MODO troca o modo em que a sessão abre (o padrão é "default").
import { appendFileSync } from 'node:fs';

type Mensagem = { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };

const registro = process.env.ANTIGRAVITY_DE_MENTIRA_REGISTRO;
if (registro) appendFileSync(registro, `${JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), pastaDoBot: process.env.AWIKA_PASTA_DO_BOT ?? null })}\n`);

const escrever = (mensagem: Mensagem): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...mensagem })}\n`);
};

let sessao = '';
let modo = process.env.ANTIGRAVITY_DE_MENTIRA_MODO ?? 'default';
let cancelado = false;
let proximoPedido = 1000;
let chamadas = 0;
const esperando = new Map<number, (resposta: Mensagem) => void>();
const relogios: NodeJS.Timeout[] = [];

const atualizar = (update: Record<string, unknown>): void => escrever({ method: 'session/update', params: { sessionId: sessao, update } });

function pedirAoCliente(method: string, params: Record<string, unknown>): Promise<Mensagem> {
  const id = proximoPedido;
  proximoPedido += 1;
  return new Promise((ok) => {
    esperando.set(id, ok);
    escrever({ id, method, params });
  });
}

const depois = (ms: number): Promise<void> =>
  new Promise((ok) => {
    relogios.push(setTimeout(ok, ms));
  });

async function falar(texto: string): Promise<void> {
  for (const parte of texto.match(/\S+\s*/g) ?? []) {
    if (cancelado) return;
    atualizar({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: parte } });
    await depois(5);
  }
}

const opcoesDaSessao = (): Record<string, unknown>[] => [
  { id: 'model', name: 'Model', currentValue: 'gemini-4-neon' },
  { id: 'thought_level', name: 'Thinking Level', currentValue: 'high' },
  { id: 'mode', name: 'Mode', currentValue: modo },
];

const UMA_VEZ = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
];

/** Uma chamada de ferramenta com pedido de permissão, na ordem em que o 1.5.18 a anuncia. */
async function comPermissao(chamada: Record<string, unknown>, opcoes: Record<string, unknown>[] = UMA_VEZ): Promise<boolean> {
  chamadas += 1;
  const toolCallId = `call_${chamadas}`;
  atualizar({ sessionUpdate: 'tool_call', toolCallId, kind: chamada.kind, title: chamada.title, status: 'in_progress' });
  atualizar({ sessionUpdate: 'tool_call_update', toolCallId, kind: chamada.kind, status: 'pending' });
  const resposta = await pedirAoCliente('session/request_permission', { sessionId: sessao, toolCall: { toolCallId, status: 'pending', ...chamada }, options: opcoes });
  const escolha = (resposta.result as { outcome?: { outcome?: unknown; optionId?: unknown } } | undefined)?.outcome;
  const ok = escolha?.outcome === 'selected' && opcoes.some((opcao) => opcao.optionId === escolha.optionId && String(opcao.kind).startsWith('allow'));
  atualizar({ sessionUpdate: 'tool_call_update', toolCallId, kind: chamada.kind, status: 'in_progress' });
  atualizar({ sessionUpdate: 'tool_call_update', toolCallId, kind: chamada.kind, status: ok ? 'completed' : 'failed' });
  return ok;
}

/** Uma chamada que não passa por pedido: termina como o gancho ou a falta dele deixarem. */
function semPermissao(tipo: string, titulo: string, status: 'completed' | 'failed'): void {
  chamadas += 1;
  const toolCallId = `call_${chamadas}`;
  atualizar({ sessionUpdate: 'tool_call', toolCallId, kind: tipo, title: titulo, status: 'in_progress' });
  atualizar({ sessionUpdate: 'tool_call_update', toolCallId, kind: tipo, status });
}

async function rodarTurno(texto: string): Promise<string> {
  const [roteiro = '', ...resto] = texto.split(' ');
  const argumento = resto.join(' ');
  if (roteiro === 'eco') {
    await falar(argumento);
  } else if (roteiro === 'comando') {
    await falar('Vou rodar.');
    const ok = await comPermissao({ kind: 'execute', title: argumento, rawInput: { CommandLine: argumento, WaitMsBeforeAsync: 5000 } });
    await falar(ok ? 'rodou' : 'negado');
  } else if (roteiro === 'gravar') {
    const ok = await comPermissao({
      kind: 'edit',
      title: `File ${argumento}`,
      locations: [{ path: argumento }],
      rawInput: { Path: argumento, Content: 'conteúdo novo', Overwrite: true },
      content: [{ type: 'diff', path: argumento, newText: 'conteúdo novo' }],
    });
    await falar(ok ? 'gravou' : 'negado');
  } else if (roteiro === 'editar') {
    const ok = await comPermissao({
      kind: 'edit',
      title: `File ${argumento}`,
      locations: [{ path: argumento }],
      rawInput: { Path: argumento, Target: 'antes', Replacement: 'depois' },
      content: [{ type: 'diff', path: argumento, oldText: 'antes', newText: 'depois' }],
    });
    await falar(ok ? 'editou' : 'negado');
  } else if (roteiro === 'ler') {
    const ok = await comPermissao({ kind: 'read', title: `File ${argumento}`, locations: [{ path: argumento }], rawInput: { Path: argumento } });
    await falar(ok ? 'leu' : 'negado');
  } else if (roteiro === 'sem-linha') {
    const ok = await comPermissao({ kind: 'execute', title: 'um comando', rawInput: {} });
    await falar(ok ? 'rodou' : 'negado');
  } else if (roteiro === 'para-sempre') {
    const ok = await comPermissao({ kind: 'execute', title: argumento, rawInput: { CommandLine: argumento } }, [{ optionId: 'sempre', name: 'Always allow', kind: 'allow_always' }]);
    await falar(ok ? 'rodou' : 'negado');
  } else if (roteiro === 'escapa') {
    semPermissao('execute', 'cat /segredo', 'completed');
    await depois(2000);
    await falar('o segredo é segredo');
  } else if (roteiro === 'busca') {
    semPermissao('search', '"awikabot" on Web', 'failed');
    await falar('negado');
  } else if (roteiro === 'busca-escapa') {
    semPermissao('search', '"awikabot" on Web', 'completed');
    await depois(2000);
    await falar('achei');
  } else if (roteiro === 'estranho') {
    const ok = await comPermissao({ kind: 'fetch', title: 'https://exemplo.test', rawInput: { Url: 'https://exemplo.test' } });
    await falar(ok ? 'abriu' : 'negado');
  } else if (roteiro === 'entrada') {
    const resposta = await pedirAoCliente('fs/read_text_file', { sessionId: sessao, path: '/segredo' });
    await falar(resposta.error ? 'sem arquivo' : 'com arquivo');
  } else if (roteiro === 'lento') {
    while (!cancelado) {
      atualizar({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'mais ' } });
      await depois(10);
    }
    return 'cancelled';
  } else {
    await falar(`roteiro desconhecido: ${roteiro}`);
  }
  return cancelado ? 'cancelled' : 'end_turn';
}

function tratar(mensagem: Mensagem): void {
  if (registro) appendFileSync(registro, `${JSON.stringify(mensagem)}\n`);
  if (mensagem.method === undefined && typeof mensagem.id === 'number') {
    esperando.get(mensagem.id)?.(mensagem);
    esperando.delete(mensagem.id);
    return;
  }
  const params = mensagem.params ?? {};
  const responder = (result: unknown): void => escrever({ id: mensagem.id, result });
  const recusar = (code: number, message: string): void => escrever({ id: mensagem.id, error: { code, message } });
  switch (mensagem.method) {
    case 'initialize':
      responder({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } }, agentInfo: { name: 'Antigravity ACP Server', version: '1.5.18' } });
      return;
    case 'authenticate':
      responder({});
      return;
    case 'session/new':
      sessao = `sessao-${process.pid}`;
      responder({ sessionId: sessao, configOptions: opcoesDaSessao() });
      return;
    case 'session/resume':
      if (typeof params.sessionId !== 'string' || !params.sessionId.startsWith('sessao-')) {
        recusar(-32603, `Failed to read session ${String(params.sessionId)}; retry, or load it with session/load`);
        return;
      }
      sessao = params.sessionId;
      // Quem retoma com "load" recebe a conversa antiga de volta; com "resume", não.
      responder({ sessionId: sessao, configOptions: opcoesDaSessao() });
      return;
    case 'session/load':
      sessao = String(params.sessionId);
      atualizar({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'resposta antiga' } });
      responder({ sessionId: sessao, configOptions: opcoesDaSessao() });
      return;
    case 'session/set_config_option':
      if (params.configId === 'model' && params.value === 'modelo-que-nao-existe') {
        recusar(-32602, 'Model "modelo-que-nao-existe" is not offered');
        return;
      }
      // Num servidor que não deixa sair do modo automático, a troca de modo não pega.
      if (params.configId === 'mode' && process.env.ANTIGRAVITY_DE_MENTIRA_MODO_PRESO !== '1') modo = String(params.value);
      responder({ configOptions: opcoesDaSessao() });
      return;
    case 'session/prompt': {
      const texto = (params.prompt as { text?: string }[] | undefined)?.[0]?.text ?? '';
      if (texto === 'falha') {
        recusar(-32000, 'Authentication required');
        return;
      }
      void rodarTurno(texto).then((stopReason) => responder({ stopReason }));
      return;
    }
    case 'session/cancel':
      cancelado = true;
      return;
    default:
      if (mensagem.id !== undefined) recusar(-32601, 'método desconhecido');
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
