import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import {
  EsquemaBotEdicao,
  EsquemaBotEntrada,
  EsquemaDecisaoAprovacao,
  EsquemaPedidoPareamento,
  EsquemaPedidoTurno,
  INTERVALO_PING_MS,
  LIMITES,
  VERSAO_PROTOCOLO,
  type Dispositivo,
  type Saude,
} from '@awikabot/core';
import type { ZodType } from 'zod';
import type { GestorDeAprovacoes } from './aprovacoes';
import type { Banco } from './banco';
import { criarBot, editarBot, listarBots, obterBot, paraContrato } from './bots';
import { listarMensagens } from './conversa';
import { autenticar, parear, revogar, type LimitadorDeTentativas } from './dispositivos';
import type { Barramento, EventoNumerado } from './eventos';
import type { GestorDeTurnos } from './turnos';

export interface Dependencias {
  versao: string;
  banco: Banco;
  barramento: Barramento;
  turnos: GestorDeTurnos;
  aprovacoes: GestorDeAprovacoes;
  limitador: LimitadorDeTentativas;
  /** Intervalo do sinal de vida do fluxo de eventos. Menor nos testes. */
  intervaloPingMs?: number;
}

type Ambiente = { Variables: { dispositivo: Dispositivo; token: string } };
type Contexto = Context<Ambiente>;

/** O maior texto de turno, no pior caso de UTF-8, mais folga para o JSON em volta. */
const CORPO_MAXIMO = LIMITES.texto * 4 + 4096;

async function lerCorpo<T>(c: Contexto, esquema: ZodType<T>): Promise<{ dados: T } | { resposta: Response }> {
  let bruto: unknown;
  try {
    bruto = await c.req.json();
  } catch {
    return { resposta: c.json({ erro: 'json_invalido' }, 400) };
  }
  const lido = esquema.safeParse(bruto);
  if (!lido.success) return { resposta: c.json({ erro: 'dados_invalidos' }, 400) };
  return { dados: lido.data };
}

function inteiroDaQuery(valor: string | undefined, minimo: number, maximo: number): number | null | 'invalido' {
  if (valor === undefined) return null;
  if (!/^\d{1,15}$/.test(valor)) return 'invalido';
  const numero = Number(valor);
  return numero >= minimo && numero <= maximo ? numero : 'invalido';
}

export function criarApp(deps: Dependencias): Hono<Ambiente> {
  const app = new Hono<Ambiente>();
  const intervaloPingMs = deps.intervaloPingMs ?? INTERVALO_PING_MS;
  const saude = (): Saude => ({ status: 'ok', versao: deps.versao, protocolo: VERSAO_PROTOCOLO });

  app.use('*', async (c, next) => {
    await next();
    c.header('cache-control', 'no-store');
    c.header('x-content-type-options', 'nosniff');
  });
  app.onError((erro, c) => {
    console.error(`erro interno: ${erro.message}`);
    return c.json({ erro: 'erro_interno' }, 500);
  });
  app.notFound((c) => c.json({ erro: 'nao_encontrado' }, 404));

  // A saúde passa pelo banco: "ok" quer dizer que o servidor atende e que o banco responde.
  app.get('/healthz', (c) => {
    try {
      deps.banco.prepare('SELECT 1').get();
    } catch {
      return c.json({ erro: 'banco_indisponivel' }, 503);
    }
    return c.json(saude());
  });
  app.all('/healthz', (c) => {
    c.header('allow', 'GET');
    return c.json({ erro: 'metodo_nao_permitido' }, 405);
  });

  app.use('/v1/*', bodyLimit({ maxSize: CORPO_MAXIMO, onError: (c) => c.json({ erro: 'corpo_grande_demais' }, 413) }));

  // Único ponto sem token: troca um código de uso único pelo token do aparelho.
  app.post('/v1/parear', async (c) => {
    if (deps.limitador.bloqueado()) return c.json({ erro: 'muitas_tentativas' }, 429);
    const corpo = await lerCorpo(c, EsquemaPedidoPareamento);
    if ('resposta' in corpo) return corpo.resposta;
    const pareado = parear(deps.banco, corpo.dados.codigo, corpo.dados.nome);
    if (!pareado) {
      deps.limitador.registrarFalha();
      return c.json({ erro: 'codigo_invalido' }, 401);
    }
    return c.json({ token: pareado.token, dispositivo: pareado.dispositivo, servidor: saude() });
  });

  // Daqui para baixo, tudo em /v1 exige o token de um aparelho pareado e não revogado.
  app.use('/v1/*', async (c, next) => {
    const token = /^Bearer ([A-Za-z0-9_-]{43,64})$/.exec(c.req.header('authorization') ?? '')?.[1];
    const dispositivo = token ? autenticar(deps.banco, token) : null;
    if (!token || !dispositivo) return c.json({ erro: 'nao_autenticado' }, 401);
    c.set('dispositivo', dispositivo);
    c.set('token', token);
    await next();
  });

  // "Desparear": o próprio aparelho invalida o token dele no servidor.
  app.delete('/v1/dispositivo', (c) => {
    revogar(deps.banco, c.get('dispositivo').id);
    return c.body(null, 204);
  });

  app.get('/v1/bots', (c) =>
    c.json({ bots: listarBots(deps.banco).map((bot) => paraContrato(bot, deps.turnos.ativo(bot.id))) }),
  );

  app.post('/v1/bots', async (c) => {
    const corpo = await lerCorpo(c, EsquemaBotEntrada);
    if ('resposta' in corpo) return corpo.resposta;
    const bot = paraContrato(criarBot(deps.banco, corpo.dados), false);
    deps.barramento.publicar({ tipo: 'bot_salvo', bot });
    return c.json(bot, 201);
  });

  app.patch('/v1/bots/:id', async (c) => {
    const corpo = await lerCorpo(c, EsquemaBotEdicao);
    if ('resposta' in corpo) return corpo.resposta;
    const editado = editarBot(deps.banco, c.req.param('id'), corpo.dados);
    if (!editado) return c.json({ erro: 'nao_encontrado' }, 404);
    const bot = paraContrato(editado, deps.turnos.ativo(editado.id));
    deps.barramento.publicar({ tipo: 'bot_salvo', bot });
    return c.json(bot);
  });

  app.get('/v1/bots/:id/mensagens', (c) => {
    const bot = obterBot(deps.banco, c.req.param('id'));
    if (!bot) return c.json({ erro: 'nao_encontrado' }, 404);
    const antes = inteiroDaQuery(c.req.query('antes'), 1, Number.MAX_SAFE_INTEGER);
    const limite = inteiroDaQuery(c.req.query('limite'), 1, LIMITES.mensagensPorPagina);
    if (antes === 'invalido' || limite === 'invalido') return c.json({ erro: 'dados_invalidos' }, 400);
    const pagina = listarMensagens(deps.banco, bot.id, antes, limite ?? LIMITES.mensagensPorPagina);
    // A resposta em andamento sai com o que já chegou; o banco só recebe o texto no fim do turno.
    const mensagens = pagina.mensagens.map((mensagem) =>
      mensagem.estado === 'em_andamento'
        ? { ...mensagem, texto: deps.turnos.textoParcial(mensagem.id) ?? mensagem.texto }
        : mensagem,
    );
    return c.json({ mensagens, temMais: pagina.temMais });
  });

  app.post('/v1/bots/:id/turnos', async (c) => {
    const bot = obterBot(deps.banco, c.req.param('id'));
    if (!bot) return c.json({ erro: 'nao_encontrado' }, 404);
    const corpo = await lerCorpo(c, EsquemaPedidoTurno);
    if ('resposta' in corpo) return corpo.resposta;
    const inicio = deps.turnos.iniciar(bot, corpo.dados.texto);
    if (!inicio.ok) return c.json({ erro: inicio.motivo }, inicio.motivo === 'turno_em_andamento' ? 409 : 429);
    return c.json({ usuario: inicio.usuario, bot: inicio.bot }, 201);
  });

  app.post('/v1/bots/:id/turnos/atual/parar', (c) => {
    if (!obterBot(deps.banco, c.req.param('id'))) return c.json({ erro: 'nao_encontrado' }, 404);
    if (!deps.turnos.parar(c.req.param('id'))) return c.json({ erro: 'sem_turno_ativo' }, 409);
    return c.body(null, 204);
  });

  app.get('/v1/aprovacoes', (c) => c.json({ aprovacoes: deps.aprovacoes.pendentes() }));

  // A única porta de entrada de uma decisão: um aparelho pareado. O motor só pede; nunca aprova.
  app.post('/v1/aprovacoes/:id', async (c) => {
    const corpo = await lerCorpo(c, EsquemaDecisaoAprovacao);
    if ('resposta' in corpo) return corpo.resposta;
    const resultado = deps.aprovacoes.decidir(c.req.param('id'), corpo.dados.decisao, c.get('dispositivo').id);
    if (resultado === 'nao_encontrado') return c.json({ erro: 'nao_encontrado' }, 404);
    if (resultado === 'ja_resolvida') return c.json({ erro: 'ja_resolvida' }, 409);
    return c.json(resultado);
  });

  app.get('/v1/eventos', (c) => {
    const token = c.get('token');
    const desde = c.req.header('last-event-id') ?? c.req.query('desde');

    return streamSSE(c, async (fluxo) => {
      const fila: EventoNumerado[] = [];
      let acordar: (() => void) | null = null;
      // Quem conecta sem ponto de retomada recebe o ponto atual no primeiro sinal de vida.
      const cursorInicial = desde === undefined ? deps.barramento.cursor() : undefined;
      const cancelar = deps.barramento.assinar(desde, (item) => {
        fila.push(item);
        acordar?.();
      });
      fluxo.onAbort(() => {
        cancelar();
        acordar?.();
      });

      try {
        // Primeiro sinal de vida: o app sabe que a conexão abriu antes de qualquer evento.
        await fluxo.writeSSE({ id: cursorInicial, event: 'ping', data: '' });
        while (!fluxo.aborted && !fluxo.closed) {
          for (let item = fila.shift(); item !== undefined; item = fila.shift()) {
            await fluxo.writeSSE({ id: item.id, event: 'evento', data: JSON.stringify(item.evento) });
          }
          const semNovidade = await new Promise<boolean>((ok) => {
            const relogio = setTimeout(() => ok(true), intervaloPingMs);
            acordar = () => {
              clearTimeout(relogio);
              ok(false);
            };
          });
          acordar = null;
          if (semNovidade) {
            // Aparelho revogado perde o fluxo no próximo sinal de vida.
            if (!autenticar(deps.banco, token)) break;
            await fluxo.writeSSE({ event: 'ping', data: '' });
          }
        }
      } finally {
        cancelar();
      }
    });
  });

  return app;
}
