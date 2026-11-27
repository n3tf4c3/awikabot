import type { Aprovacao, Bot, Evento, ListaMensagens, RespostaTurno } from '@awikabot/core';
import {
  APROVACOES_VAZIAS,
  aplicarDecisao,
  aplicarEventoDeAprovacao,
  aplicarPendentes,
  aplicarResolvidas,
  type EstadoAprovacoes,
} from './aprovacoes';
import {
  CONVERSA_VAZIA,
  aplicarEvento,
  aplicarPaginaAnterior,
  aplicarPaginaRecente,
  aplicarTurnoEnviado,
  type EstadoConversa,
} from './conversa';

/** Situação do fluxo de eventos, para a tela avisar quando o texto ao vivo pode atrasar. */
export type Conexao = 'conectando' | 'conectada' | 'reconectando';

/**
 * Situação da busca dos pedidos de aprovação pendentes. Sem ela, uma busca que falha e uma lista
 * vazia são a mesma tela: o bot espera a aprovação e nenhum cartão aparece.
 */
export type CargaDeAprovacoes = 'carregando' | 'pronta' | 'falhou';

/** Tudo o que o app sabe do servidor enquanto está aberto. Nada disto vai para o disco. */
export interface EstadoDados {
  /** `null` até a primeira lista chegar. */
  readonly bots: readonly Bot[] | null;
  /**
   * Sobe a cada mudança nos bots que não veio de `GET /v1/bots`. Quem busca a lista compara
   * antes e depois: se subiu no meio do pedido, a resposta pode ser mais velha que a mudança.
   */
  readonly revisaoBots: number;
  /** Conversas abertas nesta execução do app, por id do bot. */
  readonly conversas: Readonly<Record<string, EstadoConversa>>;
  /**
   * Pedidos de aprovação de todos os bots: os pendentes, os resolvidos nesta execução do app e os
   * já resolvidos que vieram com as páginas das conversas.
   */
  readonly aprovacoes: EstadoAprovacoes;
  /** `carregando` até a primeira resposta de `GET /v1/aprovacoes`; depois, o desfecho da última busca. */
  readonly cargaDeAprovacoes: CargaDeAprovacoes;
  readonly conexao: Conexao;
}

export type AcaoDados =
  | { tipo: 'bots_carregados'; bots: readonly Bot[] }
  /** Bot devolvido por `POST` ou `PATCH`. */
  | { tipo: 'bot_gravado'; bot: Bot }
  | { tipo: 'conversa_aberta'; botId: string }
  | { tipo: 'pagina_recente'; botId: string; pagina: ListaMensagens }
  | { tipo: 'pagina_anterior'; botId: string; antes: number; pagina: ListaMensagens }
  | { tipo: 'turno_enviado'; botId: string; resposta: RespostaTurno }
  /** Lista de `GET /v1/aprovacoes`, com a revisão das aprovações que o app tinha ao pedi-la. */
  | { tipo: 'aprovacoes_carregadas'; pendentes: readonly Aprovacao[]; revisao: number }
  /** `GET /v1/aprovacoes` falhou: os pendentes que o app mostra podem estar incompletos. */
  | { tipo: 'aprovacoes_falharam' }
  /** Aprovação já resolvida, devolvida por `POST /v1/aprovacoes/:id`. */
  | { tipo: 'aprovacao_decidida'; aprovacao: Aprovacao }
  | { tipo: 'evento'; evento: Evento }
  | { tipo: 'conexao'; conexao: Conexao };

export const DADOS_INICIAIS: EstadoDados = {
  bots: null,
  revisaoBots: 0,
  conversas: {},
  aprovacoes: APROVACOES_VAZIAS,
  cargaDeAprovacoes: 'carregando',
  conexao: 'conectando',
};

/** Troca o bot de mesmo id ou põe o novo no fim, que é onde o servidor lista o mais recente. */
function gravarBot(bots: readonly Bot[] | null, bot: Bot): readonly Bot[] | null {
  if (bots === null) return null;
  return bots.some((atual) => atual.id === bot.id) ? bots.map((atual) => (atual.id === bot.id ? bot : atual)) : [...bots, bot];
}

function marcarTurno(bots: readonly Bot[] | null, botId: string, turnoAtivo: boolean): readonly Bot[] | null {
  if (bots === null || !bots.some((bot) => bot.id === botId && bot.turnoAtivo !== turnoAtivo)) return bots;
  return bots.map((bot) => (bot.id === botId ? { ...bot, turnoAtivo } : bot));
}

function naConversa(
  estado: EstadoDados,
  botId: string,
  mudar: (conversa: EstadoConversa) => EstadoConversa,
): EstadoDados {
  const atual = estado.conversas[botId];
  if (!atual) return estado;
  const nova = mudar(atual);
  return nova === atual ? estado : { ...estado, conversas: { ...estado.conversas, [botId]: nova } };
}

function aplicarEventoAosDados(estado: EstadoDados, evento: Evento): EstadoDados {
  switch (evento.tipo) {
    case 'bot_salvo':
      return { ...estado, bots: gravarBot(estado.bots, evento.bot), revisaoBots: estado.revisaoBots + 1 };
    case 'turno_iniciado':
    case 'turno_terminado': {
      const comBots: EstadoDados = {
        ...estado,
        bots: marcarTurno(estado.bots, evento.botId, evento.tipo === 'turno_iniciado'),
        revisaoBots: estado.revisaoBots + 1,
      };
      return naConversa(comBots, evento.botId, (conversa) => aplicarEvento(conversa, evento.botId, evento));
    }
    case 'texto':
      return naConversa(estado, evento.botId, (conversa) => aplicarEvento(conversa, evento.botId, evento));
    case 'aprovacao_pedida':
    case 'aprovacao_resolvida':
      return { ...estado, aprovacoes: aplicarEventoDeAprovacao(estado.aprovacoes, evento) };
    case 'ressincronizar': {
      const conversas = Object.fromEntries(
        Object.entries(estado.conversas).map(([botId, conversa]) => [botId, aplicarEvento(conversa, botId, evento)] as const),
      );
      return { ...estado, conversas };
    }
  }
}

/**
 * Guarda os pedidos já resolvidos que vieram com uma página da conversa. Valem mesmo que a página
 * não tenha entrado na conversa: o desfecho de um pedido não depende de onde a pessoa está.
 */
function comResolvidasDaPagina(estado: EstadoDados, pagina: ListaMensagens): EstadoDados {
  // Servidor anterior ao campo não o manda.
  const aprovacoes = aplicarResolvidas(estado.aprovacoes, pagina.aprovacoes ?? []);
  return aprovacoes === estado.aprovacoes ? estado : { ...estado, aprovacoes };
}

export function redutorDados(estado: EstadoDados, acao: AcaoDados): EstadoDados {
  switch (acao.tipo) {
    case 'bots_carregados':
      return { ...estado, bots: acao.bots };
    case 'bot_gravado': {
      // Quem diz se o bot está respondendo é o fluxo de eventos. A resposta de um POST ou PATCH pode
      // ter sido montada antes do começo ou do fim de um turno e não mexe nesse campo de bot já conhecido.
      const conhecido = estado.bots?.find((bot) => bot.id === acao.bot.id);
      const bot = conhecido ? { ...acao.bot, turnoAtivo: conhecido.turnoAtivo } : acao.bot;
      return { ...estado, bots: gravarBot(estado.bots, bot), revisaoBots: estado.revisaoBots + 1 };
    }
    case 'conversa_aberta':
      if (estado.conversas[acao.botId]) return estado;
      return { ...estado, conversas: { ...estado.conversas, [acao.botId]: CONVERSA_VAZIA } };
    case 'pagina_recente':
      return comResolvidasDaPagina(
        naConversa(estado, acao.botId, (conversa) => aplicarPaginaRecente(conversa, acao.pagina)),
        acao.pagina,
      );
    case 'pagina_anterior':
      return comResolvidasDaPagina(
        naConversa(estado, acao.botId, (conversa) => aplicarPaginaAnterior(conversa, acao.antes, acao.pagina)),
        acao.pagina,
      );
    case 'turno_enviado': {
      const comConversa = naConversa(estado, acao.botId, (conversa) => aplicarTurnoEnviado(conversa, acao.resposta));
      // Se o evento do fim do turno chegou antes desta resposta, o bot já não está respondendo.
      const resposta = comConversa.conversas[acao.botId]?.mensagens.find((mensagem) => mensagem.id === acao.resposta.bot.id);
      if (resposta && resposta.estado !== 'em_andamento') return comConversa;
      return { ...comConversa, bots: marcarTurno(comConversa.bots, acao.botId, true), revisaoBots: estado.revisaoBots + 1 };
    }
    case 'aprovacoes_carregadas': {
      // A busca deu certo mesmo quando a lista chega velha e não entra: quem decide isso é a revisão.
      const aprovacoes = aplicarPendentes(estado.aprovacoes, acao.pendentes, acao.revisao);
      if (aprovacoes === estado.aprovacoes && estado.cargaDeAprovacoes === 'pronta') return estado;
      return { ...estado, aprovacoes, cargaDeAprovacoes: 'pronta' };
    }
    case 'aprovacoes_falharam':
      return estado.cargaDeAprovacoes === 'falhou' ? estado : { ...estado, cargaDeAprovacoes: 'falhou' };
    case 'aprovacao_decidida': {
      const aprovacoes = aplicarDecisao(estado.aprovacoes, acao.aprovacao);
      return aprovacoes === estado.aprovacoes ? estado : { ...estado, aprovacoes };
    }
    case 'evento':
      return aplicarEventoAosDados(estado, acao.evento);
    case 'conexao':
      return estado.conexao === acao.conexao ? estado : { ...estado, conexao: acao.conexao };
  }
}

export interface Armazem<Estado, Acao> {
  estado(): Estado;
  despachar(acao: Acao): void;
  /** Avisa a cada mudança de estado. Devolve a função que cancela a assinatura. */
  assinar(ouvinte: () => void): () => void;
}

/** Estado fora do React, com assinatura: serve ao `useSyncExternalStore` e aos testes. */
export function criarArmazem<Estado, Acao>(
  redutor: (estado: Estado, acao: Acao) => Estado,
  inicial: Estado,
): Armazem<Estado, Acao> {
  let estado = inicial;
  const ouvintes = new Set<() => void>();
  return {
    estado: () => estado,
    despachar(acao) {
      const novo = redutor(estado, acao);
      if (novo === estado) return;
      estado = novo;
      for (const ouvinte of [...ouvintes]) ouvinte();
    },
    assinar(ouvinte) {
      ouvintes.add(ouvinte);
      return () => {
        ouvintes.delete(ouvinte);
      };
    },
  };
}

export type ArmazemDados = Armazem<EstadoDados, AcaoDados>;

export function criarArmazemDados(): ArmazemDados {
  return criarArmazem(redutorDados, DADOS_INICIAIS);
}
