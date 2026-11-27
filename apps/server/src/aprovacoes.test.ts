import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { afterAll, describe, expect, it } from 'vitest';
import {
  EsquemaAprovacao,
  EsquemaBot,
  EsquemaErro,
  EsquemaListaAprovacoes,
  EsquemaListaMensagens,
  EsquemaRespostaPareamento,
  EsquemaRespostaTurno,
  LIMITES,
  type Evento,
} from '@awikabot/core';
import { criarApp } from './app';
import { expirarPendentesNaPartida, GestorDeAprovacoes } from './aprovacoes';
import { abrirBanco } from './banco';
import { criarCodigo, LimitadorDeTentativas } from './dispositivos';
import { Barramento } from './eventos';
import { subirEscada } from './decisao';
import { criarAppDoGancho, Ganchos } from './gancho';
import { criarJuiz } from './juiz';
import type { Motor } from './motor';
import { criarMotorSimulado } from './motor-simulado';
import { GestorDeTurnos } from './turnos';

const pastaTemporaria = mkdtempSync(path.join(os.tmpdir(), 'awikabot-aprovacoes-'));
const servidores: Server[] = [];
afterAll(async () => {
  for (const servidor of servidores) {
    servidor.closeAllConnections();
    await new Promise<void>((fim) => servidor.close(() => fim()));
  }
  rmSync(pastaTemporaria, { recursive: true, force: true });
});

const NEGADO_PELA_PESSOA = 'negado pela pessoa, ou sem resposta a tempo';

async function montar(opcoes: { esperaMs?: number } = {}) {
  const banco = abrirBanco(':memory:');
  const barramento = new Barramento();
  const aprovacoes = new GestorDeAprovacoes({ banco, barramento, esperaMs: opcoes.esperaMs });
  const ganchos = new Ganchos();
  const servidorDoGancho = serve({ fetch: criarAppDoGancho({ ganchos, aprovacoes }).fetch, hostname: '127.0.0.1', port: 0 }) as Server;
  await new Promise<void>((pronto) => servidorDoGancho.once('listening', () => pronto()));
  servidores.push(servidorDoGancho);
  const portaDoGancho = (servidorDoGancho.address() as AddressInfo).port;

  const turnos = new GestorDeTurnos({
    banco,
    barramento,
    motor: criarMotorSimulado({ atrasoMs: 1 }),
    limite: 4,
    pastaDosBots: pastaTemporaria,
    aprovacoes: { ganchos, aprovacoes, comando: 'o motor simulado não executa o gancho', porta: portaDoGancho },
  });
  const app = criarApp({ versao: '9.9.9-teste', banco, barramento, turnos, aprovacoes, limitador: new LimitadorDeTentativas() });

  const eventos: Evento[] = [];
  barramento.assinar(undefined, (item) => eventos.push(item.evento));

  const pedir = (caminho: string, opcoesPedido: { metodo?: string; corpo?: unknown; token?: string } = {}) =>
    app.request(caminho, {
      method: opcoesPedido.metodo ?? (opcoesPedido.corpo === undefined ? 'GET' : 'POST'),
      headers: {
        ...(opcoesPedido.corpo === undefined ? {} : { 'content-type': 'application/json' }),
        ...(opcoesPedido.token ? { authorization: `Bearer ${opcoesPedido.token}` } : {}),
      },
      body: opcoesPedido.corpo === undefined ? undefined : JSON.stringify(opcoesPedido.corpo),
    });
  const parearAparelho = async (nome: string) =>
    EsquemaRespostaPareamento.parse(await (await pedir('/v1/parear', { corpo: { codigo: criarCodigo(banco), nome } })).json());
  const esperar = async (condicao: () => boolean): Promise<void> => {
    for (let i = 0; i < 600 && !condicao(); i += 1) await new Promise((ok) => setTimeout(ok, 5));
    expect(condicao()).toBe(true);
  };

  const aparelho = await parearAparelho('Celular');
  const token = aparelho.token;
  const botId = EsquemaBot.parse(await (await pedir('/v1/bots', { token, corpo: { nome: 'Scout' } })).json()).id;

  const enviar = async (texto: string) =>
    EsquemaRespostaTurno.parse(await (await pedir(`/v1/bots/${botId}/turnos`, { token, corpo: { texto } })).json());
  const pendentes = async () =>
    EsquemaListaAprovacoes.parse(await (await pedir('/v1/aprovacoes', { token })).json()).aprovacoes;
  const respostaDoBot = async () => {
    await esperar(() => !turnos.ativo(botId));
    const lista = EsquemaListaMensagens.parse(await (await pedir(`/v1/bots/${botId}/mensagens`, { token })).json());
    return lista.mensagens.at(-1);
  };
  const doTipo = (tipo: Evento['tipo']) => eventos.filter((evento) => evento.tipo === tipo);

  return { banco, aprovacoes, ganchos, turnos, portaDoGancho, eventos, pedir, parearAparelho, esperar, aparelho, token, botId, enviar, pendentes, respostaDoBot, doTipo };
}

describe('aprovação de uma ação (F4)', () => {
  it('segura a ação até a pessoa aprovar', async () => {
    const a = await montar();
    const turno = await a.enviar('!comando echo oi');
    await a.esperar(() => a.doTipo('aprovacao_pedida').length === 1);

    const [pendente] = await a.pendentes();
    expect(pendente).toMatchObject({ botId: a.botId, mensagemId: turno.bot.id, ferramenta: 'Bash', resumo: 'echo oi', estado: 'pendente', resolvidaEm: null });
    expect(a.turnos.ativo(a.botId)).toBe(true);

    const decisao = await a.pedir(`/v1/aprovacoes/${pendente!.id}`, { token: a.token, corpo: { decisao: 'aprovar' } });
    expect(decisao.status).toBe(200);
    const resolvida = EsquemaAprovacao.parse(await decisao.json());
    expect(resolvida).toMatchObject({ id: pendente!.id, estado: 'aprovada' });
    expect(resolvida.resolvidaEm).toEqual(expect.any(Number));

    expect(await a.respostaDoBot()).toMatchObject({ texto: 'Comando permitido: echo oi', estado: 'completa' });
    expect(await a.pendentes()).toEqual([]);
    const ordem = a.eventos.map((evento) => evento.tipo).filter((tipo) => tipo !== 'texto');
    expect(ordem).toEqual(['bot_salvo', 'turno_iniciado', 'aprovacao_pedida', 'aprovacao_resolvida', 'turno_terminado']);
    const linha = a.banco.prepare('SELECT resolvida_por FROM aprovacoes WHERE id = ?').get(pendente!.id) as { resolvida_por: string };
    expect(linha.resolvida_por).toBe(a.aparelho.dispositivo.id);
  });

  it('não roda a ação quando a pessoa nega', async () => {
    const a = await montar();
    await a.enviar('!comando rm -rf tudo');
    await a.esperar(() => a.doTipo('aprovacao_pedida').length === 1);
    const [pendente] = await a.pendentes();
    const decisao = await a.pedir(`/v1/aprovacoes/${pendente!.id}`, { token: a.token, corpo: { decisao: 'negar' } });
    expect(EsquemaAprovacao.parse(await decisao.json()).estado).toBe('negada');
    expect(await a.respostaDoBot()).toMatchObject({ texto: `Comando negado: ${NEGADO_PELA_PESSOA}`, estado: 'completa' });
  });

  it('vale só a primeira decisão, mesmo com dois aparelhos', async () => {
    const a = await montar();
    const outro = await a.parearAparelho('Outro');
    await a.enviar('!comando echo oi');
    await a.esperar(() => a.doTipo('aprovacao_pedida').length === 1);
    const [pendente] = await a.pendentes();

    expect((await a.pedir(`/v1/aprovacoes/${pendente!.id}`, { token: outro.token, corpo: { decisao: 'negar' } })).status).toBe(200);
    const atrasada = await a.pedir(`/v1/aprovacoes/${pendente!.id}`, { token: a.token, corpo: { decisao: 'aprovar' } });
    expect(atrasada.status).toBe(409);
    expect(EsquemaErro.parse(await atrasada.json()).erro).toBe('ja_resolvida');
    expect(await a.respostaDoBot()).toMatchObject({ texto: `Comando negado: ${NEGADO_PELA_PESSOA}` });
    expect(a.doTipo('aprovacao_resolvida')).toHaveLength(1);
  });

  it('recusa decisão fora do contrato, id desconhecido e pedido sem token', async () => {
    const a = await montar();
    await a.enviar('!comando echo oi');
    await a.esperar(() => a.doTipo('aprovacao_pedida').length === 1);
    const [pendente] = await a.pendentes();

    expect((await a.pedir(`/v1/aprovacoes/${pendente!.id}`, { token: a.token, corpo: { decisao: 'allow' } })).status).toBe(400);
    expect((await a.pedir('/v1/aprovacoes/abcdefgh12345678', { token: a.token, corpo: { decisao: 'aprovar' } })).status).toBe(404);
    expect((await a.pedir(`/v1/aprovacoes/${pendente!.id}`, { corpo: { decisao: 'aprovar' } })).status).toBe(401);
    expect((await a.pedir('/v1/aprovacoes')).status).toBe(401);
    expect((await a.pendentes())[0]?.estado).toBe('pendente');
    a.turnos.pararTodos();
    await a.respostaDoBot();
  });

  it('nega sozinho quando ninguém responde a tempo', async () => {
    const a = await montar({ esperaMs: 40 });
    await a.enviar('!comando echo oi');
    await a.esperar(() => a.doTipo('aprovacao_resolvida').length === 1);
    const resolvida = a.doTipo('aprovacao_resolvida')[0];
    expect(resolvida?.tipo === 'aprovacao_resolvida' && resolvida.aprovacao.estado).toBe('expirada');
    expect(await a.respostaDoBot()).toMatchObject({ texto: `Comando negado: ${NEGADO_PELA_PESSOA}` });
    expect(await a.pendentes()).toEqual([]);
  });

  it('o histórico da conversa traz o pedido resolvido, na página da mensagem em que ele surgiu', async () => {
    const a = await montar();
    const historico = async (query = '') =>
      EsquemaListaMensagens.parse(await (await a.pedir(`/v1/bots/${a.botId}/mensagens${query}`, { token: a.token })).json());
    const decidir = async (id: string, decisao: 'aprovar' | 'negar') =>
      EsquemaAprovacao.parse(await (await a.pedir(`/v1/aprovacoes/${id}`, { token: a.token, corpo: { decisao } })).json());
    expect((await historico()).aprovacoes).toEqual([]);

    const primeiro = await a.enviar('!comando echo oi');
    await a.esperar(() => a.doTipo('aprovacao_pedida').length === 1);
    const [pendente] = await a.pendentes();
    // Enquanto espera a pessoa, o pedido sai na lista de pendentes, não no histórico.
    expect((await historico()).aprovacoes).toEqual([]);
    const aprovada = await decidir(pendente!.id, 'aprovar');
    await a.respostaDoBot();

    const segundo = await a.enviar('!comando rm -rf tudo');
    await a.esperar(() => a.doTipo('aprovacao_pedida').length === 2);
    const negada = await decidir((await a.pendentes())[0]!.id, 'negar');
    await a.respostaDoBot();

    const tudo = await historico();
    expect(tudo.aprovacoes).toEqual([aprovada, negada]);
    expect(tudo.aprovacoes?.map((aprovacao) => aprovacao.mensagemId)).toEqual([primeiro.bot.id, segundo.bot.id]);
    // Cada página só traz os pedidos das mensagens que estão nela.
    expect((await historico('?limite=2')).aprovacoes).toEqual([negada]);
    expect((await historico('?antes=3&limite=2')).aprovacoes).toEqual([aprovada]);

    // O pedido de outro bot não aparece na conversa deste.
    const outroBot = EsquemaBot.parse(await (await a.pedir('/v1/bots', { token: a.token, corpo: { nome: 'Outro' } })).json()).id;
    expect(EsquemaListaMensagens.parse(await (await a.pedir(`/v1/bots/${outroBot}/mensagens`, { token: a.token })).json()).aprovacoes).toEqual([]);
  });

  it('o pedido que expirou sozinho também fica no histórico', async () => {
    const a = await montar({ esperaMs: 40 });
    const turno = await a.enviar('!comando echo oi');
    await a.esperar(() => a.doTipo('aprovacao_resolvida').length === 1);
    await a.respostaDoBot();
    const lista = EsquemaListaMensagens.parse(await (await a.pedir(`/v1/bots/${a.botId}/mensagens`, { token: a.token })).json());
    expect(lista.aprovacoes).toMatchObject([{ mensagemId: turno.bot.id, ferramenta: 'Bash', resumo: 'echo oi', estado: 'expirada' }]);
  });

  it('expira o pedido quando o turno é parado antes da resposta', async () => {
    const a = await montar();
    await a.enviar('!comando echo oi');
    await a.esperar(() => a.doTipo('aprovacao_pedida').length === 1);
    const [pendente] = await a.pendentes();

    expect((await a.pedir(`/v1/bots/${a.botId}/turnos/atual/parar`, { token: a.token, metodo: 'POST' })).status).toBe(204);
    expect(await a.respostaDoBot()).toMatchObject({ estado: 'parada' });
    expect(await a.pendentes()).toEqual([]);
    const tarde = await a.pedir(`/v1/aprovacoes/${pendente!.id}`, { token: a.token, corpo: { decisao: 'aprovar' } });
    expect(tarde.status).toBe(409);
  });
});

describe('o que o servidor decide sem a pessoa', () => {
  it('deixa ler dentro da pasta do bot e nega fora dela, sem criar pedido', async () => {
    const a = await montar();
    await a.enviar('!ler notas.txt');
    expect(await a.respostaDoBot()).toMatchObject({ texto: 'Leitura permitida: notas.txt' });
    await a.enviar('!ler ../../segredo.txt');
    expect(await a.respostaDoBot()).toMatchObject({ texto: 'Leitura negada: o bot só lê arquivos da própria pasta de trabalho' });
    expect(a.doTipo('aprovacao_pedida')).toEqual([]);
  });

  it('nega o comando que não cabe inteiro no cartão, sem criar pedido para a pessoa aprovar pela metade', async () => {
    // Com a espera curta, um pedido que fosse criado expiraria sozinho, e o teste veria o cartão.
    const a = await montar({ esperaMs: 50 });
    await a.enviar(`!comando echo ${'x'.repeat(LIMITES.resumoAprovacao)}; rm -rf fim-que-o-cartao-nao-mostraria`);
    expect(await a.respostaDoBot()).toMatchObject({
      texto: 'Comando negado: a ação não cabe inteira no cartão de aprovação; divida-a em partes menores',
      estado: 'completa',
    });
    expect(a.doTipo('aprovacao_pedida')).toEqual([]);
    expect(await a.pendentes()).toEqual([]);
  });
});

describe('o gancho do motor', () => {
  const chamar = (porta: number, token: string, corpo: unknown) =>
    fetch(`http://127.0.0.1:${porta}/gancho`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-awika-turno': token },
      body: JSON.stringify(corpo),
    });

  it('nega pedido com token de turno desconhecido ou sem ferramenta', async () => {
    const a = await montar();
    const semTurno = await chamar(a.portaDoGancho, 'x'.repeat(43), { tool_name: 'Bash', tool_input: { command: 'echo' } });
    expect(semTurno.status).toBe(401);
    expect(await semTurno.json()).toMatchObject({ decisao: 'deny' });

    const token = a.ganchos.registrar({ botId: a.botId, mensagemId: 'abcdefgh12345678', pasta: pastaTemporaria });
    const semFerramenta = await chamar(a.portaDoGancho, token, { tool_input: {} });
    expect(semFerramenta.status).toBe(400);
    expect(await semFerramenta.json()).toMatchObject({ decisao: 'deny' });
    expect(a.doTipo('aprovacao_pedida')).toEqual([]);
  });

  it('deixa de aceitar o token quando o turno acaba', async () => {
    const a = await montar();
    const token = a.ganchos.registrar({ botId: a.botId, mensagemId: 'abcdefgh12345678', pasta: pastaTemporaria });
    expect((await chamar(a.portaDoGancho, token, { tool_name: 'Read', tool_input: { file_path: 'a.txt' } })).status).toBe(200);
    a.ganchos.remover(token);
    expect((await chamar(a.portaDoGancho, token, { tool_name: 'Read', tool_input: { file_path: 'a.txt' } })).status).toBe(401);
  });

  it('não serve para aprovar: o token do turno não é token de aparelho', async () => {
    const a = await montar();
    await a.enviar('!comando echo oi');
    await a.esperar(() => a.doTipo('aprovacao_pedida').length === 1);
    const [pendente] = await a.pendentes();
    const tokenDoTurno = a.ganchos.registrar({ botId: a.botId, mensagemId: pendente!.mensagemId, pasta: pastaTemporaria });

    const tentativa = await a.pedir(`/v1/aprovacoes/${pendente!.id}`, { token: tokenDoTurno, corpo: { decisao: 'aprovar' } });
    expect(tentativa.status).toBe(401);
    expect((await a.pendentes())[0]?.estado).toBe('pendente');
    a.turnos.pararTodos();
    await a.respostaDoBot();
  });
});

describe('decisores e aprovações', () => {
  const chamar = (porta: number, token: string, corpo: unknown) =>
    fetch(`http://127.0.0.1:${porta}/gancho`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-awika-turno': token },
      body: JSON.stringify(corpo),
    });

  it('o token de um decisor só deixa passar a entrega da resposta, e nada chega a um cartão', async () => {
    const a = await montar();
    const token = a.ganchos.registrarDecisor();
    const ferramentas: [string, Record<string, unknown>][] = [
      ['Bash', { command: 'echo oi' }],
      ['Read', { file_path: 'notas.txt' }],
      ['Write', { file_path: 'notas.txt', content: 'x' }],
      ['WebSearch', { query: 'awikabot' }],
      ['mcp__awika__delegar', { worker: 'redator' }],
    ];
    for (const [ferramenta, entrada] of ferramentas) {
      const resposta = await chamar(a.portaDoGancho, token, { tool_name: ferramenta, tool_input: entrada });
      expect(await resposta.json()).toEqual({ decisao: 'deny', motivo: 'o turno de um decisor não usa ferramentas' });
    }
    const entrega = await chamar(a.portaDoGancho, token, { tool_name: 'StructuredOutput', tool_input: { resposta: true, motivo: 'x' } });
    expect(await entrega.json()).toMatchObject({ decisao: 'allow' });
    expect(a.doTipo('aprovacao_pedida')).toEqual([]);
    expect(a.banco.prepare('SELECT COUNT(*) AS n FROM aprovacoes').get()).toEqual({ n: 0 });
  });

  it('nenhuma decisão vira aprovação: um "sim" do juiz sobre o pedido pendente não o resolve', async () => {
    const a = await montar();
    await a.enviar('!comando echo oi');
    await a.esperar(() => a.doTipo('aprovacao_pedida').length === 1);
    const [pendente] = await a.pendentes();

    // O juiz responde que a ação pode rodar, pelo caminho de verdade: o gancho do decisor e a escada.
    const motor: Motor = (pedido) => ({
      parar: () => {},
      fim: (async () => {
        const passagem = await chamar(pedido.gancho!.porta, pedido.gancho!.token, { tool_name: 'StructuredOutput', tool_input: {} });
        const passou = ((await passagem.json()) as { decisao: string }).decisao === 'allow';
        return { estado: 'completa' as const, texto: '', sessao: null, ...(passou ? { estruturada: { resposta: true, motivo: 'é só um echo' } } : {}) };
      })(),
    });
    const juiz = criarJuiz({ motor, motorId: 'claude-code', modelo: null, esforco: null, pasta: pastaTemporaria, gancho: { ganchos: a.ganchos, comando: 'x', porta: a.portaDoGancho } });
    const resultado = await subirEscada([juiz], { tipo: 'afirmacao', enunciado: 'O comando pode rodar.', contexto: pendente!.resumo });
    expect(resultado).toMatchObject({ quem: 'decisor', decisao: { resposta: true } });

    expect(await a.pendentes()).toEqual([pendente]);
    expect(a.doTipo('aprovacao_resolvida')).toEqual([]);
    expect(a.turnos.ativo(a.botId)).toBe(true);
    a.turnos.pararTodos();
    expect(await a.respostaDoBot()).not.toMatchObject({ texto: 'Comando permitido: echo oi' });
  });
});

describe('partida do servidor', () => {
  it('expira o que ficou pendente do processo anterior', async () => {
    const a = await montar();
    await a.enviar('!comando echo oi');
    await a.esperar(() => a.doTipo('aprovacao_pedida').length === 1);
    expect(expirarPendentesNaPartida(a.banco)).toBe(1);
    const estados = a.banco.prepare('SELECT estado FROM aprovacoes').all() as { estado: string }[];
    expect(estados).toEqual([{ estado: 'expirada' }]);
    a.turnos.pararTodos();
    await a.respostaDoBot();
  });
});
