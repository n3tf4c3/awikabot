import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INTERVALO_PING_MS, type Evento } from '@awikabot/core';
import type { Conexao } from './dados';
import {
  CONEXAO_ESTAVEL_MS,
  ESPERAS_RECONEXAO_MS,
  SILENCIO_MAXIMO_MS,
  iniciarFluxoEventos,
  type BuscarFluxo,
  type FluxoEventos,
  type PedidoFluxo,
} from './fluxo-eventos';

const URL_EVENTOS = 'https://bots.exemplo.com/v1/eventos';
const TOKEN = 't'.repeat(43);
const BOT = 'bot0000000000001';
const MSG = 'msg0000000000002';

type Leitura = { done: boolean; value?: Uint8Array };

/** Uma tentativa de conexão vista pelo lado do servidor. */
interface Tentativa {
  pedido: PedidoFluxo;
  enviar(dados: string | Uint8Array): void;
  fechar(): void;
  quebrar(): void;
}

/**
 * O que o servidor falso faz em cada tentativa: abre um fluxo, falha na rede, nunca responde,
 * ou responde com um status (o corpo, quando importa, vai junto).
 */
type Plano = 'fluxo' | 'rede' | 'sem_resposta' | number | { status: number; corpo: string | Error };

const NAO_AUTENTICADO: Plano = { status: 401, corpo: JSON.stringify({ erro: 'nao_autenticado' }) };

/** Servidor falso: cada tentativa segue o plano da vez; sem plano, abre um fluxo. */
function servidorFalso(planos: Plano[] = []) {
  const tentativas: Tentativa[] = [];
  const buscar: BuscarFluxo = (_url, pedido) => {
    const plano = planos[tentativas.length] ?? 'fluxo';
    const fila: (Leitura | Error)[] = [];
    let aguardando: { resolver: (leitura: Leitura) => void; rejeitar: (erro: Error) => void } | null = null;
    const entregar = (item: Leitura | Error): void => {
      if (!aguardando) {
        fila.push(item);
        return;
      }
      const { resolver, rejeitar } = aguardando;
      aguardando = null;
      if (item instanceof Error) rejeitar(item);
      else resolver(item);
    };
    pedido.signal.addEventListener('abort', () => entregar(new Error('abortado')));
    tentativas.push({
      pedido,
      enviar: (dados) => entregar({ done: false, value: typeof dados === 'string' ? new TextEncoder().encode(dados) : dados }),
      fechar: () => entregar({ done: true }),
      quebrar: () => entregar(new Error('conexão caiu')),
    });

    if (plano === 'rede') return Promise.reject(new TypeError('Network request failed'));
    if (plano === 'sem_resposta') {
      return new Promise((_resolver, rejeitar) => {
        pedido.signal.addEventListener('abort', () => rejeitar(new Error('abortado')));
      });
    }
    if (plano !== 'fluxo') {
      const { status, corpo } = typeof plano === 'number' ? { status: plano, corpo: JSON.stringify({ erro: 'erro_interno' }) } : plano;
      const text = (): Promise<string> => (corpo instanceof Error ? Promise.reject(corpo) : Promise.resolve(corpo));
      return Promise.resolve({ status, body: null, text });
    }
    const read = (): Promise<Leitura> =>
      new Promise((resolver, rejeitar) => {
        const item = fila.shift();
        if (item === undefined) aguardando = { resolver, rejeitar };
        else if (item instanceof Error) rejeitar(item);
        else resolver(item);
      });
    return Promise.resolve({ status: 200, body: { getReader: () => ({ read }) }, text: () => Promise.resolve('') });
  };
  return { buscar, tentativas };
}

function quadro(evento: Evento, id?: string): string {
  return `${id === undefined ? '' : `id: ${id}\n`}event: evento\ndata: ${JSON.stringify(evento)}\n\n`;
}

const PING = 'event: ping\ndata: \n\n';
/** O primeiro sinal de vida de uma conexão sem `Last-Event-ID`: traz o ponto atual do servidor. */
const pingComId = (id: string): string => `id: ${id}\n${PING}`;
const texto = (trecho: string, posicao = 0): Evento => ({ tipo: 'texto', botId: BOT, mensagemId: MSG, posicao, trecho });
/** O aviso que o próprio fluxo entrega quando abre uma conexão sem `Last-Event-ID`. */
const RESSINCRONIZAR: Evento = { tipo: 'ressincronizar' };

/** Deixa as promessas pendentes andarem sem avançar o relógio. */
const assentar = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0);

describe('iniciarFluxoEventos', () => {
  let fluxo: FluxoEventos | null = null;
  const eventos: Evento[] = [];
  const conexoes: Conexao[] = [];
  const aoNaoAutenticado = vi.fn();

  function iniciar(servidor: ReturnType<typeof servidorFalso>): FluxoEventos {
    fluxo = iniciarFluxoEventos({
      buscar: servidor.buscar,
      url: URL_EVENTOS,
      token: TOKEN,
      aoEvento: (evento) => eventos.push(evento),
      aoNaoAutenticado,
      aoMudarConexao: (conexao) => conexoes.push(conexao),
    });
    return fluxo;
  }

  /** Avança o relógio e confere que a tentativa seguinte só sai no fim da espera. */
  async function esperarTentativa(servidor: ReturnType<typeof servidorFalso>, espera: number): Promise<void> {
    const antes = servidor.tentativas.length;
    await vi.advanceTimersByTimeAsync(espera - 1);
    expect(servidor.tentativas, `1 ms antes de ${espera} ms`).toHaveLength(antes);
    await vi.advanceTimersByTimeAsync(1);
    expect(servidor.tentativas, `ao fim de ${espera} ms`).toHaveLength(antes + 1);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    eventos.length = 0;
    conexoes.length = 0;
    aoNaoAutenticado.mockClear();
  });

  afterEach(() => {
    fluxo?.parar();
    fluxo = null;
    vi.useRealTimers();
  });

  describe('conexão e eventos', () => {
    it('abre uma conexão só, com o token e sem Last-Event-ID na primeira vez', async () => {
      const servidor = servidorFalso();
      const buscar = vi.fn(servidor.buscar);
      fluxo = iniciarFluxoEventos({ buscar, url: URL_EVENTOS, token: TOKEN, aoEvento: () => {}, aoNaoAutenticado });
      await assentar();

      expect(buscar).toHaveBeenCalledTimes(1);
      expect(buscar.mock.calls[0]?.[0]).toBe(URL_EVENTOS);
      const pedido = servidor.tentativas[0]?.pedido;
      expect(pedido?.method).toBe('GET');
      expect(pedido?.headers).toEqual({ accept: 'text/event-stream', authorization: `Bearer ${TOKEN}` });
      expect(pedido?.credentials).toBe('omit');
      expect(pedido?.redirect).toBe('error');
    });

    it('entrega os eventos válidos na ordem e ignora o ping', async () => {
      const servidor = servidorFalso();
      iniciar(servidor);
      await assentar();
      servidor.tentativas[0]?.enviar(PING + quadro({ tipo: 'turno_iniciado', botId: BOT, mensagemId: MSG }, 'ep-1'));
      servidor.tentativas[0]?.enviar(quadro(texto('Olá'), 'ep-2') + PING + quadro(texto(', mundo', 3), 'ep-3'));
      await assentar();

      expect(eventos).toEqual([
        RESSINCRONIZAR,
        { tipo: 'turno_iniciado', botId: BOT, mensagemId: MSG },
        texto('Olá'),
        texto(', mundo', 3),
      ]);
    });

    it('entrega os eventos de aprovação como vieram', async () => {
      const pendente = {
        id: 'apr0000000000001',
        botId: BOT,
        mensagemId: MSG,
        ferramenta: 'Bash',
        resumo: 'ls -la',
        estado: 'pendente',
        criadaEm: 10,
        resolvidaEm: null,
      } as const;
      const pedida: Evento = { tipo: 'aprovacao_pedida', aprovacao: pendente };
      const resolvida: Evento = { tipo: 'aprovacao_resolvida', aprovacao: { ...pendente, estado: 'negada', resolvidaEm: 20 } };
      const servidor = servidorFalso();
      iniciar(servidor);
      await assentar();
      servidor.tentativas[0]?.enviar(pingComId('ep-0') + quadro(pedida, 'ep-1') + quadro(resolvida, 'ep-2'));
      // Aprovação com estado que o contrato não conhece não passa.
      servidor.tentativas[0]?.enviar(`event: evento\ndata: ${JSON.stringify({ ...pedida, aprovacao: { ...pendente, estado: 'talvez' } })}\n\n`);
      await assentar();

      expect(eventos).toEqual([RESSINCRONIZAR, pedida, resolvida]);
    });

    it('ignora evento que não é JSON ou não segue o contrato, e continua lendo', async () => {
      const servidor = servidorFalso();
      iniciar(servidor);
      await assentar();
      servidor.tentativas[0]?.enviar('event: evento\ndata: {quebrado\n\n');
      servidor.tentativas[0]?.enviar('event: evento\ndata: {"tipo":"tipo_do_futuro"}\n\n');
      servidor.tentativas[0]?.enviar('event: evento\ndata: {"tipo":"texto","botId":"curto"}\n\n');
      // `texto` sem `posicao` é do contrato antigo: não dá para juntar sem repetir.
      servidor.tentativas[0]?.enviar(`event: evento\ndata: {"tipo":"texto","botId":"${BOT}","mensagemId":"${MSG}","trecho":"x"}\n\n`);
      servidor.tentativas[0]?.enviar('event: outro\ndata: {"tipo":"ressincronizar"}\n\n');
      servidor.tentativas[0]?.enviar(quadro(texto('ok')));
      await assentar();

      expect(eventos).toEqual([RESSINCRONIZAR, texto('ok')]);
    });

    it('monta eventos cortados em qualquer byte, inclusive no meio de um caractere', async () => {
      const servidor = servidorFalso();
      iniciar(servidor);
      await assentar();
      const bytes = new TextEncoder().encode(quadro(texto('ação — 🙂'), 'ep-1').replaceAll('\n', '\r\n'));
      for (const byte of bytes) servidor.tentativas[0]?.enviar(Uint8Array.of(byte));
      await assentar();

      expect(eventos).toEqual([RESSINCRONIZAR, texto('ação — 🙂')]);
    });

    it('avisa conectada ao receber o primeiro pedaço e reconectando quando a conexão cai', async () => {
      const servidor = servidorFalso();
      iniciar(servidor);
      await assentar();
      expect(conexoes).toEqual([]);

      servidor.tentativas[0]?.enviar(PING);
      servidor.tentativas[0]?.enviar(PING);
      await assentar();
      expect(conexoes).toEqual(['conectada']);

      servidor.tentativas[0]?.quebrar();
      await assentar();
      expect(conexoes).toEqual(['conectada', 'reconectando']);
    });
  });

  describe('espera entre tentativas', () => {
    it('tenta de novo depois de 1 s, 2 s, 5 s e então a cada 15 s', async () => {
      const servidor = servidorFalso(['rede', 'rede', 500, 'rede', 'rede', 'rede']);
      iniciar(servidor);
      await assentar();
      expect(servidor.tentativas).toHaveLength(1);

      for (const espera of [1000, 2000, 5000, 15_000, 15_000]) await esperarTentativa(servidor, espera);
      expect(aoNaoAutenticado).not.toHaveBeenCalled();
      expect(ESPERAS_RECONEXAO_MS).toEqual([1000, 2000, 5000, 15_000]);
    });

    it('servidor que fecha logo depois do primeiro sinal de vida continua na espera crescente', async () => {
      const servidor = servidorFalso();
      iniciar(servidor);
      await assentar();

      for (const espera of [1000, 2000, 5000, 15_000, 15_000]) {
        const atual = servidor.tentativas[servidor.tentativas.length - 1];
        atual?.enviar(pingComId('ep-0'));
        await assentar();
        atual?.fechar();
        await esperarTentativa(servidor, espera);
      }
    });

    it('conexão aberta por menos de um intervalo de sinal de vida não zera a espera', async () => {
      const servidor = servidorFalso(['rede', 'rede']);
      iniciar(servidor);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      expect(servidor.tentativas).toHaveLength(3);

      servidor.tentativas[2]?.enviar(PING);
      await vi.advanceTimersByTimeAsync(CONEXAO_ESTAVEL_MS - 1);
      servidor.tentativas[2]?.quebrar();

      await esperarTentativa(servidor, 5000);
    });

    it('conexão que ficou aberta um intervalo de sinal de vida zera a espera', async () => {
      const servidor = servidorFalso(['rede', 'rede', 'fluxo', 'rede']);
      iniciar(servidor);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      expect(servidor.tentativas).toHaveLength(3);

      servidor.tentativas[2]?.enviar(PING);
      await vi.advanceTimersByTimeAsync(CONEXAO_ESTAVEL_MS);
      servidor.tentativas[2]?.quebrar();

      await esperarTentativa(servidor, 1000);
      // A tentativa seguinte falhou de novo: a espera volta a crescer do começo.
      await esperarTentativa(servidor, 2000);
      expect(CONEXAO_ESTAVEL_MS).toBe(INTERVALO_PING_MS);
    });

    it('conexão aceita que não manda nada não zera a espera', async () => {
      const servidor = servidorFalso();
      iniciar(servidor);
      await assentar();
      servidor.tentativas[0]?.fechar();
      await esperarTentativa(servidor, 1000);
      servidor.tentativas[1]?.fechar();
      await esperarTentativa(servidor, 2000);
    });
  });

  describe('ponto de retomada', () => {
    it('reconecta mandando o último id recebido em Last-Event-ID', async () => {
      const servidor = servidorFalso();
      iniciar(servidor);
      await assentar();
      servidor.tentativas[0]?.enviar(quadro(texto('a'), 'ep-41') + quadro(texto('b', 1), 'ep-42') + PING);
      await assentar();
      servidor.tentativas[0]?.quebrar();
      await vi.advanceTimersByTimeAsync(1000);

      expect(servidor.tentativas).toHaveLength(2);
      expect(servidor.tentativas[1]?.pedido.headers['last-event-id']).toBe('ep-42');
      expect(servidor.tentativas[1]?.pedido.headers.authorization).toBe(`Bearer ${TOKEN}`);
    });

    it('guarda o id do primeiro sinal de vida e retoma dele, sem ressincronizar de novo', async () => {
      const servidor = servidorFalso();
      iniciar(servidor);
      await assentar();
      // Nenhum evento chegou: o único id é o do sinal de vida que abre a conexão.
      servidor.tentativas[0]?.enviar(pingComId('ep-10'));
      await assentar();
      servidor.tentativas[0]?.quebrar();
      await vi.advanceTimersByTimeAsync(1000);

      expect(servidor.tentativas[1]?.pedido.headers['last-event-id']).toBe('ep-10');
      servidor.tentativas[1]?.enviar(PING + quadro(texto('a'), 'ep-11'));
      await assentar();
      expect(eventos).toEqual([RESSINCRONIZAR, texto('a')]);
    });

    it('guarda o id de um evento mesmo quando o conteúdo é ignorado', async () => {
      const servidor = servidorFalso();
      iniciar(servidor);
      await assentar();
      servidor.tentativas[0]?.enviar('id: ep-7\nevent: evento\ndata: {"tipo":"tipo_do_futuro"}\n\n');
      await assentar();
      servidor.tentativas[0]?.fechar();
      await vi.advanceTimersByTimeAsync(1000);

      expect(servidor.tentativas[1]?.pedido.headers['last-event-id']).toBe('ep-7');
    });

    it('não manda Last-Event-ID que não cabe num cabeçalho', async () => {
      const servidor = servidorFalso();
      iniciar(servidor);
      await assentar();
      servidor.tentativas[0]?.enviar(quadro(texto('a'), 'id-com-acento-é'));
      await assentar();
      servidor.tentativas[0]?.fechar();
      await vi.advanceTimersByTimeAsync(1000);

      expect(servidor.tentativas[1]?.pedido.headers).not.toHaveProperty('last-event-id');
    });

    it('conexão aberta sem Last-Event-ID entrega ressincronizar antes de qualquer evento', async () => {
      const servidor = servidorFalso();
      iniciar(servidor);
      await assentar();
      expect(eventos).toEqual([]);
      servidor.tentativas[0]?.enviar(pingComId('ep-0'));
      await assentar();
      expect(eventos).toEqual([RESSINCRONIZAR]);
      servidor.tentativas[0]?.enviar(PING + quadro(texto('a'), 'ep-1'));
      await assentar();
      expect(eventos).toEqual([RESSINCRONIZAR, texto('a')]);
    });

    it('reconexão que retoma pelo Last-Event-ID não inventa ressincronizar', async () => {
      const servidor = servidorFalso();
      iniciar(servidor);
      await assentar();
      servidor.tentativas[0]?.enviar(quadro(texto('a'), 'ep-1'));
      await assentar();
      servidor.tentativas[0]?.quebrar();
      await vi.advanceTimersByTimeAsync(1000);
      servidor.tentativas[1]?.enviar(PING + quadro(texto('b', 1), 'ep-2'));
      await assentar();

      expect(eventos).toEqual([RESSINCRONIZAR, texto('a'), texto('b', 1)]);
    });

    it('servidor que nunca manda id: cada reconexão entrega ressincronizar de novo', async () => {
      const servidor = servidorFalso();
      iniciar(servidor);
      await assentar();
      servidor.tentativas[0]?.enviar(PING);
      await assentar();
      servidor.tentativas[0]?.quebrar();
      await vi.advanceTimersByTimeAsync(1000);
      expect(servidor.tentativas[1]?.pedido.headers).not.toHaveProperty('last-event-id');
      servidor.tentativas[1]?.enviar(PING);
      await assentar();

      expect(eventos).toEqual([RESSINCRONIZAR, RESSINCRONIZAR]);
    });
  });

  describe('regra do 401', () => {
    it('com nao_autenticado no corpo do contrato, avisa uma vez e não tenta de novo', async () => {
      const servidor = servidorFalso([NAO_AUTENTICADO]);
      iniciar(servidor);
      await assentar();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(aoNaoAutenticado).toHaveBeenCalledTimes(1);
      expect(servidor.tentativas).toHaveLength(1);
      expect(conexoes).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
      ['HTML de um proxy', '<html><body>Login do túnel</body></html>'],
      ['corpo vazio', ''],
      ['outro código do contrato', JSON.stringify({ erro: 'codigo_invalido' })],
      ['JSON fora do contrato', JSON.stringify({ error: 'nao_autenticado' })],
      ['corpo que não chega', new Error('conexão caiu')],
    ])('401 com %s não desconecta: tenta de novo com espera', async (_caso, corpo) => {
      const servidor = servidorFalso([
        { status: 401, corpo },
        { status: 401, corpo },
      ]);
      iniciar(servidor);
      await assentar();
      expect(conexoes).toEqual(['reconectando']);

      await esperarTentativa(servidor, 1000);
      await esperarTentativa(servidor, 2000);
      expect(aoNaoAutenticado).not.toHaveBeenCalled();
    });

    it('depois de um 401 passageiro, a conexão seguinte funciona normalmente', async () => {
      const servidor = servidorFalso([{ status: 401, corpo: '<html></html>' }]);
      iniciar(servidor);
      await vi.advanceTimersByTimeAsync(1000);
      servidor.tentativas[1]?.enviar(pingComId('ep-0') + quadro(texto('a'), 'ep-1'));
      await assentar();

      expect(eventos).toEqual([RESSINCRONIZAR, texto('a')]);
      expect(aoNaoAutenticado).not.toHaveBeenCalled();
    });

    it.each([403, 404, 500, 503])('com status %i só tenta de novo, sem desconectar', async (status) => {
      const servidor = servidorFalso([status]);
      iniciar(servidor);
      await vi.advanceTimersByTimeAsync(1000);

      expect(servidor.tentativas).toHaveLength(2);
      expect(aoNaoAutenticado).not.toHaveBeenCalled();
    });
  });

  describe('silêncio', () => {
    it('o limite de silêncio são três intervalos de sinal de vida', () => {
      expect(SILENCIO_MAXIMO_MS).toBe(3 * INTERVALO_PING_MS);
    });

    it('refaz a conexão que fica em silêncio além do limite', async () => {
      const servidor = servidorFalso();
      iniciar(servidor);
      await assentar();
      servidor.tentativas[0]?.enviar(quadro(texto('a'), 'ep-1'));
      await vi.advanceTimersByTimeAsync(SILENCIO_MAXIMO_MS - 1);
      expect(servidor.tentativas[0]?.pedido.signal.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(servidor.tentativas[0]?.pedido.signal.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(servidor.tentativas).toHaveLength(2);
      expect(servidor.tentativas[1]?.pedido.headers['last-event-id']).toBe('ep-1');
    });

    it('cada pedaço recebido adia o limite de silêncio', async () => {
      const servidor = servidorFalso();
      iniciar(servidor);
      await assentar();
      for (let vez = 0; vez < 5; vez += 1) {
        await vi.advanceTimersByTimeAsync(SILENCIO_MAXIMO_MS - 1000);
        servidor.tentativas[0]?.enviar(PING);
        await assentar();
      }
      expect(servidor.tentativas).toHaveLength(1);
      expect(servidor.tentativas[0]?.pedido.signal.aborted).toBe(false);
    });

    it('desiste de um pedido que nunca recebe resposta', async () => {
      const servidor = servidorFalso(['sem_resposta']);
      iniciar(servidor);
      await vi.advanceTimersByTimeAsync(SILENCIO_MAXIMO_MS);
      expect(servidor.tentativas[0]?.pedido.signal.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(servidor.tentativas).toHaveLength(2);
    });
  });

  describe('parar', () => {
    it('fecha a conexão aberta e não reconecta', async () => {
      const servidor = servidorFalso();
      const iniciado = iniciar(servidor);
      await assentar();
      servidor.tentativas[0]?.enviar(PING);
      await assentar();

      iniciado.parar();
      await vi.advanceTimersByTimeAsync(120_000);

      expect(servidor.tentativas).toHaveLength(1);
      expect(servidor.tentativas[0]?.pedido.signal.aborted).toBe(true);
      expect(conexoes).toEqual(['conectada']);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('durante a espera, cancela a nova tentativa', async () => {
      const servidor = servidorFalso(['rede']);
      const iniciado = iniciar(servidor);
      await assentar();
      expect(conexoes).toEqual(['reconectando']);

      iniciado.parar();
      await vi.advanceTimersByTimeAsync(120_000);

      expect(servidor.tentativas).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('antes do primeiro pedaço, não entrega o ressincronizar da conexão', async () => {
      const servidor = servidorFalso();
      const iniciado = iniciar(servidor);
      await assentar();

      iniciado.parar();
      servidor.tentativas[0]?.enviar(pingComId('ep-0') + quadro(texto('a'), 'ep-1'));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(eventos).toEqual([]);
      expect(conexoes).toEqual([]);
    });

    it('chamado no aviso de conectada, não deixa sair o ressincronizar da conexão', async () => {
      const servidor = servidorFalso();
      let iniciado: FluxoEventos | null = null;
      iniciado = fluxo = iniciarFluxoEventos({
        buscar: servidor.buscar,
        url: URL_EVENTOS,
        token: TOKEN,
        aoEvento: (evento) => eventos.push(evento),
        aoNaoAutenticado,
        // Quem ouve a conexão desiste dela no mesmo instante em que ela abre.
        aoMudarConexao: (conexao) => {
          conexoes.push(conexao);
          if (conexao === 'conectada') iniciado?.parar();
        },
      });
      await assentar();
      servidor.tentativas[0]?.enviar(pingComId('ep-0') + quadro(texto('a'), 'ep-1'));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(conexoes).toEqual(['conectada']);
      expect(eventos).toEqual([]);
      expect(servidor.tentativas).toHaveLength(1);
    });

    it('não entrega os eventos que ainda estavam no pedaço em leitura', async () => {
      const servidor = servidorFalso();
      let iniciado: FluxoEventos | null = null;
      iniciado = fluxo = iniciarFluxoEventos({
        buscar: servidor.buscar,
        url: URL_EVENTOS,
        token: TOKEN,
        aoEvento: (evento) => {
          eventos.push(evento);
          if (evento.tipo === 'texto') iniciado?.parar();
        },
        aoNaoAutenticado,
      });
      await assentar();
      servidor.tentativas[0]?.enviar(quadro(texto('a')) + quadro(texto('b', 1)));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(eventos).toEqual([RESSINCRONIZAR, texto('a')]);
      expect(servidor.tentativas).toHaveLength(1);
    });
  });

  describe('pausar e retomar', () => {
    it('pausar fecha a conexão e não reconecta enquanto durar a pausa', async () => {
      const servidor = servidorFalso();
      const iniciado = iniciar(servidor);
      await assentar();
      servidor.tentativas[0]?.enviar(pingComId('ep-0'));
      await assentar();

      iniciado.pausar();
      await vi.advanceTimersByTimeAsync(600_000);

      expect(servidor.tentativas).toHaveLength(1);
      expect(servidor.tentativas[0]?.pedido.signal.aborted).toBe(true);
      expect(conexoes).toEqual(['conectada', 'conectando']);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('retomar reconecta na hora, do ponto em que parou', async () => {
      const servidor = servidorFalso();
      const iniciado = iniciar(servidor);
      await assentar();
      servidor.tentativas[0]?.enviar(pingComId('ep-0') + quadro(texto('a'), 'ep-5'));
      await assentar();
      iniciado.pausar();
      await vi.advanceTimersByTimeAsync(600_000);

      iniciado.retomar();
      await assentar();

      expect(servidor.tentativas).toHaveLength(2);
      expect(servidor.tentativas[1]?.pedido.headers['last-event-id']).toBe('ep-5');
      servidor.tentativas[1]?.enviar(PING + quadro(texto('b', 1), 'ep-6'));
      await assentar();
      expect(eventos).toEqual([RESSINCRONIZAR, texto('a'), texto('b', 1)]);
      expect(conexoes).toEqual(['conectada', 'conectando', 'conectada']);
    });

    it('pausar durante a espera cancela a tentativa agendada', async () => {
      const servidor = servidorFalso(['rede']);
      const iniciado = iniciar(servidor);
      await assentar();

      iniciado.pausar();
      await vi.advanceTimersByTimeAsync(120_000);

      expect(servidor.tentativas).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('retomar começa de novo da espera de 1 s', async () => {
      const servidor = servidorFalso(['rede', 'rede', 'rede', 'rede']);
      const iniciado = iniciar(servidor);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      expect(servidor.tentativas).toHaveLength(3);

      iniciado.pausar();
      iniciado.retomar();
      await assentar();
      expect(servidor.tentativas).toHaveLength(4);

      await esperarTentativa(servidor, 1000);
    });

    it('pausar e retomar em seguida abre uma conexão só', async () => {
      const servidor = servidorFalso();
      const iniciado = iniciar(servidor);
      await assentar();
      servidor.tentativas[0]?.enviar(pingComId('ep-0'));
      await assentar();

      iniciado.pausar();
      iniciado.retomar();
      await vi.advanceTimersByTimeAsync(30_000);

      // A conexão antiga, ao terminar de fechar, não pode agendar outra por cima da nova.
      expect(servidor.tentativas).toHaveLength(2);
      expect(servidor.tentativas[1]?.pedido.signal.aborted).toBe(false);
    });

    it('retomar sem pausa e pausar duas vezes não fazem nada a mais', async () => {
      const servidor = servidorFalso();
      const iniciado = iniciar(servidor);
      await assentar();

      iniciado.retomar();
      await assentar();
      expect(servidor.tentativas).toHaveLength(1);

      iniciado.pausar();
      iniciado.pausar();
      iniciado.retomar();
      iniciado.retomar();
      await assentar();
      expect(servidor.tentativas).toHaveLength(2);
    });

    it('parar durante a pausa é definitivo', async () => {
      const servidor = servidorFalso();
      const iniciado = iniciar(servidor);
      await assentar();

      iniciado.pausar();
      iniciado.parar();
      iniciado.retomar();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(servidor.tentativas).toHaveLength(1);
    });
  });
});
