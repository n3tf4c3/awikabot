import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EsquemaBot,
  EsquemaErro,
  EsquemaEvento,
  EsquemaListaBots,
  EsquemaListaMensagens,
  EsquemaRespostaPareamento,
  EsquemaRespostaTurno,
  EsquemaSaude,
  VERSAO_PROTOCOLO,
  type Evento,
} from '@awikabot/core';
import { criarApp } from './app';
import { abrirBanco } from './banco';
import { criarCodigo, LimitadorDeTentativas, revogar, VALIDADE_CODIGO_MS } from './dispositivos';
import { Barramento } from './eventos';
import { criarMotorSimulado } from './motor-simulado';
import { GestorDeTurnos } from './turnos';

const pastaTemporaria = mkdtempSync(path.join(os.tmpdir(), 'awikabot-teste-'));
afterAll(() => {
  rmSync(pastaTemporaria, { recursive: true, force: true });
});

function montar(opcoes: { atrasoMs?: number; limite?: number } = {}) {
  const banco = abrirBanco(':memory:');
  const barramento = new Barramento();
  const turnos = new GestorDeTurnos({
    banco,
    barramento,
    motor: criarMotorSimulado({ atrasoMs: opcoes.atrasoMs ?? 1 }),
    limite: opcoes.limite ?? 4,
    pastaDosBots: pastaTemporaria,
  });
  const app = criarApp({
    versao: '9.9.9-teste',
    banco,
    barramento,
    turnos,
    limitador: new LimitadorDeTentativas(),
    intervaloPingMs: 40,
  });

  const pedir = (caminho: string, opcoesPedido: { metodo?: string; corpo?: unknown; token?: string | null } = {}) => {
    const cabecalhos: Record<string, string> = {};
    if (opcoesPedido.corpo !== undefined) cabecalhos['content-type'] = 'application/json';
    if (opcoesPedido.token) cabecalhos.authorization = `Bearer ${opcoesPedido.token}`;
    return app.request(caminho, {
      method: opcoesPedido.metodo ?? (opcoesPedido.corpo === undefined ? 'GET' : 'POST'),
      headers: cabecalhos,
      body: opcoesPedido.corpo === undefined ? undefined : JSON.stringify(opcoesPedido.corpo),
    });
  };

  const parearAparelho = async (nome = 'Celular de teste') => {
    const resposta = await pedir('/v1/parear', { corpo: { codigo: criarCodigo(banco), nome } });
    return EsquemaRespostaPareamento.parse(await resposta.json());
  };

  const esperarFimDoTurno = async (botId: string): Promise<void> => {
    for (let i = 0; i < 400 && turnos.ativo(botId); i += 1) await new Promise((ok) => setTimeout(ok, 5));
    expect(turnos.ativo(botId)).toBe(false);
  };

  return { app, banco, barramento, turnos, pedir, parearAparelho, esperarFimDoTurno };
}

let ambiente: ReturnType<typeof montar>;
let token: string;
beforeEach(async () => {
  ambiente = montar();
  token = (await ambiente.parearAparelho()).token;
});

const erroDe = async (resposta: Response): Promise<string> => EsquemaErro.parse(await resposta.json()).erro;

describe('saúde', () => {
  it('responde 200 com o contrato do core e os cabeçalhos de segurança', async () => {
    const resposta = await ambiente.pedir('/healthz');
    expect(resposta.status).toBe(200);
    expect(resposta.headers.get('content-type')).toMatch(/^application\/json/);
    expect(resposta.headers.get('cache-control')).toBe('no-store');
    expect(resposta.headers.get('x-content-type-options')).toBe('nosniff');
    expect(EsquemaSaude.parse(await resposta.json())).toEqual({
      status: 'ok',
      versao: '9.9.9-teste',
      protocolo: VERSAO_PROTOCOLO,
    });
  });

  it.each(['POST', 'PUT', 'DELETE'])('recusa %s com 405', async (metodo) => {
    const resposta = await ambiente.pedir('/healthz', { metodo });
    expect(resposta.status).toBe(405);
    expect(resposta.headers.get('allow')).toBe('GET');
  });

  it.each(['/', '/healthz/x', '/api'])('%s responde 404', async (caminho) => {
    const resposta = await ambiente.pedir(caminho);
    expect(resposta.status).toBe(404);
    expect(await erroDe(resposta)).toBe('nao_encontrado');
  });
});

describe('pareamento (F1)', () => {
  it('troca um código válido por um token que autentica', async () => {
    const pareado = await ambiente.parearAparelho('Meu celular');
    expect(pareado.dispositivo.nome).toBe('Meu celular');
    expect(pareado.servidor.protocolo).toBe(VERSAO_PROTOCOLO);
    expect((await ambiente.pedir('/v1/bots', { token: pareado.token })).status).toBe(200);
  });

  it('aceita o código como a pessoa digitar e só uma vez', async () => {
    const codigo = criarCodigo(ambiente.banco);
    const digitado = codigo.replaceAll('-', ' ').toLowerCase();
    expect((await ambiente.pedir('/v1/parear', { corpo: { codigo: digitado, nome: 'A' } })).status).toBe(200);
    const repetido = await ambiente.pedir('/v1/parear', { corpo: { codigo, nome: 'B' } });
    expect(repetido.status).toBe(401);
    expect(await erroDe(repetido)).toBe('codigo_invalido');
  });

  it('recusa código vencido', async () => {
    const codigo = criarCodigo(ambiente.banco, Date.now() - VALIDADE_CODIGO_MS - 1);
    const resposta = await ambiente.pedir('/v1/parear', { corpo: { codigo, nome: 'A' } });
    expect(resposta.status).toBe(401);
  });

  it('recusa corpo fora do contrato sem gastar tentativa', async () => {
    const resposta = await ambiente.pedir('/v1/parear', { corpo: { codigo: 'curto', nome: 'A' } });
    expect(resposta.status).toBe(400);
    expect(await erroDe(resposta)).toBe('dados_invalidos');
  });

  it('trava depois de cinco códigos errados, mesmo para um código certo', async () => {
    for (let i = 0; i < 5; i += 1) {
      const resposta = await ambiente.pedir('/v1/parear', { corpo: { codigo: 'AAAA-AAAA-AAAA', nome: 'A' } });
      expect(resposta.status).toBe(401);
    }
    const certo = await ambiente.pedir('/v1/parear', { corpo: { codigo: criarCodigo(ambiente.banco), nome: 'A' } });
    expect(certo.status).toBe(429);
    expect(await erroDe(certo)).toBe('muitas_tentativas');
  });

  it('guarda só o hash do token e do código', async () => {
    const codigo = criarCodigo(ambiente.banco);
    const linhas = JSON.stringify([
      ambiente.banco.prepare('SELECT * FROM dispositivos').all(),
      ambiente.banco.prepare('SELECT * FROM codigos_pareamento').all(),
    ]);
    expect(linhas).not.toContain(token);
    expect(linhas).not.toContain(codigo.replaceAll('-', ''));
  });
});

describe('autenticação', () => {
  it.each([
    ['sem cabeçalho', null],
    ['token desconhecido', 'x'.repeat(43)],
    ['token com formato errado', 'curto'],
  ])('recusa %s com 401', async (_caso, candidato) => {
    const resposta = await ambiente.pedir('/v1/bots', { token: candidato });
    expect(resposta.status).toBe(401);
    expect(await erroDe(resposta)).toBe('nao_autenticado');
  });

  it('recusa o token de um aparelho revogado e mantém o dos outros', async () => {
    const outro = await ambiente.parearAparelho('Outro');
    expect(revogar(ambiente.banco, outro.dispositivo.id)).toBe(true);
    expect((await ambiente.pedir('/v1/bots', { token: outro.token })).status).toBe(401);
    expect((await ambiente.pedir('/v1/bots', { token })).status).toBe(200);
  });

  it('deixa o aparelho se desparear, invalidando só o próprio token', async () => {
    const outro = await ambiente.parearAparelho('Outro');
    expect((await ambiente.pedir('/v1/dispositivo', { token: outro.token, metodo: 'DELETE' })).status).toBe(204);
    expect((await ambiente.pedir('/v1/bots', { token: outro.token })).status).toBe(401);
    expect((await ambiente.pedir('/v1/dispositivo', { token: outro.token, metodo: 'DELETE' })).status).toBe(401);
    expect((await ambiente.pedir('/v1/bots', { token })).status).toBe(200);
  });

  it('exige token em todas as rotas de /v1, menos o pareamento', async () => {
    const rotas: [string, string][] = [
      ['DELETE', '/v1/dispositivo'],
      ['GET', '/v1/bots'],
      ['POST', '/v1/bots'],
      ['PATCH', '/v1/bots/abcdefgh12345678'],
      ['GET', '/v1/bots/abcdefgh12345678/mensagens'],
      ['POST', '/v1/bots/abcdefgh12345678/turnos'],
      ['POST', '/v1/bots/abcdefgh12345678/turnos/atual/parar'],
      ['GET', '/v1/eventos'],
      ['GET', '/v1/rota-que-nao-existe'],
    ];
    for (const [metodo, caminho] of rotas) {
      const resposta = await ambiente.pedir(caminho, { metodo });
      expect(`${metodo} ${caminho} ${resposta.status}`).toBe(`${metodo} ${caminho} 401`);
    }
  });
});

describe('bots (F2)', () => {
  it('cria, lista e edita um bot', async () => {
    const criado = await ambiente.pedir('/v1/bots', { token, corpo: { nome: ' Scout ', instrucoes: 'Seja breve.' } });
    expect(criado.status).toBe(201);
    const bot = EsquemaBot.parse(await criado.json());
    expect(bot).toMatchObject({ nome: 'Scout', instrucoes: 'Seja breve.', modelo: null, turnoAtivo: false });

    const editado = await ambiente.pedir(`/v1/bots/${bot.id}`, { token, metodo: 'PATCH', corpo: { modelo: 'sonnet' } });
    expect(EsquemaBot.parse(await editado.json())).toMatchObject({ nome: 'Scout', instrucoes: 'Seja breve.', modelo: 'sonnet' });

    const lista = EsquemaListaBots.parse(await (await ambiente.pedir('/v1/bots', { token })).json());
    expect(lista.bots.map((item) => [item.nome, item.modelo])).toEqual([['Scout', 'sonnet']]);
  });

  it('não expõe a sessão do motor', async () => {
    const criado = await ambiente.pedir('/v1/bots', { token, corpo: { nome: 'Scout' } });
    expect(Object.keys((await criado.json()) as object).sort()).toEqual(
      ['atualizadoEm', 'criadoEm', 'id', 'instrucoes', 'modelo', 'nome', 'turnoAtivo'].sort(),
    );
  });

  it.each([
    ['nome vazio', { nome: '  ' }],
    ['modelo que parece opção de linha de comando', { nome: 'Scout', modelo: '--dangerously-skip-permissions' }],
    ['campo com tipo errado', { nome: 42 }],
  ])('recusa criação com %s', async (_caso, corpo) => {
    const resposta = await ambiente.pedir('/v1/bots', { token, corpo });
    expect(resposta.status).toBe(400);
    expect(await erroDe(resposta)).toBe('dados_invalidos');
  });

  it('responde 400 a JSON quebrado e 404 a bot inexistente', async () => {
    const quebrado = await ambiente.app.request('/v1/bots', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{nome:',
    });
    expect(quebrado.status).toBe(400);
    expect(await erroDe(quebrado)).toBe('json_invalido');

    const inexistente = await ambiente.pedir('/v1/bots/abcdefgh12345678', { token, metodo: 'PATCH', corpo: { nome: 'X' } });
    expect(inexistente.status).toBe(404);
  });
});

describe('conversa (F3)', () => {
  const criarBot = async (): Promise<string> => {
    const criado = await ambiente.pedir('/v1/bots', { token, corpo: { nome: 'Scout' } });
    return EsquemaBot.parse(await criado.json()).id;
  };

  it('roda um turno e guarda a pergunta e a resposta completas', async () => {
    const botId = await criarBot();
    const eventos: Evento[] = [];
    ambiente.barramento.assinar(undefined, (item) => eventos.push(item.evento));

    const resposta = await ambiente.pedir(`/v1/bots/${botId}/turnos`, { token, corpo: { texto: '  olá mundo  ' } });
    expect(resposta.status).toBe(201);
    const turno = EsquemaRespostaTurno.parse(await resposta.json());
    expect(turno.usuario).toMatchObject({ papel: 'usuario', texto: 'olá mundo', estado: 'completa', seq: 1 });
    expect(turno.bot).toMatchObject({ papel: 'bot', texto: '', estado: 'em_andamento', seq: 2 });

    await ambiente.esperarFimDoTurno(botId);
    const lista = EsquemaListaMensagens.parse(await (await ambiente.pedir(`/v1/bots/${botId}/mensagens`, { token })).json());
    expect(lista.mensagens.map((m) => [m.papel, m.texto, m.estado])).toEqual([
      ['usuario', 'olá mundo', 'completa'],
      ['bot', 'Você disse: olá mundo', 'completa'],
    ]);
    expect(lista.temMais).toBe(false);

    expect(eventos.map((evento) => evento.tipo)).toEqual([
      'turno_iniciado',
      ...Array<string>(4).fill('texto'),
      'turno_terminado',
    ]);
    const trechos = eventos.flatMap((evento) => (evento.tipo === 'texto' ? [evento.trecho] : []));
    expect(trechos.join('')).toBe('Você disse: olá mundo');
    for (const evento of eventos) EsquemaEvento.parse(evento);
  });

  it('recusa um segundo turno no mesmo bot enquanto o primeiro roda', async () => {
    ambiente = montar({ atrasoMs: 30 });
    token = (await ambiente.parearAparelho()).token;
    const botId = await criarBot();
    expect((await ambiente.pedir(`/v1/bots/${botId}/turnos`, { token, corpo: { texto: 'um dois tres' } })).status).toBe(201);
    const segundo = await ambiente.pedir(`/v1/bots/${botId}/turnos`, { token, corpo: { texto: 'outro' } });
    expect(segundo.status).toBe(409);
    expect(await erroDe(segundo)).toBe('turno_em_andamento');
    const lista = EsquemaListaBots.parse(await (await ambiente.pedir('/v1/bots', { token })).json());
    expect(lista.bots[0]?.turnoAtivo).toBe(true);
    await ambiente.esperarFimDoTurno(botId);
  });

  it('respeita o teto de turnos simultâneos do servidor', async () => {
    ambiente = montar({ atrasoMs: 30, limite: 1 });
    token = (await ambiente.parearAparelho()).token;
    const primeiro = await criarBot();
    const segundo = await criarBot();
    expect((await ambiente.pedir(`/v1/bots/${primeiro}/turnos`, { token, corpo: { texto: 'um dois' } })).status).toBe(201);
    const recusado = await ambiente.pedir(`/v1/bots/${segundo}/turnos`, { token, corpo: { texto: 'oi' } });
    expect(recusado.status).toBe(429);
    expect(await erroDe(recusado)).toBe('limite_de_turnos');
    await ambiente.esperarFimDoTurno(primeiro);
  });

  it('para um turno e guarda o que já tinha chegado', async () => {
    ambiente = montar({ atrasoMs: 25 });
    token = (await ambiente.parearAparelho()).token;
    const botId = await criarBot();
    await ambiente.pedir(`/v1/bots/${botId}/turnos`, { token, corpo: { texto: 'a b c d e f g h i j' } });
    await new Promise((ok) => setTimeout(ok, 70));

    expect((await ambiente.pedir(`/v1/bots/${botId}/turnos/atual/parar`, { token, metodo: 'POST' })).status).toBe(204);
    await ambiente.esperarFimDoTurno(botId);

    const lista = EsquemaListaMensagens.parse(await (await ambiente.pedir(`/v1/bots/${botId}/mensagens`, { token })).json());
    const resposta = lista.mensagens[1];
    expect(resposta?.estado).toBe('parada');
    expect(resposta?.texto.startsWith('Você ')).toBe(true);
    expect(resposta?.texto).not.toBe('Você disse: a b c d e f g h i j');

    const semTurno = await ambiente.pedir(`/v1/bots/${botId}/turnos/atual/parar`, { token, metodo: 'POST' });
    expect(semTurno.status).toBe(409);
    expect(await erroDe(semTurno)).toBe('sem_turno_ativo');
  });

  it('mostra o que já chegou de uma resposta em andamento, com a posição de cada trecho', async () => {
    ambiente = montar({ atrasoMs: 25 });
    token = (await ambiente.parearAparelho()).token;
    const botId = await criarBot();
    const eventos: Evento[] = [];
    ambiente.barramento.assinar(undefined, (item) => eventos.push(item.evento));
    await ambiente.pedir(`/v1/bots/${botId}/turnos`, { token, corpo: { texto: 'a b c d e f' } });
    await new Promise((ok) => setTimeout(ok, 90));

    const durante = EsquemaListaMensagens.parse(await (await ambiente.pedir(`/v1/bots/${botId}/mensagens`, { token })).json());
    const emAndamento = durante.mensagens[1];
    expect(emAndamento?.estado).toBe('em_andamento');
    const recebidoAteAqui = eventos.flatMap((evento) => (evento.tipo === 'texto' ? [evento.trecho] : [])).join('');
    expect(emAndamento?.texto).toBe(recebidoAteAqui);
    expect(recebidoAteAqui.length).toBeGreaterThan(0);

    await ambiente.esperarFimDoTurno(botId);
    let tamanho = 0;
    for (const evento of eventos) {
      if (evento.tipo !== 'texto') continue;
      expect(evento.posicao).toBe(tamanho);
      tamanho += evento.trecho.length;
    }
    expect(tamanho).toBe('Você disse: a b c d e f'.length);
    expect(ambiente.turnos.textoParcial(emAndamento?.id ?? '')).toBeUndefined();
  });

  it('pagina as mensagens da mais nova para a mais antiga', async () => {
    const botId = await criarBot();
    for (const texto of ['um', 'dois', 'tres']) {
      await ambiente.pedir(`/v1/bots/${botId}/turnos`, { token, corpo: { texto } });
      await ambiente.esperarFimDoTurno(botId);
    }
    const pagina = async (query: string) =>
      EsquemaListaMensagens.parse(await (await ambiente.pedir(`/v1/bots/${botId}/mensagens${query}`, { token })).json());

    const recente = await pagina('?limite=2');
    expect(recente.mensagens.map((m) => m.seq)).toEqual([5, 6]);
    expect(recente.temMais).toBe(true);
    const anterior = await pagina('?limite=4&antes=5');
    expect(anterior.mensagens.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    expect(anterior.temMais).toBe(false);

    for (const query of ['?limite=0', '?limite=51', '?antes=abc', '?antes=-1']) {
      expect((await ambiente.pedir(`/v1/bots/${botId}/mensagens${query}`, { token })).status).toBe(400);
    }
  });

  it('recusa texto vazio e bot inexistente', async () => {
    const botId = await criarBot();
    expect((await ambiente.pedir(`/v1/bots/${botId}/turnos`, { token, corpo: { texto: '   ' } })).status).toBe(400);
    expect((await ambiente.pedir('/v1/bots/abcdefgh12345678/turnos', { token, corpo: { texto: 'oi' } })).status).toBe(404);
    expect((await ambiente.pedir('/v1/bots/abcdefgh12345678/mensagens', { token })).status).toBe(404);
  });
});

describe('fluxo de eventos pela rede', () => {
  it('entrega os eventos de um turno e fecha quando o aparelho é revogado', async () => {
    const pareado = await ambiente.parearAparelho('Aparelho do fluxo');
    const servidor = serve({ fetch: ambiente.app.fetch, hostname: '127.0.0.1', port: 0 }) as Server;
    await new Promise<void>((pronto) => servidor.once('listening', () => pronto()));
    const base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;

    try {
      const fluxo = await fetch(`${base}/v1/eventos`, { headers: { authorization: `Bearer ${pareado.token}` } });
      expect(fluxo.status).toBe(200);
      expect(fluxo.headers.get('content-type')).toMatch(/^text\/event-stream/);
      const leitor = fluxo.body!.getReader();
      const decodificador = new TextDecoder();
      let recebido = '';
      const lerAte = async (marca: string): Promise<void> => {
        while (!recebido.includes(marca)) {
          const { done, value } = await leitor.read();
          if (done) throw new Error(`fluxo fechou antes de "${marca}"`);
          recebido += decodificador.decode(value, { stream: true });
        }
      };
      await lerAte('event: ping');
      // Sem Last-Event-ID, o primeiro sinal de vida traz o ponto de retomada.
      await lerAte(`id: ${ambiente.barramento.epoca}-0`);

      const criado = await fetch(`${base}/v1/bots`, {
        method: 'POST',
        headers: { authorization: `Bearer ${pareado.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ nome: 'Scout' }),
      });
      const botId = EsquemaBot.parse(await criado.json()).id;
      await fetch(`${base}/v1/bots/${botId}/turnos`, {
        method: 'POST',
        headers: { authorization: `Bearer ${pareado.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ texto: 'oi' }),
      });
      await lerAte('"turno_terminado"');

      const eventos = recebido
        .split('\n')
        .filter((linha) => linha.startsWith('data: {'))
        .map((linha) => EsquemaEvento.parse(JSON.parse(linha.slice(6))));
      expect(eventos.map((evento) => evento.tipo)).toEqual(['bot_salvo', 'turno_iniciado', 'texto', 'texto', 'texto', 'turno_terminado']);
      expect(recebido).toMatch(new RegExp(`id: ${ambiente.barramento.epoca}-\\d+`));

      // Revogado, o aparelho perde o fluxo no sinal de vida seguinte.
      revogar(ambiente.banco, pareado.dispositivo.id);
      let fechou = false;
      for (let i = 0; i < 50 && !fechou; i += 1) fechou = (await leitor.read()).done;
      expect(fechou).toBe(true);
    } finally {
      servidor.closeAllConnections();
      await new Promise<void>((fim) => servidor.close(() => fim()));
    }
  });
});
