import { ESPERA_APROVACAO_MS, type Aprovacao } from '@awikabot/core';
import type { Banco } from './banco';
import { obterBot } from './bots';
import { enderecosDeAviso, esquecerEnderecoDeAviso } from './dispositivos';

/** Onde o serviço de push da Expo recebe os avisos, que ele entrega à Apple e ao Google. */
export const ENDERECO_DO_SERVICO_DA_EXPO = 'https://exp.host/--/api/v2/push/send';

/** O canal de avisos do Android que o app cria; um aviso sem canal cai no padrão, mais discreto. */
export const CANAL_DE_APROVACOES = 'aprovacoes';

/** Quanto o servidor espera o serviço de push responder. O aviso é melhor esforço: nada espera por ele. */
const PRAZO_DO_SERVICO_MS = 10_000;

/** O serviço da Expo aceita até cem avisos por pedido. */
const AVISOS_POR_PEDIDO = 100;

/** Um aviso, na forma que o serviço da Expo recebe. */
export interface MensagemDeAviso {
  to: string;
  title: string;
  body: string;
  data: { botId: string };
  sound: 'default';
  priority: 'high';
  channelId: string;
  /** Segundos: depois do prazo do pedido, o aviso não serve mais e não precisa chegar. */
  ttl: number;
}

export type Buscar = (endereco: string, pedido: RequestInit) => Promise<Response>;

/**
 * Avisa os aparelhos pareados de que um bot pede aprovação, pelo serviço de push da Expo, para o
 * aviso chegar com o app fechado. O aviso vai a um terceiro e aparece na tela de bloqueio: leva só
 * o nome do bot e o id dele, para o toque abrir a conversa. O pedido, a ferramenta e o comando
 * ficam no servidor; quem decide lê o pedido inteiro no cartão.
 *
 * É melhor esforço: uma falha do serviço não muda nada no pedido, que segue à espera no app.
 * O endereço que o serviço diz não existir mais é esquecido.
 */
export class AvisoPush {
  private readonly banco: Banco;
  private readonly endereco: string;
  private readonly buscar: Buscar;
  private readonly prazoMs: number;

  constructor(deps: { banco: Banco; endereco?: string; buscar?: Buscar; prazoMs?: number }) {
    this.banco = deps.banco;
    this.endereco = deps.endereco ?? ENDERECO_DO_SERVICO_DA_EXPO;
    this.buscar = deps.buscar ?? ((endereco, pedido) => fetch(endereco, pedido));
    this.prazoMs = deps.prazoMs ?? PRAZO_DO_SERVICO_MS;
  }

  /** Nunca rejeita. Devolve quantos avisos o serviço aceitou, para o teste e o log. */
  async avisarPedido(aprovacao: Aprovacao): Promise<number> {
    const destinos = enderecosDeAviso(this.banco);
    if (destinos.length === 0) return 0;
    const nome = obterBot(this.banco, aprovacao.botId)?.nome ?? 'Um bot';
    const mensagens: MensagemDeAviso[] = destinos.map((destino) => ({
      to: destino.endereco,
      title: `${nome} pede aprovação`,
      body: 'Abra o awikabot para ver o pedido e decidir.',
      data: { botId: aprovacao.botId },
      sound: 'default',
      priority: 'high',
      channelId: CANAL_DE_APROVACOES,
      ttl: Math.floor(ESPERA_APROVACAO_MS / 1000),
    }));
    let aceitos = 0;
    for (let inicio = 0; inicio < mensagens.length; inicio += AVISOS_POR_PEDIDO) {
      const lote = mensagens.slice(inicio, inicio + AVISOS_POR_PEDIDO);
      aceitos += await this.enviar(lote, destinos.slice(inicio, inicio + AVISOS_POR_PEDIDO));
    }
    return aceitos;
  }

  private async enviar(lote: MensagemDeAviso[], destinos: { dispositivoId: string; endereco: string }[]): Promise<number> {
    let resposta: Response;
    try {
      resposta = await this.buscar(this.endereco, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(lote),
        signal: AbortSignal.timeout(this.prazoMs),
      });
    } catch (erro) {
      // Sem o endereço de aviso nem o conteúdo no log: só a classe do erro.
      console.error(`aviso push: o serviço não respondeu (${erro instanceof Error ? erro.name : 'erro desconhecido'})`);
      return 0;
    }
    if (!resposta.ok) {
      console.error(`aviso push: o serviço recusou o pedido (status ${resposta.status})`);
      return 0;
    }
    let corpo: unknown;
    try {
      corpo = await resposta.json();
    } catch {
      console.error('aviso push: a resposta do serviço não é JSON');
      return 0;
    }
    const recibos = (corpo as { data?: unknown } | null)?.data;
    if (!Array.isArray(recibos)) return 0;
    let aceitos = 0;
    recibos.forEach((recibo: unknown, indice) => {
      const destino = destinos[indice];
      if (!destino || typeof recibo !== 'object' || recibo === null) return;
      const { status, details } = recibo as { status?: unknown; details?: { error?: unknown } };
      if (status === 'ok') {
        aceitos += 1;
      } else if (details?.error === 'DeviceNotRegistered') {
        // O app foi desinstalado ou o aparelho não recebe mais: o endereço não serve para nada.
        // Com o servidor saindo, o banco pode já ter fechado: fica para o próximo aviso.
        if (this.banco.isOpen) esquecerEnderecoDeAviso(this.banco, destino.dispositivoId, destino.endereco);
      } else {
        console.error(`aviso push: um aviso foi recusado (${typeof details?.error === 'string' ? details.error : 'sem motivo'})`);
      }
    });
    return aceitos;
  }
}
