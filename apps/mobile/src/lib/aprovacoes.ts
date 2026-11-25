import type { Aprovacao, Evento, Mensagem } from '@awikabot/core';

/**
 * Os pedidos de aprovação que o app conhece: os pendentes, os resolvidos nesta execução e os já
 * resolvidos que vieram com as páginas da conversa.
 */
export interface EstadoAprovacoes {
  readonly porId: Readonly<Record<string, Aprovacao>>;
  /**
   * Sobe a cada evento de aprovação. Quem busca a lista de pendentes guarda o valor antes do
   * pedido: se subiu no meio, a lista pode ser mais velha que o evento e não manda em nada.
   */
  readonly revisao: number;
}

export const APROVACOES_VAZIAS: EstadoAprovacoes = { porId: {}, revisao: 0 };

type EventoDeAprovacao = Extract<Evento, { tipo: 'aprovacao_pedida' | 'aprovacao_resolvida' }>;

function pendente(aprovacao: Aprovacao): boolean {
  return aprovacao.estado === 'pendente';
}

/**
 * Guarda a aprovação recebida. O pedido resolvido não muda mais: uma cópia pendente que chega
 * atrasada (lista velha, evento repetido) não desfaz o desfecho que o app já conhece.
 */
function guardar(porId: Readonly<Record<string, Aprovacao>>, recebida: Aprovacao): Readonly<Record<string, Aprovacao>> {
  const local = porId[recebida.id];
  if (local && (local.estado === recebida.estado || !pendente(local))) return porId;
  return { ...porId, [recebida.id]: recebida };
}

/** Aplica `aprovacao_pedida` ou `aprovacao_resolvida`. A resolvida de um pedido desconhecido entra do mesmo jeito. */
export function aplicarEventoDeAprovacao(estado: EstadoAprovacoes, evento: EventoDeAprovacao): EstadoAprovacoes {
  return { porId: guardar(estado.porId, evento.aprovacao), revisao: estado.revisao + 1 };
}

/** Aplica a aprovação já resolvida que o servidor devolveu a uma decisão. */
export function aplicarDecisao(estado: EstadoAprovacoes, aprovacao: Aprovacao): EstadoAprovacoes {
  const porId = guardar(estado.porId, aprovacao);
  return porId === estado.porId ? estado : { ...estado, porId };
}

/**
 * Aplica os pedidos já resolvidos que vieram com uma página da conversa. O desfecho não muda
 * mais, então a página nunca é velha demais para isto, e a revisão não sobe. Um pendente que
 * viesse aqui não entra: quem diz o que espera a pessoa é a lista de pendentes e o fluxo.
 */
export function aplicarResolvidas(estado: EstadoAprovacoes, resolvidas: readonly Aprovacao[]): EstadoAprovacoes {
  let porId = estado.porId;
  for (const recebida of resolvidas) {
    if (!pendente(recebida)) porId = guardar(porId, recebida);
  }
  return porId === estado.porId ? estado : { ...estado, porId };
}

/**
 * Aplica a lista de pendentes de `GET /v1/aprovacoes`. `revisaoNoPedido` é a revisão que o app
 * tinha ao pedir a lista.
 *
 * Lista em dia: o pendente local que não está nela deixou de ser pendente no servidor e sai.
 * Lista possivelmente velha (chegou evento de aprovação durante o pedido): só entram os pedidos
 * que o app não conhecia; nada sai e nada é trocado, e quem buscou busca de novo.
 */
export function aplicarPendentes(
  estado: EstadoAprovacoes,
  pendentes: readonly Aprovacao[],
  revisaoNoPedido: number,
): EstadoAprovacoes {
  const emDia = estado.revisao === revisaoNoPedido;
  const naLista = new Set(pendentes.map((aprovacao) => aprovacao.id));
  let porId: Readonly<Record<string, Aprovacao>> = estado.porId;

  if (emDia) {
    const ficam = Object.values(estado.porId).filter((local) => !pendente(local) || naLista.has(local.id));
    if (ficam.length !== Object.keys(estado.porId).length) {
      porId = Object.fromEntries(ficam.map((aprovacao) => [aprovacao.id, aprovacao] as const));
    }
  }
  for (const recebida of pendentes) {
    if (emDia || !porId[recebida.id]) porId = guardar(porId, recebida);
  }
  return porId === estado.porId ? estado : { ...estado, porId };
}

function porCriacao(a: Aprovacao, b: Aprovacao): number {
  return a.criadaEm - b.criadaEm || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** As aprovações de um bot, da mais antiga para a mais nova. */
export function aprovacoesDoBot(estado: EstadoAprovacoes, botId: string): Aprovacao[] {
  return Object.values(estado.porId)
    .filter((aprovacao) => aprovacao.botId === botId)
    .sort(porCriacao);
}

/** O que a lista de bots diz de um bot que não está parado. */
export type SituacaoDoBot = 'aguardando_aprovacao' | 'respondendo';

/**
 * Pedido de aprovação pendente vem antes de "respondendo": o bot está parado à espera da pessoa,
 * e é isso que ela precisa saber.
 */
export function situacaoDoBot(bot: { id: string; turnoAtivo: boolean }, estado: EstadoAprovacoes): SituacaoDoBot | null {
  const aguardando = Object.values(estado.porId).some((aprovacao) => aprovacao.botId === bot.id && pendente(aprovacao));
  if (aguardando) return 'aguardando_aprovacao';
  return bot.turnoAtivo ? 'respondendo' : null;
}

export function rotuloDaSituacao(situacao: SituacaoDoBot): string {
  return situacao === 'aguardando_aprovacao' ? 'aguardando aprovação' : 'respondendo…';
}

/** A palavra da linha compacta de um pedido resolvido; `null` enquanto está pendente. */
export function rotuloDoDesfecho(estado: Aprovacao['estado']): string | null {
  if (estado === 'aprovada') return 'Aprovada';
  if (estado === 'negada') return 'Negada';
  if (estado === 'expirada') return 'Expirada';
  return null;
}

/** Uma linha da conversa: uma mensagem ou um pedido de aprovação. */
export type ItemDaConversa = Mensagem | Aprovacao;

export function ehAprovacao(item: ItemDaConversa): item is Aprovacao {
  return 'ferramenta' in item;
}

/** Chave de lista: mensagem e aprovação têm ids do mesmo formato, então o tipo entra na chave. */
export function chaveDoItem(item: ItemDaConversa): string {
  return `${ehAprovacao(item) ? 'aprovacao' : 'mensagem'}:${item.id}`;
}

/**
 * Põe cada aprovação logo depois da resposta do bot em que ela surgiu. Entrada e saída vão da
 * mais nova para a mais antiga, como a lista invertida da conversa pede. O pedido pendente cuja
 * mensagem o app ainda não tem fica no fim da conversa, à vista; o resolvido nessa situação não
 * aparece, porque não haveria onde encaixá-lo.
 */
export function intercalarAprovacoes(mensagens: readonly Mensagem[], aprovacoes: readonly Aprovacao[]): ItemDaConversa[] {
  if (aprovacoes.length === 0) return [...mensagens];
  const conhecidas = new Set(mensagens.map((mensagem) => mensagem.id));
  const daMaisNova = [...aprovacoes].sort(porCriacao).reverse();
  const itens: ItemDaConversa[] = daMaisNova.filter((aprovacao) => pendente(aprovacao) && !conhecidas.has(aprovacao.mensagemId));
  for (const mensagem of mensagens) {
    for (const aprovacao of daMaisNova) {
      if (aprovacao.mensagemId === mensagem.id) itens.push(aprovacao);
    }
    itens.push(mensagem);
  }
  return itens;
}
