import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { configuracaoDoCodexPorOpcao } from './configuracao-codex';
import { executarGancho } from './gancho';
import type { Gancho, Motor, ResultadoMotor } from './motor';

/**
 * Dirige o Codex sem modificação, pelo servidor de aplicativo (`codex app-server`): JSON-RPC, uma
 * mensagem por linha, pela entrada e saída padrão. É ali que o texto sai aos poucos e que cada
 * comando e cada edição chegam como pedido de aprovação a quem dirige o processo, que é este
 * driver. O `codex exec` não serve: nunca pede aprovação.
 *
 * A trava do Codex é o pedido, não um gancho: o gancho dele deixa passar quando quebra, e o pedido
 * sem resposta não deixa. Cada pedido vai ao servidor pelo mesmo caminho do gancho do Claude Code
 * (`executarGancho`), então vale a mesma política e o mesmo cartão. Toda falha nega.
 *
 * O login é o da pessoa dona do servidor, feito pelo próprio Codex; este código nunca o lê.
 */

/** Itens que não agem: conversa, raciocínio e plano. */
const ITENS_SEM_ACAO = new Set([
  'userMessage',
  'hookPrompt',
  'agentMessage',
  'plan',
  'reasoning',
  'contextCompaction',
  'enteredReviewMode',
  'exitedReviewMode',
  'sleep',
]);
/** Itens que só agem com um pedido de aprovação aceito. */
const ITENS_COM_PEDIDO = new Set(['commandExecution', 'fileChange']);

/**
 * A saída do comando que a caixa de areia não deixou começar, no Codex 0.172.0 da imagem. No
 * contêiner, o bwrap que vem com o Codex não cria o namespace e sai com 1 antes de executar o
 * comando; o item termina como `failed`, sem pedido, com exatamente este texto, e o modelo tenta
 * de novo pedindo aprovação. Medido em 27/11 com o binário de verdade, na imagem do servidor, com
 * um modelo falso. Trocar a versão do Codex é medir de novo: se o texto mudar, toda tentativa sem
 * pedido corta o turno, o que é o lado seguro.
 */
export const SAIDA_DA_CAIXA_QUE_NAO_SOBE =
  "bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces. On e.g. debian this can be enabled with 'sysctl kernel.unprivileged_userns_clone=1'.\n";

/**
 * Um comando ou uma edição que terminou sem pedido aceito agiu? O estado não basta: com a caixa
 * de areia de pé, um comando que lê e sai com erro termina como `failed`, com o que leu na saída.
 * Só não agiu o item recusado (`declined`) e o comando que a caixa de areia não deixou começar,
 * reconhecido pela saída exata dela. Estado desconhecido conta como ação.
 *
 * Com a caixa de areia de pé, um comando pode imprimir aquela mesma saída e sair com 1 para não
 * ser cortado. O que chega ao modelo continua sendo só o texto fixo; o que ele aprende é se o
 * turno seguiu, um bit por tentativa.
 */
export function agiuSemPedido(item: Objeto): boolean {
  if (item.status === 'declined') return false;
  const naoComecou =
    item.type === 'commandExecution' && item.status === 'failed' && item.exitCode === 1 && item.aggregatedOutput === SAIDA_DA_CAIXA_QUE_NAO_SOBE;
  return !naoComecou;
}

/**
 * O que o modelo precisa saber do ambiente. Sem isto, ao ver a caixa de areia só de leitura, ele
 * desiste de comandos e edições sem pedir (no runbook, respondeu "negado" e "o ambiente é somente
 * leitura" sem tentar), e a pessoa nunca vê o cartão. A trava não depende deste texto: o que ele
 * muda é só se o pedido chega.
 */
export const ORIENTACAO_DO_AMBIENTE = [
  'Você é um bot do awikabot. Neste ambiente a caixa de areia não funciona: todo comando, inclusive os que só leem, e toda edição de arquivo precisam da aprovação da pessoa, que vê o pedido num cartão e decide.',
  'Quando a tarefa pedir um comando ou uma edição, faça a chamada em vez de desistir ou responder que o ambiente é somente leitura: no terminal, peça a aprovação com sandbox_permissions "require_escalated" e uma justificativa curta; na edição de arquivos (apply_patch), basta chamar a ferramenta, que ela mesma pede a aprovação.',
  'Grave arquivos só na pasta de trabalho. Se a pessoa negar, não tente outro caminho para a mesma ação.',
].join(' ');

/** As instruções do turno: a orientação do ambiente e, depois, as do bot. */
export function instrucoesDoTurno(doBot: string): string {
  return doBot === '' ? ORIENTACAO_DO_AMBIENTE : `${ORIENTACAO_DO_AMBIENTE}\n\n${doBot}`;
}

/** Quanto o driver espera o turno fechar depois de pedir a parada, antes de matar o processo. */
export const PRAZO_DA_PARADA_MS = 5000;
/** Quanto espera o processo sair depois do fim do turno, que já foi gravado pelo próprio Codex. */
const PRAZO_DA_SAIDA_MS = 3000;

/** Reduz a mensagem de erro do Codex a uma classe conhecida, que é o que cabe num log e na conversa. */
export function classificarFalhaDoCodex(saida: string): string {
  if (/no rollout found|thread not found|no thread|not found for thread/i.test(saida)) return 'sessão do motor não encontrada';
  if (/not logged in|login|unauthorized|401|authentication|api key|token (expired|invalid)|refresh token/i.test(saida)) return 'motor sem login válido';
  if (/usage limit|rate limit|quota|429|overloaded|too many requests/i.test(saida)) return 'limite de uso do motor';
  if (/model.*(not (found|supported|exist)|unsupported|invalid)|unknown model/i.test(saida)) return 'modelo não aceito pelo motor';
  return saida.trim() === '' ? 'sem mensagem de erro' : 'não classificado';
}

/** As opções do processo. Toda opção vai na forma `--nome=valor`, e nenhuma vem do app. */
export function argumentosDoCodex(configuracaoGerenciada: boolean): string[] {
  // Na imagem, a configuração mora em `/etc/codex`, fora do alcance do bot. Fora dela, vai aqui.
  return ['app-server', '--listen=stdio://', ...(configuracaoGerenciada ? [] : configuracaoDoCodexPorOpcao())];
}

/** O que o servidor pergunta ao gancho: uma ferramenta, no vocabulário da política (`politica.ts`). */
export interface ConsultaDeFerramenta {
  ferramenta: string;
  entrada: Record<string, unknown>;
}

type Objeto = Record<string, unknown>;

function objeto(valor: unknown): Objeto | null {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor) ? (valor as Objeto) : null;
}

function textoOuNulo(valor: unknown): string | null {
  return typeof valor === 'string' && valor !== '' ? valor : null;
}

/**
 * Um pedido de comando, como a política o lê. O comando é o que o Codex vai executar, inteiro,
 * como `/bin/bash -lc '...'`: é ele que a pessoa aprova. Sem comando legível, `null`, e o driver nega.
 */
export function consultaDeComando(parametros: Objeto, item: Objeto | undefined): ConsultaDeFerramenta | null {
  const comando = textoOuNulo(parametros.command) ?? textoOuNulo(item?.command);
  if (comando === null) return null;
  const pasta = textoOuNulo(parametros.cwd) ?? textoOuNulo(item?.cwd);
  // Escrever na entrada de um comando que já roda também é uma ação; o cartão diz isso.
  const prefixo = parametros.kind === 'writeStdin' ? 'Escrever na entrada do comando em andamento:\n' : '';
  return { ferramenta: 'Bash', entrada: { command: `${prefixo}${comando}`, ...(pasta === null ? {} : { cwd: pasta }) } };
}

/**
 * Um pedido de edição vira uma consulta por arquivo. Os caminhos vêm do item que o Codex anunciou
 * antes do pedido; sem eles, `null`, e o driver nega.
 */
export function consultasDeEdicao(item: Objeto | undefined): ConsultaDeFerramenta[] | null {
  if (!item || !Array.isArray(item.changes) || item.changes.length === 0) return null;
  const consultas: ConsultaDeFerramenta[] = [];
  for (const bruto of item.changes as unknown[]) {
    const mudanca = objeto(bruto);
    const caminho = textoOuNulo(mudanca?.path);
    const tipo = objeto(mudanca?.kind)?.type;
    const diff = typeof mudanca?.diff === 'string' ? mudanca.diff : '';
    if (caminho === null) return null;
    if (tipo === 'add') consultas.push({ ferramenta: 'Write', entrada: { file_path: caminho, diff } });
    else if (tipo === 'delete') consultas.push({ ferramenta: 'Edit', entrada: { file_path: caminho, diff, apagar: true } });
    else if (tipo === 'update') {
      const destino = objeto(mudanca?.kind)?.move_path;
      consultas.push({ ferramenta: 'Edit', entrada: { file_path: caminho, diff, ...(destino ? { mover_para: destino } : {}) } });
    } else return null;
  }
  return consultas;
}

/** Pergunta ao servidor, pelo caminho do gancho. Sem gancho, ou com qualquer falha, nega. */
async function consultarServidor(gancho: Gancho | null, consulta: ConsultaDeFerramenta): Promise<boolean> {
  if (gancho === null) return false;
  let saida = '';
  await executarGancho(
    { porta: gancho.porta, token: gancho.token },
    {
      lerEntrada: () => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: consulta.ferramenta, tool_input: consulta.entrada }),
      escrever: (texto) => {
        saida += texto;
      },
    },
  );
  try {
    const lido = JSON.parse(saida) as { hookSpecificOutput?: { permissionDecision?: unknown } };
    return lido.hookSpecificOutput?.permissionDecision === 'allow';
  } catch {
    return false;
  }
}

function dentroDaPasta(pasta: string, alvo: string): boolean {
  const base = path.resolve(pasta);
  const real = path.resolve(base, alvo);
  return real === base || real.startsWith(base + path.sep);
}

/**
 * Cria a pasta do Codex (`CODEX_HOME`) se ela não existe. O Codex recusa partir sem ela, inclusive
 * no login, e o volume de um servidor anterior ao Codex não a tem: a imagem só a criaria num volume
 * novo. Só o dono a lê, porque é ali que fica o login.
 */
export function prepararCasaDoCodex(ambiente: Record<string, string>): void {
  const casa = ambiente.CODEX_HOME;
  if (!casa) return;
  try {
    mkdirSync(casa, { recursive: true, mode: 0o700 });
  } catch (erro) {
    console.error(`motor codex: não criou a pasta do Codex: ${erro instanceof Error ? erro.message : 'erro desconhecido'}`);
  }
}

export function criarMotorCodex(opcoes: {
  /** O executável e o que vem antes de `app-server`: nos testes, o Node e um Codex de mentira. */
  binario: string;
  prefixo?: string[];
  ambiente: Record<string, string>;
  /** Na imagem, a configuração do Codex está em `/etc/codex` e não vai na linha de comando. */
  configuracaoGerenciada: boolean;
  prazoDaParadaMs?: number;
}): Motor {
  // Na partida do servidor, antes de qualquer login ou turno.
  prepararCasaDoCodex(opcoes.ambiente);
  return (pedido) => {
    const unix = process.platform !== 'win32';
    const filho = spawn(opcoes.binario, [...(opcoes.prefixo ?? []), ...argumentosDoCodex(opcoes.configuracaoGerenciada)], {
      cwd: pedido.pasta,
      env: opcoes.ambiente,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Num grupo próprio, para que parar mate também os comandos que o Codex abriu.
      detached: unix,
    });

    let texto = '';
    let sessao = pedido.sessao;
    let turnoId: string | null = null;
    let estadoDoTurno: string | null = null;
    let erroDoTurno = '';
    let parado = false;
    let corte: string | null = null;
    let encerrado = false;
    let mensagemAtual: string | null = null;
    let stderr = '';
    let resto = '';
    let proximoId = 1;
    const pendentes = new Map<number, { ok: (resultado: unknown) => void; falha: (erro: Error) => void }>();
    /** Itens anunciados pelo Codex, pelo id: os pedidos de aprovação apontam para eles. */
    const itens = new Map<string, Objeto>();
    /** Itens que a pessoa aprovou. Um item que age fora desta lista é corte. */
    const aprovados = new Set<string>();
    let relogioDaParada: NodeJS.Timeout | undefined;
    let relogioDaSaida: NodeJS.Timeout | undefined;

    const matar = (): void => {
      try {
        if (unix && filho.pid !== undefined) process.kill(-filho.pid, 'SIGKILL');
        else filho.kill('SIGKILL');
      } catch {
        // Já saiu.
      }
    };

    const escrever = (mensagem: Objeto): void => {
      if (encerrado || filho.stdin.destroyed) return;
      filho.stdin.write(`${JSON.stringify(mensagem)}\n`);
    };

    const pedir = (metodo: string, parametros: Objeto): Promise<unknown> =>
      new Promise((ok, falha) => {
        const id = proximoId;
        proximoId += 1;
        pendentes.set(id, { ok, falha });
        escrever({ method: metodo, id, params: parametros });
      });

    const acrescentar = (trecho: string): void => {
      if (trecho === '') return;
      texto += trecho;
      pedido.aoTexto(trecho);
    };

    /** Uma ação que escapou do pedido de aprovação: o turno acaba na hora, sem a saída dela. */
    const cortar = (motivo: string): void => {
      if (corte !== null || encerrado) return;
      corte = motivo;
      console.error(`motor codex: turno cortado: ${motivo}`);
      matar();
    };

    const responderPedido = (id: unknown, resultado: Objeto): void => escrever({ id, result: resultado });
    const recusarPedido = (id: unknown, mensagem: string): void => escrever({ id, error: { code: -32601, message: mensagem } });

    const decidir = async (id: unknown, metodo: string, parametros: Objeto): Promise<void> => {
      const itemId = textoOuNulo(parametros.itemId);
      const item = itemId === null ? undefined : itens.get(itemId);
      let consultas: ConsultaDeFerramenta[] | null = null;
      if (metodo === 'item/commandExecution/requestApproval') {
        const consulta = consultaDeComando(parametros, item);
        consultas = consulta === null ? null : [consulta];
      } else if (metodo === 'item/fileChange/requestApproval') {
        // Pedir uma pasta inteira para o resto da sessão não passa: cada gravação vai ao cartão.
        consultas = textoOuNulo(parametros.grantRoot) === null ? consultasDeEdicao(item) : null;
      }
      let permitido = consultas !== null && itemId !== null;
      for (const consulta of consultas ?? []) {
        if (!permitido) break;
        permitido = await consultarServidor(pedido.gancho, consulta);
      }
      if (permitido && itemId !== null) aprovados.add(itemId);
      // Só "accept": nunca para a sessão, nunca uma regra nova. Cada ação passa por um cartão.
      responderPedido(id, { decision: permitido ? 'accept' : 'decline' });
    };

    const tratarPedidoDoCodex = (id: unknown, metodo: string, parametros: Objeto): void => {
      if (metodo === 'item/commandExecution/requestApproval' || metodo === 'item/fileChange/requestApproval') {
        void decidir(id, metodo, parametros).catch(() => responderPedido(id, { decision: 'decline' }));
        return;
      }
      // Entrada do usuário, permissões extras, conectores, ferramentas do cliente, tokens: nada disso
      // existe aqui. A recusa conta como negação.
      recusarPedido(id, 'não suportado pelo awikabot');
    };

    const tratarAviso = (metodo: string, parametros: Objeto): void => {
      if (metodo === 'item/agentMessage/delta') {
        const itemId = textoOuNulo(parametros.itemId);
        // Mensagens diferentes do mesmo turno (o comentário e a resposta) ficam em parágrafos.
        if (itemId !== null && itemId !== mensagemAtual) {
          if (texto !== '') acrescentar('\n\n');
          mensagemAtual = itemId;
        }
        if (typeof parametros.delta === 'string') acrescentar(parametros.delta);
        return;
      }
      if (metodo === 'item/started' || metodo === 'item/completed') {
        const item = objeto(parametros.item);
        const itemId = textoOuNulo(item?.id);
        const tipo = typeof item?.type === 'string' ? item.type : 'desconhecido';
        if (item === null || itemId === null) return;
        itens.set(itemId, item);
        if (ITENS_SEM_ACAO.has(tipo)) {
          // Uma mensagem que chegou inteira, sem trechos, ainda é resposta.
          if (metodo === 'item/completed' && tipo === 'agentMessage' && itemId !== mensagemAtual && typeof item.text === 'string') {
            if (texto !== '') acrescentar('\n\n');
            mensagemAtual = itemId;
            acrescentar(item.text);
          }
          return;
        }
        if (ITENS_COM_PEDIDO.has(tipo)) {
          // Sem pedido aceito, o item que terminou escapou da aprovação, tenha dado certo ou não; a
          // tentativa que a caixa de areia não deixou começar fica de fora (`agiuSemPedido`).
          if (metodo === 'item/completed' && !aprovados.has(itemId) && agiuSemPedido(item)) {
            cortar(`o Codex executou ${tipo === 'fileChange' ? 'uma edição' : 'um comando'} sem pedir aprovação`);
          }
          return;
        }
        if (tipo === 'imageView' && typeof item.path === 'string' && dentroDaPasta(pedido.pasta, item.path)) return;
        // Busca na web, conectores, servidores MCP, subagentes, imagens: nada disso tem cartão.
        if (metodo === 'item/started') cortar(`o Codex tentou usar "${tipo}", que não passa por aprovação`);
        return;
      }
      if (metodo === 'turn/started') {
        turnoId = textoOuNulo(objeto(parametros.turn)?.id) ?? turnoId;
        return;
      }
      if (metodo === 'turn/completed') {
        const turno = objeto(parametros.turn);
        estadoDoTurno = typeof turno?.status === 'string' ? turno.status : 'failed';
        erroDoTurno = textoOuNulo(objeto(turno?.error)?.message) ?? '';
        // O Codex já gravou o turno; o processo pode sair.
        filho.stdin.end();
        relogioDaSaida = setTimeout(matar, PRAZO_DA_SAIDA_MS);
        relogioDaSaida.unref();
        return;
      }
      if (metodo === 'error') {
        const erro = objeto(parametros.error);
        erroDoTurno = textoOuNulo(erro?.message) ?? erroDoTurno;
      }
    };

    const tratarLinha = (linha: string): void => {
      if (!linha.trim()) return;
      let mensagem: Objeto | null;
      try {
        mensagem = objeto(JSON.parse(linha));
      } catch {
        return;
      }
      if (mensagem === null) return;
      const metodo = typeof mensagem.method === 'string' ? mensagem.method : null;
      const parametros = objeto(mensagem.params) ?? {};
      if (metodo !== null && mensagem.id !== undefined) {
        tratarPedidoDoCodex(mensagem.id, metodo, parametros);
      } else if (metodo !== null) {
        tratarAviso(metodo, parametros);
      } else if (typeof mensagem.id === 'number' && pendentes.has(mensagem.id)) {
        const pendente = pendentes.get(mensagem.id);
        pendentes.delete(mensagem.id);
        const erro = objeto(mensagem.error);
        if (erro) pendente?.falha(new Error(typeof erro.message === 'string' ? erro.message : 'erro do Codex'));
        else pendente?.ok(mensagem.result);
      }
    };

    filho.stdout.setEncoding('utf8');
    filho.stdout.on('data', (parte: string) => {
      resto += parte;
      const linhas = resto.split('\n');
      resto = linhas.pop() ?? '';
      linhas.forEach(tratarLinha);
    });
    filho.stderr.setEncoding('utf8');
    filho.stderr.on('data', (parte: string) => {
      stderr = (stderr + parte).slice(-2000);
    });
    filho.stdin.on('error', () => {});

    // A política de cada turno é a mesma da configuração gerenciada: a caixa de areia só de leitura,
    // sem rede, e os pedidos para a pessoa.
    const politica = { approvalPolicy: 'on-request', approvalsReviewer: 'user' } as const;
    const instrucoes = instrucoesDoTurno(pedido.instrucoes);

    const conduzir = async (): Promise<void> => {
      await pedir('initialize', { clientInfo: { name: 'awikabot', title: 'awikabot', version: '0' } });
      escrever({ method: 'initialized', params: {} });
      const thread = objeto(
        pedido.sessao
          ? objeto(
              await pedir('thread/resume', {
                threadId: pedido.sessao,
                excludeTurns: true,
                cwd: pedido.pasta,
                sandbox: 'read-only',
                developerInstructions: instrucoes,
                ...politica,
              }),
            )?.thread
          : objeto(
              await pedir('thread/start', {
                cwd: pedido.pasta,
                sandbox: 'read-only',
                developerInstructions: instrucoes,
                serviceName: 'awikabot',
                ...politica,
                ...(pedido.modelo ? { model: pedido.modelo } : {}),
              }),
            )?.thread,
      );
      const threadId = textoOuNulo(thread?.id);
      if (threadId === null) throw new Error('o Codex não devolveu a conversa');
      sessao = threadId;
      if (parado) return;
      // O texto da pessoa vai no corpo da mensagem, nunca como opção do processo.
      const inicio = objeto(
        await pedir('turn/start', {
          threadId,
          input: [{ type: 'text', text: pedido.texto, text_elements: [] }],
          cwd: pedido.pasta,
          sandboxPolicy: { type: 'readOnly', networkAccess: false },
          ...politica,
          ...(pedido.modelo ? { model: pedido.modelo } : {}),
          ...(pedido.esforco ? { effort: pedido.esforco } : {}),
        }),
      );
      turnoId = textoOuNulo(objeto(inicio?.turn)?.id) ?? turnoId;
      if (parado) interromper();
    };

    const interromper = (): void => {
      if (sessao !== null && turnoId !== null) void pedir('turn/interrupt', { threadId: sessao, turnId: turnoId }).catch(() => matar());
      else matar();
    };

    const fim = new Promise<ResultadoMotor>((ok) => {
      const terminar = (codigo: number | null): void => {
        if (encerrado) return;
        encerrado = true;
        clearTimeout(relogioDaParada);
        clearTimeout(relogioDaSaida);
        tratarLinha(resto);
        for (const pendente of pendentes.values()) pendente.falha(new Error('o Codex saiu'));
        pendentes.clear();
        if (corte !== null) {
          acrescentar(`${texto === '' ? '' : '\n\n'}[awikabot] Turno interrompido: ${corte}.`);
          ok({ estado: 'falhou', texto, sessao });
          return;
        }
        if (parado) {
          ok({ estado: 'parada', texto, sessao });
          return;
        }
        if (estadoDoTurno === 'completed') {
          ok({ estado: 'completa', texto, sessao });
          return;
        }
        // O motivo bruto pode trazer trecho de conversa ou a conta: só a classe vai ao log e à conversa.
        const classe = classificarFalhaDoCodex(`${erroDoTurno}\n${stderr}`);
        console.error(`motor codex: saiu com código ${codigo}, turno ${estadoDoTurno ?? 'não terminado'}; motivo: ${classe}`);
        if (texto === '') acrescentar(`O Codex não respondeu: ${classe}.`);
        // A sessão que não foi achada não volta a ser usada; as outras ficam, para tentar de novo.
        ok({ estado: 'falhou', texto, sessao: classe === 'sessão do motor não encontrada' ? null : sessao });
      };
      filho.on('error', (erro) => {
        console.error(`motor codex: não iniciou: ${erro.message}`);
        if (texto === '') acrescentar('O Codex não iniciou neste servidor.');
        estadoDoTurno = 'failed';
        terminar(null);
      });
      filho.on('close', (codigo) => terminar(codigo));
    });

    void conduzir().catch((erro: unknown) => {
      erroDoTurno = erro instanceof Error ? erro.message : String(erro);
      matar();
    });

    return {
      fim,
      parar: () => {
        if (parado || encerrado) return;
        parado = true;
        interromper();
        relogioDaParada = setTimeout(matar, opcoes.prazoDaParadaMs ?? PRAZO_DA_PARADA_MS);
        relogioDaParada.unref();
      },
    };
  };
}

