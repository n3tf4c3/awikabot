import {
  EsquemaBot,
  EsquemaListaBots,
  EsquemaListaMensagens,
  EsquemaRespostaPareamento,
  EsquemaRespostaTurno,
  type Bot,
  type BotEdicao,
  type BotEntrada,
  type ListaBots,
  type ListaMensagens,
  type PedidoPareamento,
  type PedidoTurno,
  type RespostaPareamento,
  type RespostaTurno,
} from '@awikabot/core';
import { CODIGOS_DO_APP, ErroApi, codigoDoCorpo, ehRecusaDoToken } from './erros';
import type { Sessao } from './sessao';

/** O pedaço de `RequestInit` que o app usa. Sem cookies e sem seguir redirecionamento. */
export interface PedidoHttp {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  credentials: 'omit';
  redirect: 'error';
}

/** O pedaço de `Response` que o cliente lê. */
export interface RespostaHttp {
  readonly status: number;
  text(): Promise<string>;
}

/** `fetch` injetado: o do Expo no app, um falso nos testes. */
export type Buscar = (url: string, pedido: PedidoHttp) => Promise<RespostaHttp>;

export interface OpcoesApi {
  buscar: Buscar;
  /** Sessão em uso. Lida uma vez, no começo de cada pedido. */
  sessaoAtual(): Sessao | null;
  /** O servidor recusou o token da sessão com que o pedido saiu. */
  aoNaoAutenticado(sessao: Sessao): void | Promise<unknown>;
  /** Tempo máximo de um pedido. O `fetch` do Expo não tem limite próprio. */
  tempoLimiteMs?: number;
}

export interface Api {
  parear(servidor: string, pedido: PedidoPareamento): Promise<RespostaPareamento>;
  listarBots(): Promise<ListaBots>;
  criarBot(entrada: BotEntrada): Promise<Bot>;
  editarBot(id: string, edicao: BotEdicao): Promise<Bot>;
  /** Página em ordem crescente de `seq`. `antes` pede as mensagens anteriores àquele `seq`. */
  listarMensagens(botId: string, pagina?: { antes?: number; limite?: number }): Promise<ListaMensagens>;
  enviarTurno(botId: string, pedido: PedidoTurno): Promise<RespostaTurno>;
  pararTurno(botId: string): Promise<void>;
  /**
   * Invalida no servidor o token dado (`DELETE /v1/dispositivo`), com tempo limite curto.
   * Recebe a credencial em vez de ler a sessão: serve também para um token que nem chegou a ser guardado.
   */
  revogarDispositivo(credencial: Credencial): Promise<void>;
}

/** O que basta para falar com o servidor em nome de um aparelho. */
export type Credencial = Pick<Sessao, 'servidor' | 'token'>;

interface Esquema<T> {
  parse(dados: unknown): T;
}

interface Chamada {
  metodo: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  token: string | null;
  corpo?: unknown;
  tempoLimiteMs?: number;
}

const TEMPO_LIMITE_PADRAO_MS = 20_000;

/** Revogar é por melhor esforço: quem espera por ele não pode ficar preso a um servidor fora do ar. */
export const TEMPO_LIMITE_REVOGACAO_MS = 5000;

export function criarApi(opcoes: OpcoesApi): Api {
  const tempoLimiteMs = opcoes.tempoLimiteMs ?? TEMPO_LIMITE_PADRAO_MS;

  /** Faz o pedido e devolve status e corpo. Falha de rede e demora viram `ErroApi` sem status. */
  async function chamar(chamada: Chamada): Promise<{ status: number; texto: string }> {
    const controlador = new AbortController();
    let esgotou = false;
    const relogio = setTimeout(() => {
      esgotou = true;
      controlador.abort();
    }, chamada.tempoLimiteMs ?? tempoLimiteMs);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (chamada.token !== null) headers.authorization = `Bearer ${chamada.token}`;
    if (chamada.corpo !== undefined) headers['content-type'] = 'application/json';
    try {
      const resposta = await opcoes.buscar(chamada.url, {
        method: chamada.metodo,
        headers,
        body: chamada.corpo === undefined ? undefined : JSON.stringify(chamada.corpo),
        signal: controlador.signal,
        credentials: 'omit',
        redirect: 'error',
      });
      return { status: resposta.status, texto: await resposta.text() };
    } catch {
      throw new ErroApi(esgotou ? CODIGOS_DO_APP.tempoEsgotado : CODIGOS_DO_APP.rede, null);
    } finally {
      clearTimeout(relogio);
    }
  }

  function erroDaResposta(status: number, texto: string): ErroApi {
    const codigo = codigoDoCorpo(texto);
    if (codigo !== null) return new ErroApi(codigo, status);
    // Erro fora do formato do contrato não veio do servidor awikabot. Um 401 assim tem código próprio.
    return new ErroApi(status === 401 ? CODIGOS_DO_APP.recusaNoCaminho : CODIGOS_DO_APP.erroHttp, status);
  }

  function ler<T>(esquema: Esquema<T>, status: number, texto: string): T {
    try {
      return esquema.parse(JSON.parse(texto));
    } catch {
      throw new ErroApi(CODIGOS_DO_APP.respostaInvalida, status);
    }
  }

  /**
   * Pedido autenticado. A sessão é capturada aqui e é ela que responde pela recusa do token:
   * só um 401 com `nao_autenticado` no corpo do contrato desfaz o pareamento.
   */
  async function pedir(
    metodo: Chamada['metodo'],
    caminho: string,
    corpo?: unknown,
  ): Promise<{ status: number; texto: string }> {
    const sessao = opcoes.sessaoAtual();
    if (sessao === null) throw new ErroApi('nao_autenticado', null);
    const resposta = await chamar({ metodo, url: `${sessao.servidor}${caminho}`, token: sessao.token, corpo });
    if (ehRecusaDoToken(resposta.status, resposta.texto)) {
      try {
        await opcoes.aoNaoAutenticado(sessao);
      } catch {
        // O pedido falha com o 401 de qualquer jeito; quem apaga a sessão cuida do próprio erro.
      }
    }
    return exigirSucesso(resposta);
  }

  function exigirSucesso(resposta: { status: number; texto: string }): { status: number; texto: string } {
    if (resposta.status < 200 || resposta.status > 299) throw erroDaResposta(resposta.status, resposta.texto);
    return resposta;
  }

  const bot = (id: string): string => `/v1/bots/${encodeURIComponent(id)}`;

  return {
    // Sem sessão: aqui um 401 é só o código recusado, e ninguém é desconectado por ele.
    async parear(servidor, pedido) {
      const { status, texto } = exigirSucesso(
        await chamar({ metodo: 'POST', url: `${servidor}/v1/parear`, token: null, corpo: pedido }),
      );
      return ler(EsquemaRespostaPareamento, status, texto);
    },

    async listarBots() {
      const { status, texto } = await pedir('GET', '/v1/bots');
      return ler(EsquemaListaBots, status, texto);
    },

    async criarBot(entrada) {
      const { status, texto } = await pedir('POST', '/v1/bots', entrada);
      return ler(EsquemaBot, status, texto);
    },

    async editarBot(id, edicao) {
      const { status, texto } = await pedir('PATCH', bot(id), edicao);
      return ler(EsquemaBot, status, texto);
    },

    async listarMensagens(botId, pagina = {}) {
      const query: string[] = [];
      if (pagina.antes !== undefined) query.push(`antes=${pagina.antes}`);
      if (pagina.limite !== undefined) query.push(`limite=${pagina.limite}`);
      const sufixo = query.length > 0 ? `?${query.join('&')}` : '';
      const { status, texto } = await pedir('GET', `${bot(botId)}/mensagens${sufixo}`);
      return ler(EsquemaListaMensagens, status, texto);
    },

    async enviarTurno(botId, pedido) {
      const { status, texto } = await pedir('POST', `${bot(botId)}/turnos`, pedido);
      return ler(EsquemaRespostaTurno, status, texto);
    },

    async pararTurno(botId) {
      await pedir('POST', `${bot(botId)}/turnos/atual/parar`);
    },

    // Fora da regra da sessão: quem chama já vai esquecer esta credencial, com ou sem resposta.
    async revogarDispositivo(credencial) {
      exigirSucesso(
        await chamar({
          metodo: 'DELETE',
          url: `${credencial.servidor}/v1/dispositivo`,
          token: credencial.token,
          tempoLimiteMs: TEMPO_LIMITE_REVOGACAO_MS,
        }),
      );
    },
  };
}
