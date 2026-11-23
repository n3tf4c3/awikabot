import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { Hono } from 'hono';
import { LIMITES } from '@awikabot/core';
import type { GestorDeAprovacoes } from './aprovacoes';
import { novoToken } from './ids';
import { avaliarFerramenta } from './politica';

export interface TurnoRegistrado {
  botId: string;
  mensagemId: string;
  /** Pasta de trabalho do bot, absoluta. */
  pasta: string;
}

/** Liga cada turno em curso a um token que só o gancho daquele turno conhece. */
export class Ganchos {
  private readonly turnos = new Map<string, TurnoRegistrado>();

  registrar(turno: TurnoRegistrado): string {
    const token = novoToken();
    this.turnos.set(token, turno);
    return token;
  }

  remover(token: string): void {
    this.turnos.delete(token);
  }

  obter(token: string): TurnoRegistrado | undefined {
    return this.turnos.get(token);
  }
}

export interface RespostaDoGancho {
  decisao: 'allow' | 'deny';
  motivo: string;
}

/**
 * Onde o gancho do motor pergunta se pode usar uma ferramenta. Este app escuta só em
 * loopback, numa porta que não é publicada. O token do turno deixa pedir uma aprovação;
 * aprovar só quem tem token de aparelho, pela API.
 */
export function criarAppDoGancho(deps: { ganchos: Ganchos; aprovacoes: GestorDeAprovacoes }): Hono {
  const app = new Hono();

  app.post('/gancho', async (c) => {
    const turno = deps.ganchos.obter(c.req.header('x-awika-turno') ?? '');
    if (!turno) return c.json<RespostaDoGancho>({ decisao: 'deny', motivo: 'turno desconhecido' }, 401);

    let pedido: Record<string, unknown>;
    try {
      const lido: unknown = await c.req.json();
      if (typeof lido !== 'object' || lido === null) throw new Error('corpo não é objeto');
      pedido = lido as Record<string, unknown>;
    } catch {
      return c.json<RespostaDoGancho>({ decisao: 'deny', motivo: 'pedido ilegível' }, 400);
    }
    const ferramenta = typeof pedido.tool_name === 'string' ? pedido.tool_name.slice(0, LIMITES.ferramenta) : '';
    if (ferramenta === '') return c.json<RespostaDoGancho>({ decisao: 'deny', motivo: 'ferramenta sem nome' }, 400);
    const entrada =
      typeof pedido.tool_input === 'object' && pedido.tool_input !== null ? (pedido.tool_input as Record<string, unknown>) : {};

    const veredito = avaliarFerramenta(ferramenta, entrada, turno.pasta);
    if (veredito.acao === 'permitir') return c.json<RespostaDoGancho>({ decisao: 'allow', motivo: 'leitura dentro da pasta do bot' });
    if (veredito.acao === 'negar') return c.json<RespostaDoGancho>({ decisao: 'deny', motivo: veredito.motivo });

    const decisao = await deps.aprovacoes.pedir({
      botId: turno.botId,
      mensagemId: turno.mensagemId,
      ferramenta,
      resumo: veredito.resumo,
    });
    return c.json<RespostaDoGancho>(
      decisao === 'aprovar'
        ? { decisao: 'allow', motivo: 'aprovado pela pessoa' }
        : { decisao: 'deny', motivo: 'negado pela pessoa, ou sem resposta a tempo' },
    );
  });

  return app;
}

/**
 * O lado do gancho que o Claude Code executa antes de cada ferramenta (`PreToolUse`):
 * repassa o pedido ao servidor e espera a resposta pelo tempo que for. Qualquer falha nega.
 */
export async function executarGancho(): Promise<void> {
  const responder = (decisao: 'allow' | 'deny', motivo: string): void => {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decisao, permissionDecisionReason: motivo },
      }),
    );
  };

  const porta = Number(process.env.AWIKA_PORTA_GANCHO);
  const token = process.env.AWIKA_TURNO_TOKEN;
  if (!Number.isInteger(porta) || porta < 1 || !token) {
    responder('deny', 'gancho sem configuração');
    return;
  }

  let entrada = '{}';
  try {
    entrada = readFileSync(0, 'utf8') || '{}';
  } catch {
    // Sem entrada, o servidor recebe um pedido vazio e nega.
  }

  await new Promise<void>((fim) => {
    // `node:http` não tem limite de espera por padrão; a pessoa pode levar minutos para responder.
    const pedido = request(
      {
        host: '127.0.0.1',
        port: porta,
        path: '/gancho',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-awika-turno': token },
      },
      (resposta) => {
        let corpo = '';
        resposta.setEncoding('utf8');
        resposta.on('data', (parte: string) => {
          corpo += parte;
        });
        resposta.on('end', () => {
          try {
            const lido = JSON.parse(corpo) as Partial<RespostaDoGancho>;
            responder(lido.decisao === 'allow' ? 'allow' : 'deny', typeof lido.motivo === 'string' ? lido.motivo : '');
          } catch {
            responder('deny', 'resposta ilegível do servidor');
          }
          fim();
        });
      },
    );
    pedido.on('error', () => {
      responder('deny', 'servidor de aprovação fora do ar');
      fim();
    });
    pedido.end(entrada);
  });
}
