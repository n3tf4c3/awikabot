import { spawn } from 'node:child_process';
import path from 'node:path';
import { comandoNaPastaDoBot, prepararConfiguracaoDoAntigravity, prepararPastaDaSessao } from './configuracao-antigravity';
import { consultarServidor, type ConsultaDeFerramenta } from './gancho';
import type { Motor, ResultadoMotor } from './motor';

/**
 * Dirige o Antigravity sem modificação, pelo servidor ACP dele (`agy acp`): JSON-RPC 2.0, uma
 * mensagem por linha, pela entrada e saída padrão. É o caminho que a documentação dá a um cliente
 * de fora. O texto sai aos poucos, e cada leitura, gravação e comando chega como pedido de
 * permissão a quem dirige o processo, que é este driver.
 *
 * A trava é o pedido, como no Codex: sem resposta, o Antigravity não age. Cada pedido vai ao
 * servidor pelo mesmo caminho do gancho do Claude Code (`consultarServidor`), então vale a mesma
 * política e o mesmo cartão. Toda falha nega. O que a prova achou rodando sem pedido (a busca na
 * web, os subagentes, os agendamentos e a configuração lida da pasta do bot) é fechado pela
 * configuração (`configuracao-antigravity.ts`); o que ainda assim agir sem pedido aceito corta o
 * turno.
 *
 * O acesso é o da pessoa dona do servidor: a chave de API do Gemini, que chega pelo ambiente, ou
 * o login feito pelo próprio Antigravity. Este código nunca lê nenhum dos dois.
 */

/**
 * O que o modelo precisa saber do ambiente. A sessão abre numa pasta vazia do servidor, e não na
 * pasta do bot: sem este texto ele gravaria na pasta da sessão, e a política negaria. A trava não
 * depende dele: o que ele muda é só se o pedido chega no lugar certo.
 */
export function orientacaoDoAmbiente(pasta: string): string {
  return [
    `Você é um bot do awikabot. A sua pasta de trabalho é ${pasta}: leia e grave arquivos só dentro dela, sempre com o caminho completo. Os comandos de terminal já partem dela, sem precisar de "cd".`,
    'Todo comando e toda gravação de arquivo precisam da aprovação da pessoa, que vê o pedido num cartão e decide. Quando a tarefa pedir um comando ou uma gravação, faça a chamada em vez de desistir.',
    'Aqui não há busca na web, subagentes nem agendamentos. Se a pessoa negar, não tente outro caminho para a mesma ação.',
  ].join(' ');
}

/** As instruções do turno: a orientação do ambiente e, depois, as do bot. */
export function instrucoesDoTurno(doBot: string, pasta: string): string {
  const orientacao = orientacaoDoAmbiente(pasta);
  return doBot === '' ? orientacao : `${orientacao}\n\n${doBot}`;
}

/** Quanto o driver espera o turno fechar depois de pedir a parada, antes de matar o processo. */
export const PRAZO_DA_PARADA_MS = 5000;
/** Quanto espera o processo sair depois do fim do turno, que o Antigravity já gravou. */
const PRAZO_DA_SAIDA_MS = 3000;

/** Reduz a mensagem de erro do Antigravity a uma classe conhecida, que é o que cabe num log e na conversa. */
export function classificarFalhaDoAntigravity(saida: string): string {
  if (/modo que pede aprovação/.test(saida)) return 'motor fora do modo que pede aprovação';
  if (/failed to read session|session not found|no such session/i.test(saida)) return 'sessão do motor não encontrada';
  if (/authentication required|not signed in|sign in|log ?in|unauthorized|401|api key|GEMINI_API_KEY/i.test(saida)) return 'motor sem login válido';
  if (/quota|rate limit|429|resource exhausted|overloaded|too many requests/i.test(saida)) return 'limite de uso do motor';
  if (/not offered|unknown model|model.*(not (found|available|supported)|invalid)|invalid.*(model|value)/i.test(saida)) return 'modelo não aceito pelo motor';
  return saida.trim() === '' ? 'sem mensagem de erro' : 'não classificado';
}

type Objeto = Record<string, unknown>;

function objeto(valor: unknown): Objeto | null {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor) ? (valor as Objeto) : null;
}

function textoOuNulo(valor: unknown): string | null {
  return typeof valor === 'string' && valor !== '' ? valor : null;
}

/**
 * Um pedido de permissão do Antigravity, como a política o lê. Só três tipos têm tradução: o
 * comando de terminal, que vem com a linha inteira; a gravação e a edição de arquivo, que vêm com
 * o caminho completo e o que muda; e a leitura de arquivo. Qualquer outro tipo, ou um pedido sem
 * o que a política precisa ver, devolve `null`, e o driver nega.
 *
 * No comando, o pedido traz a linha que o modelo escreveu, e não a que roda: o gancho a reescreve
 * para partir da pasta do bot (`decidirNoGanchoDoAntigravity`). O cartão mostra a que roda.
 */
export function consultasDoPedido(chamada: Objeto, pastaDoBot: string): ConsultaDeFerramenta[] | null {
  const tipo = chamada.kind;
  if (tipo === 'execute') {
    const comando = textoOuNulo(objeto(chamada.rawInput)?.CommandLine);
    return comando === null ? null : [{ ferramenta: 'Bash', entrada: { command: comandoNaPastaDoBot(pastaDoBot, comando) } }];
  }
  if (tipo === 'read') {
    const caminhos = Array.isArray(chamada.locations) ? chamada.locations.map((local) => textoOuNulo(objeto(local)?.path)) : [];
    if (caminhos.length === 0 || caminhos.includes(null)) return null;
    return caminhos.map((caminho) => ({ ferramenta: 'Read', entrada: { file_path: caminho } }));
  }
  if (tipo === 'edit') {
    const mudancas = Array.isArray(chamada.content) ? chamada.content.map(objeto).filter((parte) => parte?.type === 'diff') : [];
    if (mudancas.length === 0) return null;
    const consultas: ConsultaDeFerramenta[] = [];
    for (const mudanca of mudancas) {
      const caminho = textoOuNulo(mudanca?.path);
      if (caminho === null || typeof mudanca?.newText !== 'string') return null;
      // Sem texto anterior, o arquivo é criado ou trocado inteiro; com ele, é uma troca de trecho.
      if (typeof mudanca.oldText === 'string') consultas.push({ ferramenta: 'Edit', entrada: { file_path: caminho, old_string: mudanca.oldText, new_string: mudanca.newText } });
      else consultas.push({ ferramenta: 'Write', entrada: { file_path: caminho, content: mudanca.newText } });
    }
    return consultas;
  }
  return null;
}

/** A opção do pedido que vale para uma vez só. Nunca a que vale para a sessão inteira. */
function opcaoDoTipo(opcoes: unknown, tipo: 'allow_once' | 'reject_once'): string | null {
  if (!Array.isArray(opcoes)) return null;
  for (const bruta of opcoes) {
    const opcao = objeto(bruta);
    if (opcao?.kind === tipo) return textoOuNulo(opcao.optionId);
  }
  return null;
}

/** A pasta do usuário que o processo do Antigravity vai enxergar, onde ele guarda `~/.gemini`. */
function casaDoMotor(ambiente: Record<string, string>): string | null {
  return textoOuNulo(ambiente.HOME) ?? textoOuNulo(ambiente.USERPROFILE);
}

export function criarMotorAntigravity(opcoes: {
  /** O executável e o que vem antes de `acp`: nos testes, o Node e um Antigravity de mentira. */
  binario: string;
  prefixo?: string[];
  ambiente: Record<string, string>;
  /** Onde ficam as pastas de sessão, uma por bot, vazias: fora das pastas de trabalho dos bots. */
  pastaDasSessoes: string;
  /** A linha de comando do gancho que nega o que não conhece (`gancho-antigravity`). */
  comandoDoGancho: string;
  prazoDaParadaMs?: number;
}): Motor {
  const comChave = textoOuNulo(opcoes.ambiente.GEMINI_API_KEY) !== null;
  return (pedido) => {
    const aoTextoInicial = (texto: string): { parar: () => void; fim: Promise<ResultadoMotor> } => {
      pedido.aoTexto(texto);
      return { parar: () => {}, fim: Promise.resolve({ estado: 'falhou', texto, sessao: pedido.sessao }) };
    };

    // Antes de o processo subir: a configuração reposta e a pasta da sessão esvaziada. O
    // Antigravity lê as duas no começo do turno; se alguma não ficar como esperado, o turno não começa.
    const casa = casaDoMotor(opcoes.ambiente);
    // A pasta do bot leva só o id gerado pelo servidor; a da sessão repete esse nome, em outro lugar.
    const pastaDaSessao = path.join(path.resolve(opcoes.pastaDasSessoes), path.basename(pedido.pasta));
    const problema =
      casa === null
        ? 'o servidor não sabe onde fica a pasta do usuário do Antigravity'
        : (prepararConfiguracaoDoAntigravity({ casa, comandoDoGancho: opcoes.comandoDoGancho, comChave }) ?? prepararPastaDaSessao(pastaDaSessao, opcoes.pastaDasSessoes));
    if (problema !== null) {
      console.error(`motor antigravity: turno recusado: ${problema}`);
      return aoTextoInicial(`[awikabot] O Antigravity não rodou: ${problema}.`);
    }

    const unix = process.platform !== 'win32';
    const filho = spawn(opcoes.binario, [...(opcoes.prefixo ?? []), 'acp'], {
      cwd: pastaDaSessao,
      // O gancho do Antigravity herda este ambiente: é por ele que sabe de qual pasta o comando parte.
      env: { ...opcoes.ambiente, AWIKA_PASTA_DO_BOT: pedido.pasta },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Num grupo próprio, para que parar mate também os comandos que o Antigravity abriu.
      detached: unix,
    });

    let texto = '';
    let sessao = pedido.sessao;
    let fimDoTurno: string | null = null;
    let erroDoTurno = '';
    let parado = false;
    let corte: string | null = null;
    let encerrado = false;
    /** Só depois do pedido do turno o texto que chega é resposta. */
    let respondendo = false;
    /** Houve ferramenta desde o último trecho: o que vem depois é outro parágrafo. */
    let ferramentaNoMeio = false;
    let stderr = '';
    let resto = '';
    let proximoId = 1;
    const pendentes = new Map<number, { ok: (resultado: unknown) => void; falha: (erro: Error) => void }>();
    /** Chamadas de ferramenta que passaram por um pedido aceito. Uma que termina fora desta lista é corte. */
    const aprovadas = new Set<string>();
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
      filho.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...mensagem })}\n`);
    };

    const pedir = (metodo: string, parametros: Objeto): Promise<unknown> =>
      new Promise((ok, falha) => {
        const id = proximoId;
        proximoId += 1;
        pendentes.set(id, { ok, falha });
        escrever({ id, method: metodo, params: parametros });
      });

    const acrescentar = (trecho: string): void => {
      if (trecho === '') return;
      texto += trecho;
      pedido.aoTexto(trecho);
    };

    /** Uma ação que escapou do pedido de permissão: o turno acaba na hora. */
    const cortar = (motivo: string): void => {
      if (corte !== null || encerrado) return;
      corte = motivo;
      console.error(`motor antigravity: turno cortado: ${motivo}`);
      matar();
    };

    const decidir = async (id: unknown, parametros: Objeto): Promise<void> => {
      const chamada = objeto(parametros.toolCall) ?? {};
      const chamadaId = textoOuNulo(chamada.toolCallId);
      const consultas = consultasDoPedido(chamada, pedido.pasta);
      // Só "uma vez": nunca a opção que vale para a sessão. Cada ação passa por um cartão.
      const permitir = opcaoDoTipo(parametros.options, 'allow_once');
      let permitido = consultas !== null && chamadaId !== null && permitir !== null;
      for (const consulta of consultas ?? []) {
        if (!permitido) break;
        permitido = await consultarServidor(pedido.gancho, consulta);
      }
      if (permitido && chamadaId !== null && permitir !== null) {
        aprovadas.add(chamadaId);
        escrever({ id, result: { outcome: { outcome: 'selected', optionId: permitir } } });
        return;
      }
      const negar = opcaoDoTipo(parametros.options, 'reject_once');
      escrever({ id, result: { outcome: negar === null ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: negar } } });
    };

    const tratarPedidoDoMotor = (id: unknown, metodo: string, parametros: Objeto): void => {
      if (metodo === 'session/request_permission') {
        void decidir(id, parametros).catch(() => escrever({ id, result: { outcome: { outcome: 'cancelled' } } }));
        return;
      }
      // Arquivos e terminal do cliente, perguntas à pessoa: nada disso existe aqui. A recusa conta
      // como negação.
      escrever({ id, error: { code: -32601, message: 'não suportado pelo awikabot' } });
    };

    const tratarAviso = (metodo: string, parametros: Objeto): void => {
      if (metodo !== 'session/update') return;
      const atualizacao = objeto(parametros.update);
      const tipo = atualizacao?.sessionUpdate;
      if (tipo === 'agent_message_chunk') {
        const conteudo = objeto(atualizacao?.content);
        if (!respondendo || conteudo?.type !== 'text' || typeof conteudo.text !== 'string' || conteudo.text === '') return;
        if (ferramentaNoMeio && texto !== '') acrescentar('\n\n');
        ferramentaNoMeio = false;
        acrescentar(conteudo.text);
        return;
      }
      if (tipo === 'tool_call' || tipo === 'tool_call_update') {
        ferramentaNoMeio = true;
        const chamadaId = textoOuNulo(atualizacao?.toolCallId);
        // A ferramenta que termina sem ter passado por um pedido aceito agiu sem aprovação: a busca
        // na web, um subagente, um agendamento, ou uma leitura que o Antigravity achou livre. A
        // que o gancho ou a pessoa negou termina como `failed`, e não corta.
        if (atualizacao?.status === 'completed' && (chamadaId === null || !aprovadas.has(chamadaId))) {
          const nome = typeof atualizacao.kind === 'string' ? atualizacao.kind : 'desconhecida';
          cortar(`o Antigravity usou uma ferramenta do tipo "${nome}" sem pedir aprovação`);
        }
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
        tratarPedidoDoMotor(mensagem.id, metodo, parametros);
      } else if (metodo !== null) {
        tratarAviso(metodo, parametros);
      } else if (typeof mensagem.id === 'number' && pendentes.has(mensagem.id)) {
        const pendente = pendentes.get(mensagem.id);
        pendentes.delete(mensagem.id);
        const erro = objeto(mensagem.error);
        if (erro) pendente?.falha(new Error(typeof erro.message === 'string' ? erro.message : 'erro do Antigravity'));
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

    /** O valor atual de uma opção da sessão, como o Antigravity a devolveu. */
    const valorDaOpcao = (resposta: Objeto | null, opcao: string): string | null => {
      const opcoesDaSessao = Array.isArray(resposta?.configOptions) ? resposta.configOptions.map(objeto) : [];
      return textoOuNulo(opcoesDaSessao.find((item) => item?.id === opcao)?.currentValue);
    };

    const conduzir = async (): Promise<void> => {
      await pedir('initialize', {
        protocolVersion: 1,
        // O cliente não oferece arquivos nem terminal: o Antigravity usa as ferramentas dele, que pedem permissão.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'awikabot', title: 'awikabot', version: '0' },
      });
      if (comChave) await pedir('authenticate', { methodId: 'gemini-api-key' });
      const abertura = {
        cwd: pastaDaSessao,
        mcpServers: [],
        // As instruções do bot entram no fim do prompt do sistema; o texto da pessoa vai no corpo do pedido.
        _meta: { antigravity: { systemPrompt: { append: instrucoesDoTurno(pedido.instrucoes, pedido.pasta) } } },
      };
      // "resume", e não "load": retoma a conversa sem repetir o histórico como se fosse resposta.
      const aberta = objeto(pedido.sessao ? await pedir('session/resume', { sessionId: pedido.sessao, ...abertura }) : await pedir('session/new', abertura));
      const sessaoId = textoOuNulo(aberta?.sessionId) ?? pedido.sessao;
      if (sessaoId === null) throw new Error('o Antigravity não devolveu a conversa');
      sessao = sessaoId;
      // O modo padrão é o que pergunta antes de cada gravação e de cada comando. Outro modo aprovaria sozinho.
      if (valorDaOpcao(aberta, 'mode') !== 'default') {
        const trocado = objeto(await pedir('session/set_config_option', { sessionId: sessaoId, configId: 'mode', value: 'default' }));
        if (valorDaOpcao(trocado, 'mode') !== 'default') throw new Error('o Antigravity não entrou no modo que pede aprovação');
      }
      if (pedido.modelo) await pedir('session/set_config_option', { sessionId: sessaoId, configId: 'model', value: pedido.modelo });
      if (pedido.esforco) await pedir('session/set_config_option', { sessionId: sessaoId, configId: 'thought_level', value: pedido.esforco });
      if (parado) {
        matar();
        return;
      }
      respondendo = true;
      const fim = objeto(await pedir('session/prompt', { sessionId: sessaoId, prompt: [{ type: 'text', text: pedido.texto }] }));
      fimDoTurno = typeof fim?.stopReason === 'string' ? fim.stopReason : 'sem motivo';
      // O Antigravity já gravou o turno; o processo pode sair.
      filho.stdin.end();
      relogioDaSaida = setTimeout(matar, PRAZO_DA_SAIDA_MS);
      relogioDaSaida.unref();
    };

    const fim = new Promise<ResultadoMotor>((ok) => {
      const terminar = (codigo: number | null): void => {
        if (encerrado) return;
        encerrado = true;
        clearTimeout(relogioDaParada);
        clearTimeout(relogioDaSaida);
        tratarLinha(resto);
        for (const pendente of pendentes.values()) pendente.falha(new Error('o Antigravity saiu'));
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
        if (fimDoTurno === 'end_turn') {
          ok({ estado: 'completa', texto, sessao });
          return;
        }
        // O motivo bruto pode trazer trecho de conversa ou a conta: só a classe vai ao log e à conversa.
        const classe = classificarFalhaDoAntigravity(`${erroDoTurno}\n${stderr}`);
        console.error(`motor antigravity: saiu com código ${codigo}, turno ${fimDoTurno ?? 'não terminado'}; motivo: ${classe}`);
        if (texto === '') acrescentar(`O Antigravity não respondeu: ${classe}.`);
        // A sessão que não foi achada não volta a ser usada; as outras ficam, para tentar de novo.
        ok({ estado: 'falhou', texto, sessao: classe === 'sessão do motor não encontrada' ? null : sessao });
      };
      filho.on('error', (erro) => {
        console.error(`motor antigravity: não iniciou: ${erro.message}`);
        if (texto === '') acrescentar('O Antigravity não iniciou neste servidor.');
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
        // O cancelamento é um aviso, sem resposta: o turno fecha como "cancelled" e o processo sai.
        if (sessao !== null && respondendo) escrever({ method: 'session/cancel', params: { sessionId: sessao } });
        else matar();
        relogioDaParada = setTimeout(matar, opcoes.prazoDaParadaMs ?? PRAZO_DA_PARADA_MS);
        relogioDaParada.unref();
      },
    };
  };
}
