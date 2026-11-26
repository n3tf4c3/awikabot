// O fluxo F5: o que sobra depois de o servidor cair no meio de um turno, e o que o app vê na volta.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { afterAll, describe, expect, it } from 'vitest';
import type { Evento } from '@awikabot/core';
import { criarApi, type Buscar } from '../../mobile/src/lib/api';
import { iniciarFluxoEventos, type BuscarFluxo } from '../../mobile/src/lib/fluxo-eventos';
import type { Sessao } from '../../mobile/src/lib/sessao';
import { criarApp } from './app';
import { expirarPendentesNaPartida, GestorDeAprovacoes } from './aprovacoes';
import { abrirBanco, type Banco } from './banco';
import { criarBot, obterBot } from './bots';
import { listarMensagens, marcarInterrompidas } from './conversa';
import { criarCodigo, LimitadorDeTentativas } from './dispositivos';
import { Barramento } from './eventos';
import type { Motor, ResultadoMotor } from './motor';
import { criarMotorSimulado } from './motor-simulado';
import { GestorDeTurnos } from './turnos';

const pasta = mkdtempSync(path.join(os.tmpdir(), 'awikabot-retomada-'));
const aoFim: (() => void | Promise<void>)[] = [];
afterAll(async () => {
  for (const desfazer of aoFim.reverse()) await desfazer();
  rmSync(pasta, { recursive: true, force: true });
});

/**
 * Motor que fala uma palavra a cada intervalo e nunca termina sozinho. `derrubar()` faz o papel
 * da queda do processo: ele some sem avisar ninguém, e o fim do turno nunca chega.
 */
function criarMotorQueCai(atrasoMs = 5) {
  const relogios = new Set<NodeJS.Timeout>();
  const motor: Motor = (pedido) => {
    let texto = '';
    let resolver: (resultado: ResultadoMotor) => void = () => {};
    const fim = new Promise<ResultadoMotor>((ok) => {
      resolver = ok;
    });
    const relogio = setInterval(() => {
      texto += 'palavra ';
      pedido.aoTexto('palavra ');
    }, atrasoMs);
    relogios.add(relogio);
    return {
      fim,
      parar: () => {
        clearInterval(relogio);
        relogios.delete(relogio);
        // Como um processo de verdade, o motor leva um tempo para sair depois do pedido de parada.
        setTimeout(() => resolver({ estado: 'parada', texto, sessao: pedido.sessao }), 30);
      },
    };
  };
  const derrubar = (): void => {
    for (const relogio of relogios) clearInterval(relogio);
    relogios.clear();
  };
  return { motor, derrubar };
}

/** O que a partida do servidor faz com o banco antes de atender: o mesmo par de chamadas do `main.ts`. */
function partir(arquivo: string): Banco {
  const banco = abrirBanco(arquivo);
  marcarInterrompidas(banco);
  expirarPendentesNaPartida(banco);
  return banco;
}

const esperar = async (condicao: () => boolean, limiteMs = 5000): Promise<void> => {
  const fim = Date.now() + limiteMs;
  while (!condicao() && Date.now() < fim) await new Promise((ok) => setTimeout(ok, 10));
  expect(condicao()).toBe(true);
};

describe('queda no meio de um turno', () => {
  it('o que já tinha chegado fica guardado, e a partida seguinte marca a resposta como falha', async () => {
    const arquivo = path.join(pasta, 'queda.db');
    const antes = abrirBanco(arquivo);
    const { motor, derrubar } = criarMotorQueCai();
    const turnos = new GestorDeTurnos({ banco: antes, barramento: new Barramento(), motor, limite: 4, pastaDosBots: pasta, intervaloGravacaoMs: 20 });
    const bot = criarBot(antes, { nome: 'Scout', instrucoes: '', modelo: null });

    const inicio = turnos.iniciar(bot, 'conte até o fim');
    expect(inicio.ok).toBe(true);
    await esperar(() => (listarMensagens(antes, bot.id, null, 10).mensagens[1]?.texto.length ?? 0) > 0);
    // A queda: o motor some, o banco fecha sem o turno ser concluído.
    derrubar();
    antes.close();

    const depois = partir(arquivo);
    aoFim.push(() => depois.close());
    const [pergunta, resposta] = listarMensagens(depois, bot.id, null, 10).mensagens;
    expect(pergunta).toMatchObject({ papel: 'usuario', texto: 'conte até o fim', estado: 'completa' });
    expect(resposta?.estado).toBe('falhou');
    expect(resposta?.texto).toMatch(/^(palavra )+$/);

    // O bot não ficou preso: aceita um turno novo, que termina.
    const novos = new GestorDeTurnos({ banco: depois, barramento: new Barramento(), motor: criarMotorSimulado({ atrasoMs: 1 }), limite: 4, pastaDosBots: pasta });
    expect(novos.ativo(bot.id)).toBe(false);
    expect(novos.iniciar(obterBot(depois, bot.id)!, 'de novo').ok).toBe(true);
    await esperar(() => !novos.ativo(bot.id));
    expect(listarMensagens(depois, bot.id, null, 10).mensagens.map((m) => m.estado)).toEqual(['completa', 'falhou', 'completa', 'completa']);
  });

  it('sem a gravação aos poucos, a queda leva o texto inteiro', async () => {
    const arquivo = path.join(pasta, 'sem-parcial.db');
    const antes = abrirBanco(arquivo);
    const { motor, derrubar } = criarMotorQueCai();
    // Intervalo maior que o teste: nada é gravado antes da queda.
    const turnos = new GestorDeTurnos({ banco: antes, barramento: new Barramento(), motor, limite: 4, pastaDosBots: pasta, intervaloGravacaoMs: 60_000 });
    const bot = criarBot(antes, { nome: 'Scout', instrucoes: '', modelo: null });
    const inicio = turnos.iniciar(bot, 'conte');
    await esperar(() => inicio.ok && (turnos.textoParcial(inicio.bot.id)?.length ?? 0) > 0);
    derrubar();
    antes.close();

    const depois = partir(arquivo);
    aoFim.push(() => depois.close());
    expect(listarMensagens(depois, bot.id, null, 10).mensagens[1]).toMatchObject({ estado: 'falhou', texto: '' });
  });
});

describe('parada normal do servidor', () => {
  it('espera cada turno fechar: a resposta fica como parada, com o texto que já tinha', async () => {
    const banco = abrirBanco(':memory:');
    aoFim.push(() => banco.close());
    const { motor } = criarMotorQueCai();
    const turnos = new GestorDeTurnos({ banco, barramento: new Barramento(), motor, limite: 4, pastaDosBots: pasta });
    const um = criarBot(banco, { nome: 'Um', instrucoes: '', modelo: null });
    const dois = criarBot(banco, { nome: 'Dois', instrucoes: '', modelo: null });
    const inicio = turnos.iniciar(um, 'a');
    turnos.iniciar(dois, 'b');
    await esperar(() => inicio.ok && (turnos.textoParcial(inicio.bot.id)?.length ?? 0) > 0);

    await turnos.pararTodos();

    for (const bot of [um, dois]) {
      expect(turnos.ativo(bot.id)).toBe(false);
      expect(listarMensagens(banco, bot.id, null, 10).mensagens[1]?.estado).toBe('parada');
    }
    expect(listarMensagens(banco, um.id, null, 10).mensagens[1]?.texto).toMatch(/^(palavra )+$/);
  });

  it('não espera para sempre um turno que não fecha', async () => {
    const banco = abrirBanco(':memory:');
    aoFim.push(() => banco.close());
    const motorSurdo: Motor = () => ({ fim: new Promise<ResultadoMotor>(() => {}), parar: () => {} });
    const turnos = new GestorDeTurnos({ banco, barramento: new Barramento(), motor: motorSurdo, limite: 4, pastaDosBots: pasta });
    turnos.iniciar(criarBot(banco, { nome: 'Surdo', instrucoes: '', modelo: null }), 'a');

    const inicio = Date.now();
    await turnos.pararTodos(50);
    expect(Date.now() - inicio).toBeLessThan(2000);
  });
});

describe('cliente do app depois de o servidor reiniciar', () => {
  it('o fluxo pede nova carga, o histórico volta e a resposta interrompida vem marcada', async () => {
    const arquivo = path.join(pasta, 'app.db');
    const queda = criarMotorQueCai();

    const subir = async (banco: Banco, motor: Motor, porta: number) => {
      const barramento = new Barramento();
      const turnos = new GestorDeTurnos({ banco, barramento, motor, limite: 4, pastaDosBots: pasta, intervaloGravacaoMs: 20 });
      const app = criarApp({
        versao: '9.9.9-teste',
        banco,
        barramento,
        turnos,
        aprovacoes: new GestorDeAprovacoes({ banco, barramento }),
        limitador: new LimitadorDeTentativas(),
        intervaloPingMs: 50,
      });
      const servidor = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: porta }) as Server;
      await new Promise<void>((pronto) => servidor.once('listening', () => pronto()));
      return { servidor, porta: (servidor.address() as AddressInfo).port };
    };
    const derrubarServidor = async (servidor: Server): Promise<void> => {
      servidor.closeAllConnections();
      await new Promise<void>((fim) => servidor.close(() => fim()));
    };

    const bancoAntes = abrirBanco(arquivo);
    const primeiro = await subir(bancoAntes, queda.motor, 0);
    const base = `http://127.0.0.1:${primeiro.porta}`;

    let sessao: Sessao | null = null;
    const buscar: Buscar = (url, pedido) => fetch(url, pedido);
    const buscarFluxo: BuscarFluxo = (url, pedido) => fetch(url, pedido) as unknown as ReturnType<BuscarFluxo>;
    const api = criarApi({ buscar, sessaoAtual: () => sessao, aoNaoAutenticado: () => {} });
    const pareado = await api.parear(base, { codigo: criarCodigo(bancoAntes), nome: 'App de teste' });
    sessao = { servidor: base, token: pareado.token, dispositivo: pareado.dispositivo };

    const eventos: Evento[] = [];
    const fluxo = iniciarFluxoEventos({
      buscar: buscarFluxo,
      url: `${base}/v1/eventos`,
      token: pareado.token,
      aoEvento: (evento) => eventos.push(evento),
      aoNaoAutenticado: () => {},
    });
    aoFim.push(() => fluxo.parar());
    const cargas = (): number => eventos.filter((e) => e.tipo === 'ressincronizar').length;
    await esperar(() => cargas() === 1);

    const bot = await api.criarBot({ nome: 'Scout', instrucoes: '', modelo: null, motor: 'claude-code', esforco: null });
    await api.enviarTurno(bot.id, { texto: 'conte até o fim' });
    await esperar(() => eventos.filter((e) => e.tipo === 'texto').length >= 8);
    expect((await api.listarBots()).bots[0]?.turnoAtivo).toBe(true);

    // A queda, e a volta do servidor no mesmo endereço, com o mesmo banco.
    queda.derrubar();
    await derrubarServidor(primeiro.servidor);
    bancoAntes.close();
    const bancoDepois = partir(arquivo);
    const segundo = await subir(bancoDepois, criarMotorSimulado({ atrasoMs: 1 }), primeiro.porta);
    aoFim.push(async () => {
      await derrubarServidor(segundo.servidor);
      bancoDepois.close();
    });

    // O ponto de retomada que o app guardou é do servidor que caiu: ele recebe o pedido de nova carga.
    await esperar(() => cargas() === 2, 8000);
    expect((await api.listarBots()).bots).toMatchObject([{ id: bot.id, nome: 'Scout', turnoAtivo: false }]);
    const { mensagens } = await api.listarMensagens(bot.id);
    expect(mensagens.map((m) => [m.papel, m.estado])).toEqual([
      ['usuario', 'completa'],
      ['bot', 'falhou'],
    ]);
    expect(mensagens[1]?.texto).toMatch(/^(palavra )+$/);

    // A sessão do aparelho continua valendo, e o bot conversa de novo.
    await api.enviarTurno(bot.id, { texto: 'voltou?' });
    await esperar(() => eventos.some((e) => e.tipo === 'turno_terminado' && e.mensagem.texto === 'Você disse: voltou?'));
  }, 20_000);
});
