import { describe, expect, it } from 'vitest';
import { EsquemaBotEdicao, LIMITES, type Bot } from '@awikabot/core';
import { CAMPOS_BOT_VAZIOS, camposDoBot, edicaoDoBot, validarBot } from './formulario-bot';

const bot: Bot = {
  id: 'bot0000000000001',
  nome: 'Ajudante',
  instrucoes: 'Responda curto.',
  modelo: 'modelo-x',
  criadoEm: 1,
  atualizadoEm: 2,
  turnoAtivo: false,
};

function erros(campos: Partial<typeof CAMPOS_BOT_VAZIOS>): string[] {
  const lido = validarBot({ ...CAMPOS_BOT_VAZIOS, nome: 'Ajudante', ...campos });
  return lido.ok ? [] : Object.keys(lido.erros);
}

describe('validarBot', () => {
  it('aceita só o nome e manda modelo nulo e instruções vazias', () => {
    expect(validarBot({ nome: 'Ajudante', instrucoes: '', modelo: '' })).toEqual({
      ok: true,
      entrada: { nome: 'Ajudante', instrucoes: '', modelo: null },
    });
  });

  it('tira espaços das pontas do nome e do modelo, e preserva as instruções', () => {
    expect(validarBot({ nome: '  Ajudante ', instrucoes: '  linha 1\n', modelo: ' modelo-x ' })).toEqual({
      ok: true,
      entrada: { nome: 'Ajudante', instrucoes: '  linha 1\n', modelo: 'modelo-x' },
    });
  });

  it('trata modelo só com espaços como vazio', () => {
    expect(validarBot({ nome: 'Ajudante', instrucoes: '', modelo: '   ' })).toMatchObject({ entrada: { modelo: null } });
  });

  it('exige nome', () => {
    expect(erros({ nome: '' })).toEqual(['nome']);
    expect(erros({ nome: '   ' })).toEqual(['nome']);
  });

  it('respeita os limites do contrato em cada campo', () => {
    expect(erros({ nome: 'n'.repeat(LIMITES.nomeBot) })).toEqual([]);
    expect(erros({ nome: 'n'.repeat(LIMITES.nomeBot + 1) })).toEqual(['nome']);
    expect(erros({ instrucoes: 'i'.repeat(LIMITES.instrucoes) })).toEqual([]);
    expect(erros({ instrucoes: 'i'.repeat(LIMITES.instrucoes + 1) })).toEqual(['instrucoes']);
    expect(erros({ modelo: 'm'.repeat(LIMITES.modelo) })).toEqual([]);
    expect(erros({ modelo: 'm'.repeat(LIMITES.modelo + 1) })).toEqual(['modelo']);
  });

  it.each(['--flag', 'modelo x', 'modelo/x', '-x', 'modelo;rm'])('recusa o modelo %s', (modelo) => {
    expect(erros({ modelo })).toEqual(['modelo']);
  });

  it.each(['modelo-x', 'familia.modelo:4.5', 'modelo[1m]', 'm_1'])('aceita o modelo %s', (modelo) => {
    expect(erros({ modelo })).toEqual([]);
  });

  it('aponta todos os campos com problema, com frase em português', () => {
    const lido = validarBot({ nome: '', instrucoes: 'i'.repeat(LIMITES.instrucoes + 1), modelo: '--x' });
    expect(lido.ok).toBe(false);
    if (lido.ok) return;
    expect(Object.keys(lido.erros).sort()).toEqual(['instrucoes', 'modelo', 'nome']);
    expect(lido.erros.nome).toBe('Informe um nome com até 60 caracteres.');
    expect(lido.erros.instrucoes).toBe('As instruções têm no máximo 8000 caracteres.');
    expect(lido.erros.modelo).toMatch(/^Use até 80 caracteres/);
  });
});

describe('camposDoBot', () => {
  it('preenche o formulário com o bot', () => {
    expect(camposDoBot(bot)).toEqual({ nome: 'Ajudante', instrucoes: 'Responda curto.', modelo: 'modelo-x' });
  });

  it('mostra modelo nulo como campo vazio', () => {
    expect(camposDoBot({ ...bot, modelo: null }).modelo).toBe('');
  });
});

describe('edicaoDoBot', () => {
  const igual = { nome: bot.nome, instrucoes: bot.instrucoes, modelo: bot.modelo };

  it('devolve null quando nada mudou', () => {
    expect(edicaoDoBot(bot, igual)).toBeNull();
  });

  it('manda só o que mudou', () => {
    expect(edicaoDoBot(bot, { ...igual, nome: 'Outro' })).toEqual({ nome: 'Outro' });
    expect(edicaoDoBot(bot, { ...igual, instrucoes: '' })).toEqual({ instrucoes: '' });
    expect(edicaoDoBot(bot, { nome: 'Outro', instrucoes: 'x', modelo: 'y' })).toEqual({
      nome: 'Outro',
      instrucoes: 'x',
      modelo: 'y',
    });
  });

  it('manda modelo nulo para tirar o modelo', () => {
    expect(edicaoDoBot(bot, { ...igual, modelo: null })).toEqual({ modelo: null });
  });

  it('o que sai sempre passa no esquema de edição do contrato', () => {
    const edicao = edicaoDoBot(bot, { ...igual, modelo: null });
    expect(EsquemaBotEdicao.safeParse(edicao).success).toBe(true);
  });

  it('formulário aberto e salvo sem mexer não gera edição', () => {
    const lido = validarBot(camposDoBot(bot));
    expect(lido.ok && edicaoDoBot(bot, lido.entrada)).toBeNull();
  });
});
