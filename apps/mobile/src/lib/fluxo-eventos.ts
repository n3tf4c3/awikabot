import { EsquemaEvento, INTERVALO_PING_MS, type Evento } from '@awikabot/core';
import type { Conexao } from './dados';
import { ehRecusaDoToken } from './erros';
import { criarAnalisadorSse } from './sse';

/** O pedaço de `ReadableStreamDefaultReader` que o fluxo usa. */
export interface LeitorDeCorpo {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

export interface RespostaFluxo {
  readonly status: number;
  readonly body: { getReader(): LeitorDeCorpo } | null;
  /** Corpo inteiro como texto. Só é lido num 401, para saber quem recusou. */
  text(): Promise<string>;
}

export interface PedidoFluxo {
  method: 'GET';
  headers: Record<string, string>;
  signal: AbortSignal;
  credentials: 'omit';
  redirect: 'error';
}

/** `fetch` com corpo em fluxo: no app, o de `expo/fetch`. */
export type BuscarFluxo = (url: string, pedido: PedidoFluxo) => Promise<RespostaFluxo>;

export interface OpcoesFluxoEventos {
  buscar: BuscarFluxo;
  /** Endereço completo de `GET /v1/eventos`. */
  url: string;
  token: string;
  aoEvento(evento: Evento): void;
  /** O servidor recusou o token. O fluxo para sozinho e não tenta de novo. */
  aoNaoAutenticado(): void;
  aoMudarConexao?(conexao: Conexao): void;
}

export interface FluxoEventos {
  /** Fecha a conexão e não tenta de novo até `retomar()`. O ponto de retomada fica guardado. */
  pausar(): void;
  /** Depois de `pausar()`, reconecta na hora, do ponto em que parou. */
  retomar(): void;
  /** Fecha a conexão de vez e cancela qualquer nova tentativa. */
  parar(): void;
}

/** Espera antes de cada nova tentativa seguida; a última vale para todas as seguintes. */
export const ESPERAS_RECONEXAO_MS: readonly number[] = [1000, 2000, 5000, 15_000];

/**
 * Sem receber nada por três sinais de vida, a conexão é dada como morta e refeita. O `fetch` do
 * Expo não tem tempo limite próprio: sem este teto, uma conexão que morre em silêncio ficaria
 * aberta para sempre.
 */
export const SILENCIO_MAXIMO_MS = 3 * INTERVALO_PING_MS;

/**
 * Só a conexão que ficou aberta ao menos um intervalo de sinal de vida zera a contagem de falhas.
 * Um servidor que aceita, manda o primeiro sinal e fecha em seguida continua na espera crescente.
 */
export const CONEXAO_ESTAVEL_MS = INTERVALO_PING_MS;

function lerEvento(dados: string): Evento | null {
  try {
    const lido = EsquemaEvento.safeParse(JSON.parse(dados));
    return lido.success ? lido.data : null;
  } catch {
    return null;
  }
}

/** Promessa que já tem quem trate a falha: perder a corrida para o cancelamento não vira erro solto. */
function semErroSolto<T>(promessa: Promise<T>): Promise<T> {
  promessa.catch(() => {});
  return promessa;
}

/**
 * Mantém uma conexão com o fluxo de eventos até `parar()`. Se ela cai, tenta de novo com espera
 * crescente e manda `Last-Event-ID` para o servidor repor o que foi perdido; o ponto de retomada é
 * o último `id` recebido, inclusive o do primeiro sinal de vida. Toda conexão aberta sem esse
 * cabeçalho entrega antes um `ressincronizar` feito aqui. Erro de rede nunca desconecta o
 * aparelho: só um 401 com `nao_autenticado` no corpo do contrato chama `aoNaoAutenticado`.
 */
export function iniciarFluxoEventos(opcoes: OpcoesFluxoEventos): FluxoEventos {
  let parado = false;
  let pausado = false;
  /** Tentativas seguidas sem uma conexão estável. */
  let falhas = 0;
  let ultimoId: string | null = null;
  let controlador: AbortController | null = null;
  let espera: ReturnType<typeof setTimeout> | null = null;
  /** Número da conexão em curso: a que foi trocada por outra não agenda nova tentativa. */
  let vez = 0;

  function avisar(conexao: Conexao): void {
    if (!parado) opcoes.aoMudarConexao?.(conexao);
  }

  function agendar(): void {
    const ms = ESPERAS_RECONEXAO_MS[Math.min(falhas, ESPERAS_RECONEXAO_MS.length - 1)] ?? 0;
    falhas += 1;
    avisar('reconectando');
    espera = setTimeout(() => {
      espera = null;
      void conectar();
    }, ms);
  }

  /** Fecha a conexão em curso e cancela a tentativa agendada. */
  function soltar(): void {
    if (espera !== null) clearTimeout(espera);
    espera = null;
    controlador?.abort();
  }

  async function conectar(): Promise<void> {
    vez += 1;
    const minha = vez;
    const meu = new AbortController();
    controlador = meu;
    const cancelado = semErroSolto(
      new Promise<never>((_resolver, rejeitar) => {
        meu.signal.addEventListener('abort', () => rejeitar(new Error('cancelado')));
      }),
    );
    /** Espera por `promessa`, mas desiste assim que a conexão é cancelada. */
    const aguardar = async <T>(promessa: Promise<T>): Promise<T> => {
      const valor = await Promise.race([semErroSolto(promessa), cancelado]);
      if (meu.signal.aborted) throw new Error('cancelado');
      return valor;
    };
    let vigia: ReturnType<typeof setTimeout> | null = null;
    const vigiar = (): void => {
      if (vigia !== null) clearTimeout(vigia);
      vigia = setTimeout(() => meu.abort(), SILENCIO_MAXIMO_MS);
    };
    let estavel: ReturnType<typeof setTimeout> | null = null;

    try {
      vigiar();
      const headers: Record<string, string> = {
        accept: 'text/event-stream',
        authorization: `Bearer ${opcoes.token}`,
      };
      // Só vai no cabeçalho um id que cabe num cabeçalho.
      const retomando = ultimoId !== null && /^[\x20-\x7e]+$/.test(ultimoId);
      if (retomando && ultimoId !== null) headers['last-event-id'] = ultimoId;
      const resposta = await aguardar(
        opcoes.buscar(opcoes.url, { method: 'GET', headers, signal: meu.signal, credentials: 'omit', redirect: 'error' }),
      );

      if (resposta.status === 401) {
        // Um 401 só desfaz o pareamento se foi o servidor que recusou o token. HTML de proxy ou
        // de túnel é falha passageira: cai na espera e tenta de novo.
        if (!ehRecusaDoToken(resposta.status, await aguardar(resposta.text()))) throw new Error('recusa no caminho');
        if (!parado) {
          parado = true;
          opcoes.aoNaoAutenticado();
        }
        return;
      }
      if (resposta.status !== 200 || resposta.body === null) throw new Error('fluxo recusado');

      estavel = setTimeout(() => {
        falhas = 0;
      }, CONEXAO_ESTAVEL_MS);
      const leitor = resposta.body.getReader();
      const analisador = criarAnalisadorSse();
      const decodificador = new TextDecoder();
      let recebeu = false;
      for (;;) {
        const { done, value } = await aguardar(leitor.read());
        if (done) break;
        vigiar();
        if (!recebeu) {
          recebeu = true;
          avisar('conectada');
          // Sem `Last-Event-ID` o servidor não repõe nada nem avisa: o que o app buscou antes de
          // a conexão abrir pode ter mudado sem evento, então vale o mesmo que um `ressincronizar`.
          if (!retomando && !parado) opcoes.aoEvento({ tipo: 'ressincronizar' });
        }
        if (!value) continue;
        for (const bruto of analisador.alimentar(decodificador.decode(value, { stream: true }))) {
          if (meu.signal.aborted) return;
          // O `id` vale como ponto de retomada venha de onde vier: de um evento ou do sinal de vida.
          if (bruto.id !== null) ultimoId = bruto.id;
          if (bruto.evento !== 'evento') continue;
          const evento = lerEvento(bruto.dados);
          if (evento) opcoes.aoEvento(evento);
        }
      }
    } catch {
      // Rede, cancelamento, silêncio ou resposta recusada: o tratamento é o mesmo, tentar de novo.
    } finally {
      if (vigia !== null) clearTimeout(vigia);
      if (estavel !== null) clearTimeout(estavel);
      // Solta o pedido se ele ainda estiver aberto (resposta recusada, fluxo largado no meio).
      meu.abort();
      if (controlador === meu) controlador = null;
    }
    if (!parado && !pausado && minha === vez) agendar();
  }

  void conectar();

  return {
    pausar() {
      if (parado || pausado) return;
      pausado = true;
      soltar();
      avisar('conectando');
    },

    retomar() {
      if (parado || !pausado) return;
      pausado = false;
      falhas = 0;
      void conectar();
    },

    parar() {
      parado = true;
      soltar();
    },
  };
}
