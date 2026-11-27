import { describe, expect, it } from 'vitest';
import { EsquemaBotEntrada, LIMITES } from '@awikabot/core';
import tabela from '../../../../packages/core/casos/bot-entrada.json';
import { contarCaracteres, tetoDoCampoNativo } from './texto';

describe('contarCaracteres', () => {
  it.each([
    ['vazio', '', 0],
    ['letras', 'Scout', 5],
    ['acentos', 'ação', 4],
    ['um emoji, que ocupa duas unidades no JavaScript', '😀', 1],
    ['31 emojis: 62 unidades, 31 caracteres', '😀'.repeat(31), 31],
    ['letras e emojis', `${'a'.repeat(30)}${'😀'.repeat(30)}`, 60],
  ])('%s', (_caso, texto, esperado) => {
    expect(contarCaracteres(texto)).toBe(esperado);
  });

  it('conta como o esquema do contrato: o nome que o contador mostra dentro do limite é aceito, e o de fora é recusado', () => {
    const nome = EsquemaBotEntrada.shape.nome;
    for (const emojis of [1, 31, 59, 60, 61, 90]) {
      const texto = '😀'.repeat(emojis);
      expect(nome.safeParse(texto).success, `${emojis} emojis`).toBe(contarCaracteres(texto) <= LIMITES.nomeBot);
    }
  });

  // A mesma tabela que valida o formulário no celular e no desktop: o contador não pode dizer
  // "passou" de um nome que ela aceita, nem "cabe" de um que ela recusa por tamanho.
  type Texto = string | (string | { repete: string; vezes: number })[];
  const montar = (texto: Texto): string =>
    typeof texto === 'string' ? texto : texto.map((parte) => (typeof parte === 'string' ? parte : parte.repete.repeat(parte.vezes))).join('');
  const casos = (tabela.casos as { caso: string; nome: Texto; instrucoes: Texto; erros?: string[] }[]).map((caso) => ({
    caso: caso.caso,
    nome: montar(caso.nome).trim(),
    instrucoes: montar(caso.instrucoes),
    erros: caso.erros ?? [],
  }));

  it.each(casos.filter((caso) => caso.nome !== '').map((caso) => [caso.caso, caso] as const))('nome da tabela: %s', (_nome, caso) => {
    expect(contarCaracteres(caso.nome) <= LIMITES.nomeBot).toBe(!caso.erros.includes('nome'));
  });

  it.each(casos.map((caso) => [caso.caso, caso] as const))('instruções da tabela: %s', (_nome, caso) => {
    expect(contarCaracteres(caso.instrucoes) <= LIMITES.instrucoes).toBe(!caso.erros.includes('instrucoes'));
  });
});

describe('tetoDoCampoNativo', () => {
  it('nunca barra um texto que o contrato aceita, por mais emojis que tenha', () => {
    for (const limite of [LIMITES.nomeBot, LIMITES.instrucoes]) {
      const noLimite = '😀'.repeat(limite);
      expect(contarCaracteres(noLimite)).toBe(limite);
      expect(noLimite.length).toBeLessThanOrEqual(tetoDoCampoNativo(limite));
    }
  });

  it('o teto antigo, igual ao limite, barrava o nome de 31 emojis que o contrato aceita', () => {
    expect('😀'.repeat(31).length).toBeGreaterThan(LIMITES.nomeBot);
    expect('😀'.repeat(31).length).toBeLessThanOrEqual(tetoDoCampoNativo(LIMITES.nomeBot));
  });
});
