import { spawn } from 'node:child_process';
import { ESPERA_APROVACAO_MS } from '@awikabot/core';
import type { Motor, ResultadoMotor } from './motor';

/** Prazo do gancho, em segundos: a espera da aprovação mais uma folga. */
const PRAZO_DO_GANCHO_S = Math.ceil(ESPERA_APROVACAO_MS / 1000) + 60;

/**
 * Dirige o binário do Claude Code sem modificação, em modo não interativo.
 * O login é o da pessoa dona do servidor, feito pelo próprio Claude Code; este código nunca o lê.
 */
export function criarMotorClaudeCode(opcoes: { binario: string }): Motor {
  return (pedido) => {
    // Toda opção vai na forma `--nome=valor`, e o texto da pessoa vai pela entrada padrão:
    // assim nenhum valor vindo do app é lido como opção de linha de comando.
    const args = ['-p', '--output-format=stream-json', '--verbose', '--include-partial-messages', '--permission-mode=default'];
    if (pedido.instrucoes) args.push(`--append-system-prompt=${pedido.instrucoes}`);
    if (pedido.modelo) args.push(`--model=${pedido.modelo}`);
    if (pedido.sessao) args.push(`--resume=${pedido.sessao}`);

    const ambiente = { ...process.env };
    if (pedido.gancho) {
      // O gancho roda antes de toda ferramenta. Quem decide é o servidor: leitura dentro da
      // pasta do bot passa, o resto espera a pessoa. O prazo cobre a espera inteira da aprovação.
      const configuracao = {
        hooks: {
          PreToolUse: [
            { matcher: '*', hooks: [{ type: 'command', command: pedido.gancho.comando, timeout: PRAZO_DO_GANCHO_S }] },
          ],
        },
      };
      args.push(`--settings=${JSON.stringify(configuracao)}`);
      ambiente.AWIKA_PORTA_GANCHO = String(pedido.gancho.porta);
      ambiente.AWIKA_TURNO_TOKEN = pedido.gancho.token;
    }

    const filho = spawn(opcoes.binario, args, { cwd: pedido.pasta, env: ambiente, stdio: ['pipe', 'pipe', 'pipe'] });

    let texto = '';
    let sessao = pedido.sessao;
    let parado = false;
    let resultadoComErro: boolean | null = null;
    let textoDoResultado: string | null = null;
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
        if (falhou) console.error(`motor: saiu com código ${codigo}. ${stderr.trim().slice(-400)}`);
        ok({ estado: falhou ? 'falhou' : 'completa', texto, sessao });
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
