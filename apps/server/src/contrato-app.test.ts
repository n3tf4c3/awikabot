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
import { aprovacoesDoBot, ehAprovacao, intercalarAprovacoes, situacaoDoBot } from '../../mobile/src/lib/aprovacoes';
import { motoresParaCriar, opcoesDeModelo } from '../../mobile/src/lib/catalogo';
import { mensagensVisiveis } from '../../mobile/src/lib/conversa';
import { criarArmazemDados } from '../../mobile/src/lib/dados';
import { iniciarFluxoEventos, type BuscarFluxo, type FluxoEventos } from '../../mobile/src/lib/fluxo-eventos';
import { criarOperacoes } from '../../mobile/src/lib/operacoes';
import { criarRecarga } from '../../mobile/src/lib/recarga';
import type { Sessao } from '../../mobile/src/lib/sessao';
import { criarApp } from './app';
import { GestorDeAprovacoes } from './aprovacoes';
import { abrirBanco } from './banco';
import { criarCodigo, enderecosDeAviso, LimitadorDeTentativas } from './dispositivos';
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

    // O formulário monta as listas com o catálogo e cria o bot com o que a pessoa escolheu nelas.
    const catalogo = await api.catalogo();
    const motor = catalogo.motores.find((item) => item.pronto)!;
    const bot = await api.criarBot({
      nome: 'Scout',
      instrucoes: 'Seja breve.',
      modelo: motor.modelos[0]!.id,
      motor: motor.id,
      esforco: motor.esforcos[0]!.id,
    });
    expect(bot).toMatchObject({ motor: 'claude-code', modelo: 'fable', esforco: 'low' });
    // O Codex, pronto, entra na lista de motores do formulário, com os modelos e esforços dele.
    expect(motoresParaCriar(catalogo).map((opcao) => opcao.valor)).toEqual(['claude-code', 'codex']);
    expect(opcoesDeModelo(catalogo, 'codex').map((opcao) => opcao.valor)).toEqual(['', 'gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-terra', 'gpt-6-luna']);
    const editado = await api.editarBot(bot.id, { nome: 'Scout 2', modelo: null, esforco: null });
    expect(editado).toMatchObject({ id: bot.id, nome: 'Scout 2', instrucoes: 'Seja breve.', motor: 'claude-code', modelo: null, esforco: null });
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

  it('quem abre o app depois vê na conversa o pedido que já foi resolvido', async () => {
    const botId = (await api.listarBots()).bots[0]!.id;
    // Um app recém-aberto: não viu o pedido nem a decisão passarem pelo fluxo de eventos.
    const armazem = criarArmazemDados();
    const operacoes = criarOperacoes(api, armazem);
    await Promise.all([operacoes.carregarAprovacoes(), operacoes.carregarConversa(botId)]);

    const estado = armazem.estado();
    const resolvidas = aprovacoesDoBot(estado.aprovacoes, botId);
    expect(resolvidas).toMatchObject([{ botId, ferramenta: 'Bash', resumo: 'echo oi', estado: 'aprovada' }]);
    // A linha do pedido fica logo depois da resposta em que ele surgiu (a lista vai da mais nova para a mais antiga).
    const itens = intercalarAprovacoes(mensagensVisiveis(estado.conversas[botId]!), resolvidas);
    const posicao = itens.findIndex((item) => ehAprovacao(item));
    expect(itens[posicao + 1]).toMatchObject({ id: resolvidas[0]!.mensagemId, texto: 'Comando permitido: echo oi' });
    expect(situacaoDoBot({ id: botId, turnoAtivo: false }, estado.aprovacoes)).toBeNull();
  });

  it('guarda e esquece o endereço de aviso push deste aparelho, e recusa um endereço fora do formato', async () => {
    const endereco = 'ExponentPushToken[contratocontratocontrato]';
    await api.registrarAviso({ endereco });
    expect(enderecosDeAviso(banco).map((destino) => destino.endereco)).toEqual([endereco]);
    await expect(api.registrarAviso({ endereco: 'https://outro.lugar/qualquer' })).rejects.toMatchObject({ codigo: 'dados_invalidos', status: 400 });
    expect(enderecosDeAviso(banco).map((destino) => destino.endereco)).toEqual([endereco]);
    await api.esquecerAviso();
    expect(enderecosDeAviso(banco)).toEqual([]);
  });

  it('o pedido que já esperava aparece mesmo se a primeira busca dos pendentes falha, sem ninguém pedir de novo', async () => {
    const botId = (await api.listarBots()).bots[0]!.id;
    // O bot fica parado num pedido de aprovação antes de o app abrir: nenhum evento vai contar isso a ele.
    const pedidasAntes = doTipo('aprovacao_pedida').length;
    await api.enviarTurno(botId, { texto: '!comando echo esperando' });
    await esperar(() => doTipo('aprovacao_pedida').length === pedidasAntes + 1);

    // Um app recém-aberto, cuja primeira busca dos pendentes cai. O fluxo de eventos segue de pé.
    let quedas = 2;
    const comQueda: Buscar = (url, pedido) => {
      if (url.endsWith('/v1/aprovacoes') && quedas > 0) {
        quedas -= 1;
        return Promise.reject(new TypeError('rede fora'));
      }
      return fetch(url, pedido);
    };
    const armazem = criarArmazemDados();
    const operacoes = criarOperacoes(criarApi({ buscar: comQueda, sessaoAtual: () => sessao, aoNaoAutenticado: () => {} }), armazem);
    const recarga = criarRecarga({ carregar: operacoes.carregarAprovacoes, esperasMs: [5] });
    try {
      recarga.pedir();
      await esperar(() => armazem.estado().cargaDeAprovacoes === 'falhou');
      expect(aprovacoesDoBot(armazem.estado().aprovacoes, botId)).toEqual([]);

      await esperar(() => armazem.estado().cargaDeAprovacoes === 'pronta');
      expect(quedas).toBe(0);
      expect(aprovacoesDoBot(armazem.estado().aprovacoes, botId).filter((a) => a.estado === 'pendente')).toMatchObject([
        { botId, ferramenta: 'Bash', resumo: 'echo esperando', estado: 'pendente' },
      ]);
      expect(situacaoDoBot({ id: botId, turnoAtivo: true }, armazem.estado().aprovacoes)).not.toBeNull();
    } finally {
      recarga.parar();
      const pendente = (await api.listarAprovacoes()).aprovacoes[0];
      if (pendente) await api.decidirAprovacao(pendente.id, { decisao: 'negar' });
      await esperar(() => !turnos.ativo(botId));
    }
  });

  it('desparear revoga o token: a API e o fluxo passam a ser recusados', async () => {
    const atual = sessao!;
    await api.revogarDispositivo({ servidor: atual.servidor, token: atual.token });
    await expect(api.listarBots()).rejects.toThrow();
    expect(sessoesRecusadas).toEqual([atual]);
    await esperar(() => fluxoRecusado, 8000);
  });
});
