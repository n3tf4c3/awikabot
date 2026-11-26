import { MOTOR_PADRAO, type Bot, type BotEdicao, type BotEntrada } from '@awikabot/core';
import type { Banco } from './banco';
import { novoId } from './ids';

interface LinhaBot {
  id: string;
  nome: string;
  instrucoes: string;
  modelo: string | null;
  motor: string;
  esforco: string | null;
  sessao_motor: string | null;
  criado_em: number;
  atualizado_em: number;
}

/** O bot como o servidor o guarda. `sessaoMotor` nunca sai pela API. */
export interface BotInterno {
  id: string;
  nome: string;
  instrucoes: string;
  modelo: string | null;
  /** Escolhido na criação e nunca mais mudado: a sessão que guarda a conversa é desse motor. */
  motor: string;
  esforco: string | null;
  sessaoMotor: string | null;
  criadoEm: number;
  atualizadoEm: number;
}

const COLUNAS = 'id, nome, instrucoes, modelo, motor, esforco, sessao_motor, criado_em, atualizado_em';

function deLinha(linha: LinhaBot): BotInterno {
  return {
    id: linha.id,
    nome: linha.nome,
    instrucoes: linha.instrucoes,
    modelo: linha.modelo,
    motor: linha.motor,
    esforco: linha.esforco,
    sessaoMotor: linha.sessao_motor,
    criadoEm: linha.criado_em,
    atualizadoEm: linha.atualizado_em,
  };
}

export function paraContrato(bot: BotInterno, turnoAtivo: boolean): Bot {
  return {
    id: bot.id,
    nome: bot.nome,
    instrucoes: bot.instrucoes,
    modelo: bot.modelo,
    motor: bot.motor,
    esforco: bot.esforco,
    criadoEm: bot.criadoEm,
    atualizadoEm: bot.atualizadoEm,
    turnoAtivo,
  };
}

export function listarBots(banco: Banco): BotInterno[] {
  const linhas = banco.prepare(`SELECT ${COLUNAS} FROM bots ORDER BY criado_em, id`).all() as unknown as LinhaBot[];
  return linhas.map(deLinha);
}

export function obterBot(banco: Banco, id: string): BotInterno | null {
  const linha = banco.prepare(`SELECT ${COLUNAS} FROM bots WHERE id = ?`).get(id) as unknown as LinhaBot | undefined;
  return linha ? deLinha(linha) : null;
}

/** Sem motor nem esforço, como o esquema: o motor padrão e o esforço padrão. */
export type NovoBot = Omit<BotEntrada, 'motor' | 'esforco'> & Partial<Pick<BotEntrada, 'motor' | 'esforco'>>;

/** Quem chama confere antes que o motor e o esforço estão no catálogo. */
export function criarBot(banco: Banco, entrada: NovoBot, agora = Date.now()): BotInterno {
  const bot: BotInterno = {
    id: novoId(),
    nome: entrada.nome,
    instrucoes: entrada.instrucoes,
    modelo: entrada.modelo,
    motor: entrada.motor ?? MOTOR_PADRAO,
    esforco: entrada.esforco ?? null,
    sessaoMotor: null,
    criadoEm: agora,
    atualizadoEm: agora,
  };
  banco
    .prepare(
      'INSERT INTO bots (id, nome, instrucoes, modelo, motor, esforco, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(bot.id, bot.nome, bot.instrucoes, bot.modelo, bot.motor, bot.esforco, agora, agora);
  return bot;
}

/** O motor não está aqui: a edição nunca o muda. Quem chama confere o esforço contra o motor do bot. */
export function editarBot(banco: Banco, id: string, edicao: BotEdicao, agora = Date.now()): BotInterno | null {
  const atual = obterBot(banco, id);
  if (!atual) return null;
  banco
    .prepare('UPDATE bots SET nome = ?, instrucoes = ?, modelo = ?, esforco = ?, atualizado_em = ? WHERE id = ?')
    .run(
      edicao.nome ?? atual.nome,
      edicao.instrucoes ?? atual.instrucoes,
      edicao.modelo === undefined ? atual.modelo : edicao.modelo,
      edicao.esforco === undefined ? atual.esforco : edicao.esforco,
      agora,
      id,
    );
  return obterBot(banco, id);
}

export function gravarSessaoMotor(banco: Banco, id: string, sessao: string | null): void {
  banco.prepare('UPDATE bots SET sessao_motor = ? WHERE id = ?').run(sessao, id);
}
