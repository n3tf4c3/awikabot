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
  type InfoDoServidor,
  type Saude,
} from '@awikabot/core';
import type { ZodType } from 'zod';
import type { GestorDeAprovacoes } from './aprovacoes';
import type { Banco } from './banco';
import { criarBot, editarBot, listarBots, obterBot, paraContrato } from './bots';
import { CATALOGO, esforcoValido, motorDoCatalogo, motorParaCriarBot } from './catalogo';
import { listarMensagens } from './conversa';
import { autenticar, dispositivoAtivo, origemDoPedido, parear, revogar, type LimitadorDeTentativas } from './dispositivos';
import { FilaDeEventos, type Barramento, type LimitesDaFila } from './eventos';
import type { GestorDeTurnos } from './turnos';

export interface Dependencias {
  versao: string;
  banco: Banco;
  barramento: Barramento;
  turnos: GestorDeTurnos;
  aprovacoes: GestorDeAprovacoes;
  limitador: LimitadorDeTentativas;
  /** Motores ainda não prontos em que este servidor aceita criar bot (`AWIKA_MOTORES_EM_PROVA`). */
  motoresEmProva?: readonly string[];
  /** Intervalo do sinal de vida do fluxo de eventos. Menor nos testes. */
  intervaloPingMs?: number;
  /** Quanto a fila de cada app conectado ao fluxo de eventos guarda. Menor nos testes. */
  limitesDaFilaDeEventos?: LimitesDaFila;
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
  // Versão e protocolo só saem na resposta do pareamento, para quem provou ter um código.
  const servidor = (): InfoDoServidor => ({ versao: deps.versao, protocolo: VERSAO_PROTOCOLO });

  app.use('*', async (c, next) => {
    await next();
    c.header('cache-control', 'no-store');
    c.header('x-content-type-options', 'nosniff');
    // A API só devolve JSON e um fluxo de eventos: nada aqui deve ser carregado ou emoldurado por uma página.
    c.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    c.header('x-frame-options', 'DENY');
    c.header('referrer-policy', 'no-referrer');
    // Só tem efeito quando a resposta chega por HTTPS, que é o caso do túnel.
    c.header('strict-transport-security', 'max-age=31536000');
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
    return c.json({ status: 'ok' } satisfies Saude);
  });
  app.all('/healthz', (c) => {
    c.header('allow', 'GET');
    return c.json({ erro: 'metodo_nao_permitido' }, 405);
  });

  app.use('/v1/*', bodyLimit({ maxSize: CORPO_MAXIMO, onError: (c) => c.json({ erro: 'corpo_grande_demais' }, 413) }));

  // Único ponto sem token: troca um código de uso único pelo token do aparelho.
  app.post('/v1/parear', async (c) => {
    // O servidor do Node entrega a conexão ao Hono em `env.incoming`.
    const conexao = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
    const origem = origemDoPedido(c.req.header('cf-connecting-ip'), conexao);
    if (deps.limitador.bloqueado(origem)) return c.json({ erro: 'muitas_tentativas' }, 429);
    const corpo = await lerCorpo(c, EsquemaPedidoPareamento);
    if ('resposta' in corpo) return corpo.resposta;
    // De novo depois da leitura: pedidos simultâneos passaram juntos pela conferência de cima. Daqui
    // até registrar a falha não há espera, então nenhum outro pedido se encaixa no meio.
    if (deps.limitador.bloqueado(origem)) return c.json({ erro: 'muitas_tentativas' }, 429);
    const pareado = parear(deps.banco, corpo.dados.codigo, corpo.dados.nome);
    if (!pareado) {
      deps.limitador.registrarFalha(origem);
      return c.json({ erro: 'codigo_invalido' }, 401);
    }
    return c.json({ token: pareado.token, dispositivo: pareado.dispositivo, servidor: servidor() });
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

  // O que o app oferece nas listas do formulário. O modelo é sugestão; o motor e o esforço, não.
  app.get('/v1/catalogo', (c) => c.json(CATALOGO));

  app.get('/v1/bots', (c) =>
    c.json({ bots: listarBots(deps.banco).map((bot) => paraContrato(bot, deps.turnos.ativo(bot.id))) }),
  );

  app.post('/v1/bots', async (c) => {
    const corpo = await lerCorpo(c, EsquemaBotEntrada);
    if ('resposta' in corpo) return corpo.resposta;
    // Um modelo fora da lista do catálogo vale; um motor ou um esforço que o servidor não sabe rodar, não.
    const motor = motorParaCriarBot(corpo.dados.motor, CATALOGO, deps.motoresEmProva ?? []);
    if (!motor || !esforcoValido(motor, corpo.dados.esforco)) return c.json({ erro: 'dados_invalidos' }, 400);
    const bot = paraContrato(criarBot(deps.banco, corpo.dados), false);
    deps.barramento.publicar({ tipo: 'bot_salvo', bot });
    return c.json(bot, 201);
  });

  app.patch('/v1/bots/:id', async (c) => {
    const corpo = await lerCorpo(c, EsquemaBotEdicao);
    if ('resposta' in corpo) return corpo.resposta;
    const atual = obterBot(deps.banco, c.req.param('id'));
    if (!atual) return c.json({ erro: 'nao_encontrado' }, 404);
    // O esforço é conferido contra o motor do bot, que a edição não muda. Voltar ao padrão sempre vale.
    const motor = motorDoCatalogo(atual.motor);
    const esforco = corpo.dados.esforco;
    if (esforco !== undefined && esforco !== null && !(motor && esforcoValido(motor, esforco))) {
      return c.json({ erro: 'dados_invalidos' }, 400);
    }
    const editado = editarBot(deps.banco, atual.id, corpo.dados);
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
    // O que já foi decidido em cada resposta vem junto: é o que a conversa mostra de um pedido antigo.
    const aprovacoes = deps.aprovacoes.resolvidasDasMensagens(
      mensagens.filter((mensagem) => mensagem.papel === 'bot').map((mensagem) => mensagem.id),
    );
    return c.json({ mensagens, temMais: pagina.temMais, aprovacoes });
  });

  app.post('/v1/bots/:id/turnos', async (c) => {
    const bot = obterBot(deps.banco, c.req.param('id'));
    if (!bot) return c.json({ erro: 'nao_encontrado' }, 404);
    const corpo = await lerCorpo(c, EsquemaPedidoTurno);
    if ('resposta' in corpo) return corpo.resposta;
    const inicio = deps.turnos.iniciar(bot, corpo.dados.texto);
    if (!inicio.ok) {
      // O servidor saindo é indisponibilidade, não erro do pedido: o app tenta de novo depois.
      const status = inicio.motivo === 'servidor_encerrando' ? 503 : inicio.motivo === 'turno_em_andamento' ? 409 : 429;
      return c.json({ erro: inicio.motivo }, status);
    }
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
    const aparelho = c.get('dispositivo').id;
    const desde = c.req.header('last-event-id') ?? c.req.query('desde');

    return streamSSE(c, async (fluxo) => {
      // O app que lê devagar não faz o servidor guardar eventos sem teto: a fila solta o que passar dele.
      const fila = new FilaDeEventos(deps.limitesDaFilaDeEventos);
      let acordar: (() => void) | null = null;
      // Quem conecta sem ponto de retomada recebe o ponto atual no primeiro sinal de vida.
      const cursorInicial = desde === undefined ? deps.barramento.cursor() : undefined;
      const cancelar = deps.barramento.assinar(desde, (item) => {
        fila.por(item);
        acordar?.();
      });
      fluxo.onAbort(() => {
        cancelar();
        acordar?.();
      });

      try {
        // Primeiro sinal de vida: o app sabe que a conexão abriu antes de qualquer evento.
        await fluxo.writeSSE({ id: cursorInicial, event: 'ping', data: '' });
        let revogado = false;
        while (!revogado && !fluxo.aborted && !fluxo.closed) {
          for (let item = fila.tirar(); item !== undefined; item = fila.tirar()) {
            // Aparelho revogado não recebe mais nada, nem no meio de um turno: a conferência é
            // a cada evento, e vale também para a revogação feita pelo comando do servidor.
            if (!dispositivoAtivo(deps.banco, aparelho)) {
              revogado = true;
              break;
            }
            await fluxo.writeSSE({ id: item.id, event: 'evento', data: item.dados });
          }
          if (revogado) break;
          const semNovidade = await new Promise<boolean>((ok) => {
            const relogio = setTimeout(() => ok(true), intervaloPingMs);
            acordar = () => {
              clearTimeout(relogio);
              ok(false);
            };
          });
          acordar = null;
          if (semNovidade) {
            // Sem evento para conferir, a revogação é vista no sinal de vida.
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
