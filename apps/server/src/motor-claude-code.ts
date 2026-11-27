import { spawn } from 'node:child_process';
import { configuracaoPorOpcao } from './configuracao-motor';
import type { Motor, PedidoMotor, ResultadoMotor } from './motor';

/** Reduz a saída do motor a uma classe conhecida de falha, que é o que cabe num log. */
export function classificarFalha(saida: string): string {
  if (/no conversation found/i.test(saida)) return 'sessão do motor não encontrada';
  if (/\/login|not logged in|authentication|unauthorized|invalid api key|oauth/i.test(saida)) return 'motor sem login válido';
  if (/usage limit|rate limit|overloaded|quota/i.test(saida)) return 'limite de uso do motor';
  return saida.trim() === '' ? 'sem saída de erro' : 'não classificado';
}

/**
 * A linha de comando e o ambiente de um turno. Toda opção vai na forma `--nome=valor`, e o texto
 * da pessoa vai pela entrada padrão: nenhum valor vindo do app é lido como opção.
 */
export function prepararChamada(
  pedido: Pick<PedidoMotor, 'instrucoes' | 'modelo' | 'esforco' | 'sessao' | 'gancho' | 'saida'>,
  opcoes: { ambiente: Record<string, string>; ganchoGerenciado: boolean },
): { args: string[]; ambiente: Record<string, string> } {
  const args = ['-p', '--output-format=stream-json', '--verbose', '--include-partial-messages', '--permission-mode=default'];
  // A pasta de trabalho é do bot: o que ele deixar em `.claude/` ou em `.mcp.json` não é lido como
  // configuração. Sem isto, um gancho gravado ali rodaria comandos no turno seguinte, sem aprovação.
  args.push('--setting-sources=user');
  if (pedido.saida) {
    // Turno de decisão: nenhuma ferramenta nem servidor MCP. A única ferramenta que sobra é a
    // `StructuredOutput`, por onde o motor entrega a resposta presa ao esquema; ela passa pelo
    // gancho como as outras, e a política só a deixa passar no turno de um decisor.
    args.push('--tools=', '--strict-mcp-config', `--json-schema=${JSON.stringify(pedido.saida.esquema)}`);
  }
  if (pedido.instrucoes) args.push(`--append-system-prompt=${pedido.instrucoes}`);
  if (pedido.modelo) args.push(`--model=${pedido.modelo}`);
  if (pedido.esforco) args.push(`--effort=${pedido.esforco}`);
  if (pedido.sessao) args.push(`--resume=${pedido.sessao}`);

  // Só o que `ambienteDoMotor` deixou passar: a configuração do servidor não chega ao bot.
  const ambiente = { ...opcoes.ambiente };
  if (pedido.gancho) {
    // O gancho roda antes de toda ferramenta. Quem decide é o servidor: leitura dentro da
    // pasta do bot passa, o resto espera a pessoa. O prazo cobre a espera inteira da aprovação.
    if (!opcoes.ganchoGerenciado) args.push(`--settings=${JSON.stringify(configuracaoPorOpcao(pedido.gancho.comando))}`);
    ambiente.AWIKA_PORTA_GANCHO = String(pedido.gancho.porta);
    ambiente.AWIKA_TURNO_TOKEN = pedido.gancho.token;
  }
  return { args, ambiente };
}

/**
 * Dirige o binário do Claude Code sem modificação, em modo não interativo.
 * O login é o da pessoa dona do servidor, feito pelo próprio Claude Code; este código nunca o lê.
 */
export function criarMotorClaudeCode(opcoes: {
  binario: string;
  /** O que vem antes das opções: nos testes, um Claude Code de mentira rodado pelo Node. */
  prefixo?: string[];
  ambiente: Record<string, string>;
  /** Na imagem, o gancho já está na configuração gerenciada do motor e não vai na linha de comando. */
  ganchoGerenciado: boolean;
}): Motor {
  return (pedido) => {
    const { args, ambiente } = prepararChamada(pedido, opcoes);
    const filho = spawn(opcoes.binario, [...(opcoes.prefixo ?? []), ...args], { cwd: pedido.pasta, env: ambiente, stdio: ['pipe', 'pipe', 'pipe'] });

    let texto = '';
    let sessao = pedido.sessao;
    let parado = false;
    let resultadoComErro: boolean | null = null;
    let textoDoResultado: string | null = null;
    let estruturada: unknown;
    let resto = '';
    let stderr = '';

    const tratarLinha = (linha: string): void => {
      if (!linha.trim()) return;
      let evento: Record<string, unknown>;
      try {
        const lido: unknown = JSON.parse(linha);
        if (typeof lido !== 'object' || lido === null) return;
        evento = lido as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof evento.session_id === 'string') sessao = evento.session_id;
      if (evento.type === 'stream_event') {
        const delta = (evento.event as { delta?: { type?: unknown; text?: unknown } } | undefined)?.delta;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          texto += delta.text;
          pedido.aoTexto(delta.text);
        }
      } else if (evento.type === 'result') {
        resultadoComErro = evento.is_error === true;
        if (typeof evento.result === 'string') textoDoResultado = evento.result;
        // Com `--json-schema`, a resposta presa ao esquema vem aqui, fora do texto.
        if ('structured_output' in evento) estruturada = evento.structured_output;
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
    // O motor pode sair antes de ler a entrada; o erro de escrita não deve derrubar o servidor.
    filho.stdin.on('error', () => {});
    filho.stdin.end(pedido.texto);

    const fim = new Promise<ResultadoMotor>((ok) => {
      filho.on('error', (erro) => {
        console.error(`motor: não iniciou: ${erro.message}`);
        ok({ estado: 'falhou', texto, sessao: pedido.sessao });
      });
      filho.on('close', (codigo) => {
        tratarLinha(resto);
        if (parado) {
          ok({ estado: 'parada', texto, sessao });
          return;
        }
        const falhou = codigo !== 0 || resultadoComErro !== false;
        // Sem trechos, o texto do resultado é a resposta (ou o motivo da falha, como a falta de login).
        if (texto === '' && textoDoResultado !== null) {
          texto = textoDoResultado;
          pedido.aoTexto(textoDoResultado);
        }
        // O texto da saída de erro não vai para o log: pode trazer trecho de conversa ou a conta.
        if (falhou) console.error(`motor: saiu com código ${codigo}; motivo: ${classificarFalha(stderr + (textoDoResultado ?? ''))}`);
        ok({ estado: falhou ? 'falhou' : 'completa', texto, sessao, ...(pedido.saida ? { estruturada } : {}) });
      });
    });

    return {
      fim,
      parar: () => {
        parado = true;
        filho.kill('SIGTERM');
      },
    };
  };
}
