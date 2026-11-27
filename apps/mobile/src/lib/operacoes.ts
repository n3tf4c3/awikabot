import {
  EsquemaPedidoTurno,
  LIMITES,
  type Bot,
  type BotEdicao,
  type BotEntrada,
  type DecisaoAprovacao,
} from '@awikabot/core';
import type { Api } from './api';
import type { ArmazemDados } from './dados';
import { CODIGOS_DO_APP, ErroApi, temCodigo } from './erros';

/** O que as telas pedem: cada operação fala com o servidor e põe o resultado no armazém. */
export interface Operacoes {
  carregarBots(): Promise<void>;
  criarBot(entrada: BotEntrada): Promise<Bot>;
  editarBot(id: string, edicao: BotEdicao): Promise<Bot>;
  /** Abre a conversa (se ainda não estava aberta) e busca a página mais recente. */
  carregarConversa(botId: string): Promise<void>;
  /** Busca a página anterior à mensagem mais antiga já carregada, se houver. */
  carregarAnteriores(botId: string): Promise<void>;
  enviar(botId: string, texto: string): Promise<void>;
  parar(botId: string): Promise<void>;
  /** Busca os pedidos de aprovação pendentes de todos os bots. */
  carregarAprovacoes(): Promise<void>;
  /**
   * Manda a decisão ao servidor. O pedido só muda no app com a resposta dele: `decidida` quando
   * o servidor aceitou, `ja_resolvida` quando o pedido já não estava pendente (aí a lista de
   * pendentes é buscada de novo). Falha de rede ou demora rejeita e não mexe em nada.
   */
  decidirAprovacao(id: string, decisao: DecisaoAprovacao['decisao']): Promise<'decidida' | 'ja_resolvida'>;
}

/** Quantas rodadas seguidas uma carga faz por conta própria quando o estado muda durante o pedido. */
const RODADAS_SEGUIDAS = 3;

/**
 * Junta chamadas simultâneas numa carga só e repete a busca enquanto o resultado pode ser velho:
 * - quem chama com uma carga em curso recebe a mesma promessa e garante mais uma rodada, porque
 *   o pedido em curso pode ser anterior ao motivo da chamada;
 * - a rodada devolve `true` quando o estado mudou por evento enquanto o pedido corria. Aí a carga
 *   busca de novo sozinha, até `RODADAS_SEGUIDAS` vezes; na última, `rodada` recebe `true`.
 */
function cargaUnica(rodada: (ultima: boolean) => Promise<boolean>): () => Promise<void> {
  let emCurso: Promise<void> | null = null;
  let repetir = false;
  return () => {
    if (emCurso) {
      repetir = true;
      return emCurso;
    }
    emCurso = (async () => {
      try {
        let seguidas = 0;
        for (;;) {
          repetir = false;
          seguidas += 1;
          const podeSerVelho = await rodada(seguidas === RODADAS_SEGUIDAS);
          if (repetir) seguidas = 0;
          else if (!podeSerVelho || seguidas === RODADAS_SEGUIDAS) return;
        }
      } finally {
        emCurso = null;
      }
    })();
    return emCurso;
  };
}

export function criarOperacoes(api: Api, armazem: ArmazemDados): Operacoes {
  const carregarBots = cargaUnica(async (ultima) => {
    const revisao = armazem.estado().revisaoBots;
    const { bots } = await api.listarBots();
    const mudouNoMeio = armazem.estado().revisaoBots !== revisao;
    // Lista possivelmente velha só entra se for a primeira que o app tem ou se as rodadas acabaram.
    if (!mudouNoMeio || ultima || armazem.estado().bots === null) armazem.despachar({ tipo: 'bots_carregados', bots });
    return mudouNoMeio;
  });

  const carregarAprovacoes = cargaUnica(async () => {
    const revisao = armazem.estado().aprovacoes.revisao;
    const { aprovacoes } = await api.listarAprovacoes().catch((falha: unknown) => {
      // A tela precisa saber que os pendentes podem estar faltando; quem chamou decide se tenta de novo.
      armazem.despachar({ tipo: 'aprovacoes_falharam' });
      throw falha;
    });
    // O armazém compara a revisão: lista que pode ser velha não tira nem troca pedido nenhum.
    armazem.despachar({ tipo: 'aprovacoes_carregadas', pendentes: aprovacoes, revisao });
    return armazem.estado().aprovacoes.revisao !== revisao;
  });

  const cargasDeConversa = new Map<string, () => Promise<void>>();
  function carregarConversa(botId: string): Promise<void> {
    let carga = cargasDeConversa.get(botId);
    if (!carga) {
      carga = cargaUnica(async () => {
        const perdas = armazem.estado().conversas[botId]?.perdas;
        const pagina = await api.listarMensagens(botId, { limite: LIMITES.mensagensPorPagina });
        const perdeuNoMeio = armazem.estado().conversas[botId]?.perdas !== perdas;
        // A página entra de qualquer jeito: a junção com o que chegou por evento não perde nada.
        armazem.despachar({ tipo: 'pagina_recente', botId, pagina });
        return perdeuNoMeio;
      });
      cargasDeConversa.set(botId, carga);
    }
    armazem.despachar({ tipo: 'conversa_aberta', botId });
    return carga();
  }

  const anterioresEmCurso = new Map<string, Promise<void>>();
  function carregarAnteriores(botId: string): Promise<void> {
    const emCurso = anterioresEmCurso.get(botId);
    if (emCurso) return emCurso;
    const conversa = armazem.estado().conversas[botId];
    const antes = conversa?.mensagens[0]?.seq;
    if (!conversa?.temMais || antes === undefined) return Promise.resolve();
    const carga = (async () => {
      try {
        const pagina = await api.listarMensagens(botId, { antes, limite: LIMITES.mensagensPorPagina });
        armazem.despachar({ tipo: 'pagina_anterior', botId, antes, pagina });
      } finally {
        anterioresEmCurso.delete(botId);
      }
    })();
    anterioresEmCurso.set(botId, carga);
    return carga;
  }

  /** `seq` da mensagem mais nova que o app tem do bot; 0 se não tem nenhuma. */
  function ultimoSeq(botId: string): number {
    const mensagens = armazem.estado().conversas[botId]?.mensagens ?? [];
    return mensagens[mensagens.length - 1]?.seq ?? 0;
  }

  return {
    carregarBots,
    carregarConversa,
    carregarAnteriores,
    carregarAprovacoes,

    async decidirAprovacao(id, decisao) {
      try {
        const aprovacao = await api.decidirAprovacao(id, { decisao });
        armazem.despachar({ tipo: 'aprovacao_decidida', aprovacao });
        return 'decidida';
      } catch (erro) {
        // Outra pessoa decidiu, o prazo venceu ou o turno acabou: o pedido não está mais pendente.
        // A lista nova tira o cartão; se ela falhar, o cartão fica até a próxima busca.
        if (!temCodigo(erro, 'ja_resolvida') && !temCodigo(erro, 'nao_encontrado')) throw erro;
        await carregarAprovacoes().catch(() => {});
        return 'ja_resolvida';
      }
    },

    async criarBot(entrada) {
      const bot = await api.criarBot(entrada);
      armazem.despachar({ tipo: 'bot_gravado', bot });
      return bot;
    },

    async editarBot(id, edicao) {
      const bot = await api.editarBot(id, edicao);
      armazem.despachar({ tipo: 'bot_gravado', bot });
      return bot;
    },

    async enviar(botId, texto) {
      const pedido = EsquemaPedidoTurno.safeParse({ texto });
      if (!pedido.success) throw new ErroApi('dados_invalidos', null);
      const ultimoSeqAntes = ultimoSeq(botId);
      try {
        const resposta = await api.enviarTurno(botId, pedido.data);
        armazem.despachar({ tipo: 'turno_enviado', botId, resposta });
      } catch (erro) {
        // O servidor sabe de um turno que o app não via: a lista de bots conserta o "respondendo".
        if (temCodigo(erro, 'turno_em_andamento')) void carregarBots().catch(() => {});
        if (temCodigo(erro, CODIGOS_DO_APP.tempoEsgotado)) {
          // A resposta não chegou a tempo, mas o servidor pode ter criado o turno: a busca mostra.
          await carregarConversa(botId).catch(() => {});
          // Se a mensagem está lá, o envio deu certo e a pessoa não precisa mandar de novo.
          const mensagens = armazem.estado().conversas[botId]?.mensagens ?? [];
          const criado = mensagens.some(
            (mensagem) => mensagem.seq > ultimoSeqAntes && mensagem.papel === 'usuario' && mensagem.texto === pedido.data.texto,
          );
          if (criado) return;
        }
        throw erro;
      }
    },

    async parar(botId) {
      try {
        await api.pararTurno(botId);
      } catch (erro) {
        // O turno acabou antes do pedido chegar: não é erro para quem queria parar.
        if (!temCodigo(erro, 'sem_turno_ativo')) throw erro;
        await Promise.all([carregarBots(), carregarConversa(botId)]);
      }
    },
  };
}
