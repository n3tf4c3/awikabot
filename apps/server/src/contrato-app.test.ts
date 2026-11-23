// O cliente do app (apps/mobile/src/lib) falando com o servidor de verdade, pela rede.
// Os testes do app usam respostas de mentira; este prova que os dois lados concordam.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Evento } from '@awikabot/core';
import { criarApi, type Api, type Buscar } from '../../mobile/src/lib/api';
import { iniciarFluxoEventos, type BuscarFluxo, type FluxoEventos } from '../../mobile/src/lib/fluxo-eventos';
import type { Sessao } from '../../mobile/src/lib/sessao';
import { criarApp } from './app';
import { GestorDeAprovacoes } from './aprovacoes';
import { abrirBanco } from './banco';
import { criarCodigo, LimitadorDeTentativas } from './dispositivos';
import { Barramento } from './eventos';
import { criarAppDoGancho, Ganchos } from './gancho';
import { criarMotorSimulado } from './motor-simulado';
import { GestorDeTurnos } from './turnos';

const pasta = mkdtempSync(path.join(os.tmpdir(), 'awikabot-contrato-'));
const banco = abrirBanco(':memory:');
const barramento = new Barramento();
const aprovacoes = new GestorDeAprovacoes({ banco, barramento });
const ganchos = new Ganchos();
const servidorDoGancho = serve({ fetch: criarAppDoGancho({ ganchos, aprovacoes }).fetch, hostname: '127.0.0.1', port: 0 }) as Server;
await new Promise<void>((pronto) => servidorDoGancho.once('listening', () => pronto()));
const turnos = new GestorDeTurnos({
  banco,
  barramento,
  motor: criarMotorSimulado({ atrasoMs: 10 }),
  limite: 4,
  pastaDosBots: pasta,
  aprovacoes: { ganchos, aprovacoes, comando: 'o motor simulado não executa o gancho', porta: (servidorDoGancho.address() as AddressInfo).port },
});
const app =criarApp({ versao: '9.9.9-teste', banco, barramento, turnos, aprovacoes, limitador: new LimitadorDeTentativas(), intervaloPingMs: 50 });

const buscar: Buscar = (url, pedido) => fetch(url, pedido);
const buscarFluxo: BuscarFluxo = (url, pedido) => fetch(url, pedido) as unknown as ReturnType<BuscarFluxo>;

let servidor: Server;
let base = '';
let sessao: Sessao | null = null;
let api: Api;
let fluxo: FluxoEventos | undefined;
const eventos: Evento[] = [];
const sessoesRecusadas: Sessao[] = [];
let fluxoRecusado = false;

async function esperar(condicao: () => boolean, limiteMs = 5000): Promise<void> {
  const fim = Date.now() + limiteMs;
  while (!condicao() && Date.now() < fim) await new Promise((ok) => setTimeout(ok, 10));
  expect(condicao()).toBe(true);
}
const doTipo = <T extends Evento['tipo']>(tipo: T) => eventos.filter((e): e is Extract<Evento, { tipo: T }> => e.tipo === tipo);

beforeAll(async () => {
  servidor = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }) as Server;
  await new Promise<void>((pronto) => servidor.once('listening', () => pronto()));
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  api = criarApi({
    buscar,
    sessaoAtual: () => sessao,
    aoNaoAutenticado: (recusada) => {
      sessoesRecusadas.push(recusada);
    },
  });
});

afterAll(async () => {
  fluxo?.parar();
  servidorDoGancho.closeAllConnections();
  servidorDoGancho.close();
  servidor.closeAllConnections();
  await new Promise<void>((fim) => servidor.close(() => fim()));
  rmSync(pasta, { recursive: true, force: true });
});

describe('cliente do app contra o servidor', () => {
  it('pareia, cria e edita um bot', async () => {
    const pareado = await api.parear(base, { codigo: criarCodigo(banco), nome: 'App de teste' });
    sessao = { servidor: base, token: pareado.token, dispositivo: pareado.dispositivo };

    fluxo = iniciarFluxoEventos({
      buscar: buscarFluxo,
      url: `${base}/v1/eventos`,
      token: pareado.token,
      aoEvento: (evento) => eventos.push(evento),
      aoNaoAutenticado: () => {
        fluxoRecusado = true;
      },
    });
    // Conexão aberta sem ponto de retomada: o app pede uma carga inicial a si mesmo.
    await esperar(() => doTipo('ressincronizar').length === 1);

    const bot = await api.criarBot({ nome: 'Scout', instrucoes: 'Seja breve.', modelo: null });
    const editado = await api.editarBot(bot.id, { nome: 'Scout 2' });
    expect(editado).toMatchObject({ id: bot.id, nome: 'Scout 2', instrucoes: 'Seja breve.' });
    expect((await api.listarBots()).bots.map((b) => b.nome)).toEqual(['Scout 2']);
    await esperar(() => doTipo('bot_salvo').length === 2);
  });

  it('conversa com resposta aos poucos, pagina e para um turno', async () => {
    const botId = (await api.listarBots()).bots[0]!.id;
    const turno = await api.enviarTurno(botId, { texto: 'olá mundo' });
    expect(turno.bot.estado).toBe('em_andamento');
    await esperar(() => doTipo('turno_terminado').length === 1);

    const trechos = doTipo('texto');
    let tamanho = 0;
    for (const trecho of trechos) {
      expect(trecho.posicao).toBe(tamanho);
      tamanho += trecho.trecho.length;
    }
    expect(trechos.map((t) => t.trecho).join('')).toBe('Você disse: olá mundo');

    const tudo = await api.listarMensagens(botId);
    expect(tudo.mensagens.map((m) => [m.seq, m.papel, m.estado])).toEqual([
      [1, 'usuario', 'completa'],
      [2, 'bot', 'completa'],
    ]);
    expect(await api.listarMensagens(botId, { limite: 1 })).toMatchObject({ temMais: true });
    expect((await api.listarMensagens(botId, { antes: 2, limite: 5 })).mensagens.map((m) => m.seq)).toEqual([1]);

    await api.enviarTurno(botId, { texto: Array.from({ length: 200 }, (_, i) => `p${i}`).join(' ') });
    await esperar(() => doTipo('texto').length > trechos.length);
    await api.pararTurno(botId);
    await esperar(() => doTipo('turno_terminado').some((e) => e.mensagem.estado === 'parada'));
    await expect(api.pararTurno(botId)).rejects.toThrow();
  });

  it('retoma o fluxo de onde parou, sem pedir tudo de novo', async () => {
    const botId = (await api.listarBots()).bots[0]!.id;
    const salvosAntes = doTipo('bot_salvo').length;
    fluxo!.pausar();
    await api.editarBot(botId, { nome: 'Scout 3' });
    fluxo!.retomar();
    await esperar(() => doTipo('bot_salvo').length === salvosAntes + 1);
    expect(doTipo('bot_salvo').at(-1)?.bot.nome).toBe('Scout 3');
    expect(doTipo('ressincronizar')).toHaveLength(1);
  });

  it('recebe o pedido de aprovação e leva a decisão ao servidor', async () => {
    const botId = (await api.listarBots()).bots[0]!.id;
    const terminadosAntes = doTipo('turno_terminado').length;
    await api.enviarTurno(botId, { texto: '!comando echo oi' });
    await esperar(() => doTipo('aprovacao_pedida').length === 1);

    const [pendente] = (await api.listarAprovacoes()).aprovacoes;
    expect(pendente).toMatchObject({ botId, ferramenta: 'Bash', resumo: 'echo oi', estado: 'pendente' });
    expect((await api.decidirAprovacao(pendente!.id, { decisao: 'aprovar' })).estado).toBe('aprovada');
    await esperar(() => doTipo('aprovacao_resolvida').length === 1 && doTipo('turno_terminado').length === terminadosAntes + 1);
    expect(doTipo('turno_terminado').at(-1)?.mensagem.texto).toBe('Comando permitido: echo oi');

    expect((await api.listarAprovacoes()).aprovacoes).toEqual([]);
    await expect(api.decidirAprovacao(pendente!.id, { decisao: 'negar' })).rejects.toThrow();
    await expect(api.decidirAprovacao('abcdefgh12345678', { decisao: 'aprovar' })).rejects.toThrow();
  });

  it('desparear revoga o token: a API e o fluxo passam a ser recusados', async () => {
    const atual = sessao!;
    await api.revogarDispositivo({ servidor: atual.servidor, token: atual.token });
    await expect(api.listarBots()).rejects.toThrow();
    expect(sessoesRecusadas).toEqual([atual]);
    await esperar(() => fluxoRecusado, 8000);
  });
});
