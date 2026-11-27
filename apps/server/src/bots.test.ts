// O bot de antes do motor por bot: o banco de uma versão anterior, aberto por esta, e o catálogo.
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { EsquemaBot, EsquemaCatalogo, MOTOR_PADRAO } from '@awikabot/core';
import { abrirBanco, VERSAO_DO_ESQUEMA } from './banco';
import { criarBot, editarBot, listarBots, obterBot, paraContrato } from './bots';
import { CATALOGO, esforcoValido, MOTOR_ANTIGRAVITY, MOTOR_CODEX, motorDoCatalogo, motorParaCriarBot } from './catalogo';
import { Barramento } from './eventos';
import type { Motor, PedidoMotor } from './motor';
import { GestorDeTurnos } from './turnos';

const pasta = mkdtempSync(path.join(os.tmpdir(), 'awikabot-bots-'));
afterAll(() => {
  rmSync(pasta, { recursive: true, force: true });
});

/** As duas migrações publicadas antes do motor por bot. */
const VERSAO_SEM_MOTOR = 2;

describe('bot criado antes do motor por bot', () => {
  it('continua igual depois da migração, no motor padrão e com o esforço padrão', async () => {
    const arquivo = path.join(pasta, 'antigo.db');
    const antigo = abrirBanco(arquivo, VERSAO_SEM_MOTOR);
    // Como a versão anterior gravava: sem as colunas novas.
    antigo
      .prepare('INSERT INTO bots (id, nome, instrucoes, modelo, sessao_motor, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('abcdefgh12345678', 'Antigo', 'Seja breve.', 'sonnet', 'sessao-antiga', 10, 20);
    antigo.close();

    const banco = abrirBanco(arquivo);
    expect((banco.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(VERSAO_DO_ESQUEMA);
    const bot = obterBot(banco, 'abcdefgh12345678');
    expect(bot).toEqual({
      id: 'abcdefgh12345678',
      nome: 'Antigo',
      instrucoes: 'Seja breve.',
      modelo: 'sonnet',
      motor: MOTOR_PADRAO,
      esforco: null,
      sessaoMotor: 'sessao-antiga',
      criadoEm: 10,
      atualizadoEm: 20,
    });
    expect(EsquemaBot.parse(paraContrato(bot!, false))).toEqual({
      id: 'abcdefgh12345678',
      nome: 'Antigo',
      instrucoes: 'Seja breve.',
      modelo: 'sonnet',
      motor: MOTOR_PADRAO,
      esforco: null,
      criadoEm: 10,
      atualizadoEm: 20,
      turnoAtivo: false,
    });

    // O turno dele leva ao motor o que levava antes: o mesmo modelo, a mesma sessão, nenhum esforço.
    const pedidos: PedidoMotor[] = [];
    const motor: Motor = (pedido) => {
      pedidos.push(pedido);
      return { parar: () => {}, fim: Promise.resolve({ estado: 'completa', texto: 'ok', sessao: pedido.sessao }) };
    };
    const turnos = new GestorDeTurnos({ banco, barramento: new Barramento(), motor, limite: 1, pastaDosBots: pasta });
    expect(turnos.iniciar(bot!, 'oi').ok).toBe(true);
    expect(pedidos[0]).toMatchObject({ modelo: 'sonnet', esforco: null, sessao: 'sessao-antiga', instrucoes: 'Seja breve.' });
    while (turnos.ativo(bot!.id)) await new Promise((ok) => setTimeout(ok, 5));
    banco.close();
  });
});

describe('motor e esforço gravados', () => {
  it('o motor fica o da criação e a edição muda só o esforço', () => {
    const banco = abrirBanco(':memory:');
    const bot = criarBot(banco, { nome: 'Scout', instrucoes: '', modelo: null, motor: 'claude-code', esforco: 'high' });
    expect(obterBot(banco, bot.id)).toMatchObject({ motor: 'claude-code', esforco: 'high' });
    expect(editarBot(banco, bot.id, { esforco: null })).toMatchObject({ motor: 'claude-code', esforco: null });
    expect(editarBot(banco, bot.id, { nome: 'Outro' })).toMatchObject({ esforco: null });
    expect(listarBots(banco).map((item) => item.motor)).toEqual(['claude-code']);
    banco.close();
  });

  it('sem motor nem esforço na entrada, grava os padrões', () => {
    const banco = abrirBanco(':memory:');
    expect(criarBot(banco, { nome: 'Scout', instrucoes: '', modelo: null })).toMatchObject({ motor: MOTOR_PADRAO, esforco: null });
    banco.close();
  });
});

describe('catálogo', () => {
  it('passa no esquema do contrato, com o Claude Code e o Codex prontos e o Antigravity ainda não', () => {
    expect(EsquemaCatalogo.parse(CATALOGO)).toEqual(CATALOGO);
    expect(motorParaCriarBot(MOTOR_PADRAO)?.nome).toBe('Claude Code');
    expect(CATALOGO.motores.map((motor) => [motor.id, motor.pronto])).toEqual([
      [MOTOR_PADRAO, true],
      [MOTOR_CODEX, true],
      [MOTOR_ANTIGRAVITY, false],
    ]);
    // Não pronto, o Antigravity só aceita bot num servidor que o põe em prova.
    expect(motorParaCriarBot(MOTOR_ANTIGRAVITY)).toBeNull();
    expect(motorParaCriarBot(MOTOR_ANTIGRAVITY, CATALOGO, [MOTOR_ANTIGRAVITY])?.nome).toBe('Antigravity');
  });

  it('cria bot num motor não pronto só no servidor que o põe em prova', () => {
    const catalogo = { motores: CATALOGO.motores.map((motor) => (motor.id === MOTOR_CODEX ? { ...motor, pronto: false } : motor)) };
    expect(motorParaCriarBot(MOTOR_CODEX)?.nome).toBe('Codex');
    expect(motorParaCriarBot(MOTOR_CODEX, catalogo)).toBeNull();
    expect(motorParaCriarBot(MOTOR_CODEX, catalogo, [MOTOR_CODEX])?.nome).toBe('Codex');
    expect(motorParaCriarBot('desconhecido', CATALOGO, ['desconhecido'])).toBeNull();
  });

  it('não deixa criar bot em motor desconhecido, não pronto ou que não é agente', () => {
    const base = motorDoCatalogo(MOTOR_PADRAO)!;
    const catalogo = {
      motores: [
        { ...base, id: 'em-prova', pronto: false },
        { ...base, id: 'juiz', familia: 'decisor' as const },
      ],
    };
    expect(motorParaCriarBot('desconhecido')).toBeNull();
    expect(motorParaCriarBot('em-prova', catalogo)).toBeNull();
    expect(motorParaCriarBot('juiz', catalogo)).toBeNull();
  });

  it('o esforço vale se for o padrão ou se o motor o lista', () => {
    const motor = motorDoCatalogo(MOTOR_PADRAO)!;
    expect(motor.esforcos.map((esforco) => esforco.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(esforcoValido(motor, null)).toBe(true);
    expect(esforcoValido(motor, 'max')).toBe(true);
    expect(esforcoValido(motor, 'turbo')).toBe(false);
    expect(esforcoValido({ ...motor, esforcos: [] }, 'high')).toBe(false);
  });
});
