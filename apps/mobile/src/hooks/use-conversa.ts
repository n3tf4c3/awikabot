import { useEffect, useState } from 'react';
import type { Bot, DecisaoAprovacao } from '@awikabot/core';

import { aprovacoesDoBot, intercalarAprovacoes, type ItemDaConversa } from '@/lib/aprovacoes';
import { CONVERSA_VAZIA, mensagensVisiveis, precisaRecarregar } from '@/lib/conversa';
import { mensagemDeErro, mensagemDoCodigo } from '@/lib/erros';
import { useDados, useSelecao } from '@/provedores/dados';

import { useBot } from './use-lista-bots';

type Decisao = DecisaoAprovacao['decisao'];

interface Conversa {
  bot: Bot | null;
  /**
   * Mensagens e pedidos de aprovação, do mais novo para o mais antigo, com o texto ao vivo da
   * resposta em andamento e cada pedido logo depois da resposta em que surgiu.
   */
  itens: ItemDaConversa[];
  /** A primeira página ainda não chegou. */
  carregando: boolean;
  carregandoAnteriores: boolean;
  /** Há uma resposta em andamento: a tela troca "Enviar" por "Parar". */
  turnoAtivo: boolean;
  enviando: boolean;
  parando: boolean;
  /** O fluxo de eventos caiu: o texto ao vivo pode atrasar. */
  semEventos: boolean;
  erro: string | null;
  /** Recado que não é erro: o pedido de aprovação já tinha sido resolvido por outro caminho. */
  aviso: string | null;
  /** A decisão de aprovação que está a caminho do servidor. Enquanto houver uma, nenhum cartão aceita outra. */
  decidindo: { id: string; decisao: Decisao } | null;
  /** Manda a decisão. O cartão só muda quando o servidor responde ou avisa por evento. */
  decidir(id: string, decisao: Decisao): void;
  /** O erro foi ao buscar as mensagens e a conversa continua sem elas: cabe um "Tentar de novo". */
  falhaDeCarga: boolean;
  /** Devolve `true` se o servidor aceitou a mensagem. */
  enviar(texto: string): Promise<boolean>;
  parar(): void;
  carregarAnteriores(): void;
  tentarDeNovo(): void;
}

/** Tudo o que a tela da conversa mostra e faz, para o bot `botId`. */
export function useConversa(botId: string): Conversa {
  const { operacoes } = useDados();
  const bot = useBot(botId);
  const conversa = useSelecao((estado) => estado.conversas[botId]) ?? CONVERSA_VAZIA;
  const conexao = useSelecao((estado) => estado.conexao);
  const aprovacoes = useSelecao((estado) => estado.aprovacoes);
  // Dois erros separados: uma busca que dá certo não apaga a recusa de um envio, e vice-versa.
  const [erroDeCarga, definirErroDeCarga] = useState<string | null>(null);
  const [erroDeAcao, definirErroDeAcao] = useState<string | null>(null);
  const [enviando, definirEnviando] = useState(false);
  const [parando, definirParando] = useState(false);
  const [carregandoAnteriores, definirCarregandoAnteriores] = useState(false);
  const [tentativa, definirTentativa] = useState(0);
  const [decidindo, definirDecidindo] = useState<{ id: string; decisao: Decisao } | null>(null);
  const [aviso, definirAviso] = useState<string | null>(null);

  // Busca a página mais recente ao abrir, quando a conversa fica para trás (eventos perdidos,
  // turno iniciado em outro aparelho) e de novo quando a conexão volta ou a pessoa pede.
  // Durante um envio a resposta do próprio POST traz as mensagens que faltam.
  const precisa = !conversa.carregada || precisaRecarregar(conversa);
  const conectada = conexao === 'conectada';
  useEffect(() => {
    if (!precisa || enviando) return;
    operacoes.carregarConversa(botId).then(
      () => definirErroDeCarga(null),
      (falha: unknown) => definirErroDeCarga(mensagemDeErro(falha)),
    );
  }, [operacoes, botId, precisa, enviando, conectada, tentativa]);

  const ultima = conversa.mensagens[conversa.mensagens.length - 1];
  const turnoAtivo = bot?.turnoAtivo === true || ultima?.estado === 'em_andamento';

  async function enviar(texto: string): Promise<boolean> {
    definirEnviando(true);
    definirErroDeAcao(null);
    try {
      await operacoes.enviar(botId, texto);
      return true;
    } catch (falha) {
      definirErroDeAcao(mensagemDeErro(falha));
      return false;
    } finally {
      definirEnviando(false);
    }
  }

  function parar(): void {
    definirParando(true);
    definirErroDeAcao(null);
    operacoes
      .parar(botId)
      .catch((falha: unknown) => definirErroDeAcao(mensagemDeErro(falha)))
      .finally(() => definirParando(false));
  }

  function decidir(id: string, decisao: Decisao): void {
    if (decidindo !== null) return;
    definirDecidindo({ id, decisao });
    definirErroDeAcao(null);
    definirAviso(null);
    operacoes
      .decidirAprovacao(id, decisao)
      .then(
        (resultado) => {
          if (resultado === 'ja_resolvida') definirAviso(mensagemDoCodigo('ja_resolvida'));
        },
        // Rede ou demora: o cartão continua como estava e a pessoa pode tentar de novo.
        (falha: unknown) => definirErroDeAcao(mensagemDeErro(falha)),
      )
      .finally(() => definirDecidindo(null));
  }

  function carregarAnteriores(): void {
    if (!conversa.temMais || carregandoAnteriores) return;
    definirCarregandoAnteriores(true);
    operacoes
      .carregarAnteriores(botId)
      .then(
        () => definirErroDeCarga(null),
        (falha: unknown) => definirErroDeCarga(mensagemDeErro(falha)),
      )
      .finally(() => definirCarregandoAnteriores(false));
  }

  return {
    bot,
    itens: intercalarAprovacoes(mensagensVisiveis(conversa), aprovacoesDoBot(aprovacoes, botId)),
    carregando: !conversa.carregada,
    carregandoAnteriores,
    turnoAtivo,
    enviando,
    parando,
    semEventos: conexao === 'reconectando',
    erro: erroDeAcao ?? erroDeCarga,
    aviso,
    decidindo,
    decidir,
    falhaDeCarga: erroDeCarga !== null && precisa,
    enviar,
    parar,
    carregarAnteriores,
    tentarDeNovo: () => definirTentativa((atual) => atual + 1),
  };
}
