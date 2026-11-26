import { describe, expect, it } from 'vitest';
import { EsquemaBotEdicao, EsquemaBotEntrada, LIMITES, MOTOR_PADRAO, type Bot, type BotEntrada } from '@awikabot/core';
import tabela from '../../../../packages/core/casos/bot-entrada.json';
import { CAMPOS_BOT_VAZIOS, camposDoBot, edicaoDoBot, validarBot, type CamposBot } from './formulario-bot';

const bot: Bot = {
  id: 'bot0000000000001',
  nome: 'Ajudante',
  instrucoes: 'Responda curto.',
  modelo: 'modelo-x',
  motor: 'claude-code',
  esforco: 'high',
  criadoEm: 1,
  atualizadoEm: 2,
  turnoAtivo: false,
};

/** Os campos como o formulário abre para criar, com o que o caso muda. */
const campos = (mudancas: Partial<CamposBot>): CamposBot => ({ ...CAMPOS_BOT_VAZIOS, ...mudancas });

function erros(mudancas: Partial<CamposBot>): string[] {
  const lido = validarBot(campos({ nome: 'Ajudante', ...mudancas }));
  return lido.ok ? [] : Object.keys(lido.erros);
}

describe('validarBot', () => {
  it('aceita só o nome e manda modelo nulo, instruções vazias, o motor padrão e o esforço padrão', () => {
    expect(validarBot(campos({ nome: 'Ajudante' }))).toEqual({
      ok: true,
      entrada: { nome: 'Ajudante', instrucoes: '', modelo: null, motor: MOTOR_PADRAO, esforco: null },
    });
  });

  it('tira espaços das pontas do nome e do modelo, e preserva as instruções', () => {
    expect(validarBot(campos({ nome: '  Ajudante ', instrucoes: '  linha 1\n', modelo: ' modelo-x ' }))).toMatchObject({
      ok: true,
      entrada: { nome: 'Ajudante', instrucoes: '  linha 1\n', modelo: 'modelo-x' },
    });
  });

  it('trata modelo só com espaços como vazio', () => {
    expect(validarBot(campos({ nome: 'Ajudante', modelo: '   ' }))).toMatchObject({ entrada: { modelo: null } });
  });

  it('leva o motor e o esforço escolhidos nas listas', () => {
    expect(validarBot(campos({ nome: 'Ajudante', motor: 'claude-code', esforco: 'max' }))).toMatchObject({
      entrada: { motor: 'claude-code', esforco: 'max' },
    });
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
    const lido = validarBot({ nome: '', instrucoes: 'i'.repeat(LIMITES.instrucoes + 1), modelo: '--x', motor: '', esforco: '--e' });
    expect(lido.ok).toBe(false);
    if (lido.ok) return;
    expect(Object.keys(lido.erros).sort()).toEqual(['esforco', 'instrucoes', 'modelo', 'motor', 'nome']);
    expect(lido.erros.nome).toBe('Informe um nome com até 60 caracteres.');
    expect(lido.erros.instrucoes).toBe('As instruções têm no máximo 8000 caracteres.');
    expect(lido.erros.modelo).toMatch(/^Use até 80 caracteres/);
    expect(lido.erros.motor).toBe('Escolha um motor da lista.');
    expect(lido.erros.esforco).toBe('Escolha um esforço da lista.');
  });
});

describe('camposDoBot', () => {
  it('preenche o formulário com o bot', () => {
    expect(camposDoBot(bot)).toEqual({
      nome: 'Ajudante',
      instrucoes: 'Responda curto.',
      modelo: 'modelo-x',
      motor: 'claude-code',
      esforco: 'high',
    });
  });

  it('mostra modelo e esforço nulos como campos vazios', () => {
    expect(camposDoBot({ ...bot, modelo: null, esforco: null })).toMatchObject({ modelo: '', esforco: '' });
  });
});

describe('edicaoDoBot', () => {
  const igual: BotEntrada = { nome: bot.nome, instrucoes: bot.instrucoes, modelo: bot.modelo, motor: bot.motor, esforco: bot.esforco };

  it('devolve null quando nada mudou', () => {
    expect(edicaoDoBot(bot, igual)).toBeNull();
  });

  it('manda só o que mudou', () => {
    expect(edicaoDoBot(bot, { ...igual, nome: 'Outro' })).toEqual({ nome: 'Outro' });
    expect(edicaoDoBot(bot, { ...igual, instrucoes: '' })).toEqual({ instrucoes: '' });
    expect(edicaoDoBot(bot, { ...igual, esforco: 'low' })).toEqual({ esforco: 'low' });
    expect(edicaoDoBot(bot, { ...igual, nome: 'Outro', instrucoes: 'x', modelo: 'y' })).toEqual({
      nome: 'Outro',
      instrucoes: 'x',
      modelo: 'y',
    });
  });

  it('manda nulo para voltar o modelo ao "Auto" e o esforço ao padrão', () => {
    expect(edicaoDoBot(bot, { ...igual, modelo: null, esforco: null })).toEqual({ modelo: null, esforco: null });
  });

  it('nunca manda o motor, que é da criação', () => {
    expect(edicaoDoBot(bot, { ...igual, motor: 'outro-motor' })).toBeNull();
  });

  it('o que sai sempre passa no esquema de edição do contrato', () => {
    const edicao = edicaoDoBot(bot, { ...igual, modelo: null, esforco: null });
    expect(EsquemaBotEdicao.safeParse(edicao).success).toBe(true);
  });

  it('formulário aberto e salvo sem mexer não gera edição', () => {
    for (const aberto of [bot, { ...bot, modelo: null, esforco: null }]) {
      const lido = validarBot(camposDoBot(aberto));
      expect(lido.ok && edicaoDoBot(aberto, lido.entrada)).toBeNull();
    }
  });
});

// A mesma tabela que o app de desktop testa em `apps/desktop/crates/cliente/src/formulario_bot.rs`,
// onde a regra é escrita à mão. Aqui quem responde é o esquema do contrato: se um caso discordar
// dele, o caso está errado. Mudar o esquema exige mudar a tabela, e a tabela mudada quebra o
// teste do desktop até a regra de lá ser igualada.
describe('tabela de casos compartilhada com o app de desktop', () => {
  /** Um texto da tabela: inteiro, ou em partes, com trechos repetidos para os casos de limite. */
  type Texto = string | (string | { repete: string; vezes: number })[];
  interface Caso {
    caso: string;
    nome: Texto;
    instrucoes: Texto;
    modelo: Texto;
    motor?: Texto;
    esforco?: Texto;
    entrada?: { nome: Texto; instrucoes: Texto; modelo: Texto | null; motor?: Texto; esforco?: Texto | null };
    erros?: string[];
  }

  const casos: Caso[] = tabela.casos;
  const montar = (texto: Texto): string =>
    typeof texto === 'string' ? texto : texto.map((parte) => (typeof parte === 'string' ? parte : parte.repete.repeat(parte.vezes))).join('');

  it('tem casos de todos os tipos, cada um com o seu nome', () => {
    expect(casos.length).toBeGreaterThanOrEqual(150);
    expect(new Set(casos.map((caso) => caso.caso)).size).toBe(casos.length);
    expect(new Set(casos.map((caso) => (caso.erros ?? ['aceito']).join(',')))).toEqual(
      new Set([
        'aceito',
        'nome',
        'instrucoes',
        'modelo',
        'motor',
        'esforco',
        'modelo,nome',
        'instrucoes,nome',
        'instrucoes,modelo',
        'instrucoes,modelo,nome',
        'esforco,motor',
        'esforco,motor,nome',
        'esforco,instrucoes,modelo,motor,nome',
      ]),
    );
  });

  it('distingue as três formas de contar o tamanho: o esquema conta caracteres Unicode', () => {
    const emoji = '😀';
    expect([emoji.length, [...emoji].length]).toEqual([2, 1]);
    // Em unidades UTF-16 este nome passaria do limite; em caracteres, não.
    expect(validarBot(campos({ nome: emoji.repeat(LIMITES.nomeBot) })).ok).toBe(true);
    expect(validarBot(campos({ nome: emoji.repeat(LIMITES.nomeBot + 1) })).ok).toBe(false);
  });

  it.each(casos.map((caso) => [caso.caso, caso] as const))('%s', (_nome, caso) => {
    const lido = validarBot({
      nome: montar(caso.nome),
      instrucoes: montar(caso.instrucoes),
      modelo: montar(caso.modelo),
      // Sem motor nem esforço, o caso é o formulário como abre: o motor padrão e o esforço "Padrão".
      motor: caso.motor === undefined ? MOTOR_PADRAO : montar(caso.motor),
      esforco: caso.esforco === undefined ? '' : montar(caso.esforco),
    });
    if (caso.entrada === undefined) {
      expect(caso.erros?.length).toBeGreaterThan(0);
      expect(lido.ok ? lido : Object.keys(lido.erros).sort()).toEqual(caso.erros);
      return;
    }
    expect(caso.erros).toBeUndefined();
    const { esforco } = caso.entrada;
    const entrada = {
      nome: montar(caso.entrada.nome),
      instrucoes: montar(caso.entrada.instrucoes),
      modelo: caso.entrada.modelo === null ? null : montar(caso.entrada.modelo),
      motor: caso.entrada.motor === undefined ? MOTOR_PADRAO : montar(caso.entrada.motor),
      esforco: esforco === undefined || esforco === null ? null : montar(esforco),
    };
    expect(lido).toEqual({ ok: true, entrada });
    // O que o formulário entrega é o que o servidor lê, sem mudar mais nada.
    expect(EsquemaBotEntrada.parse(entrada)).toEqual(entrada);
  });
});
