import type { Bot, BotEdicao, BotEntrada } from '@awikabot/core';
import type { Banco } from './banco';
import { novoId } from './ids';

interface LinhaBot {
  id: string;
  nome: string;
  instrucoes: string;
  modelo: string | null;
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
  sessaoMotor: string | null;
  criadoEm: number;
  atualizadoEm: number;
}

const COLUNAS = 'id, nome, instrucoes, modelo, sessao_motor, criado_em, atualizado_em';

function deLinha(linha: LinhaBot): BotInterno {
  return {
    id: linha.id,
    nome: linha.nome,
    instrucoes: linha.instrucoes,
    modelo: linha.modelo,
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

export function criarBot(banco: Banco, entrada: BotEntrada, agora = Date.now()): BotInterno {
  const bot: BotInterno = {
    id: novoId(),
    nome: entrada.nome,
    instrucoes: entrada.instrucoes,
    modelo: entrada.modelo,
    sessaoMotor: null,
    criadoEm: agora,
    atualizadoEm: agora,
  };
  banco
    .prepare('INSERT INTO bots (id, nome, instrucoes, modelo, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?)')
    .run(bot.id, bot.nome, bot.instrucoes, bot.modelo, agora, agora);
  return bot;
}

export function editarBot(banco: Banco, id: string, edicao: BotEdicao, agora = Date.now()): BotInterno | null {
  const atual = obterBot(banco, id);
  if (!atual) return null;
  banco
    .prepare('UPDATE bots SET nome = ?, instrucoes = ?, modelo = ?, atualizado_em = ? WHERE id = ?')
    .run(
      edicao.nome ?? atual.nome,
      edicao.instrucoes ?? atual.instrucoes,
      edicao.modelo === undefined ? atual.modelo : edicao.modelo,
      agora,
      id,
    );
  return obterBot(banco, id);
}

export function gravarSessaoMotor(banco: Banco, id: string, sessao: string | null): void {
  banco.prepare('UPDATE bots SET sessao_motor = ? WHERE id = ?').run(sessao, id);
}
