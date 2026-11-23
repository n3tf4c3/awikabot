import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LIMITES } from '@awikabot/core';
import { avaliarFerramenta } from './politica';

const raiz = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'awikabot-politica-')));
const pasta = path.join(raiz, 'bot');
const fora = path.join(raiz, 'fora');
mkdirSync(path.join(pasta, 'sub'), { recursive: true });
mkdirSync(fora);
writeFileSync(path.join(pasta, 'notas.txt'), 'oi');
writeFileSync(path.join(fora, 'segredo.txt'), 'não ler');
afterAll(() => {
  rmSync(raiz, { recursive: true, force: true });
});

const acao = (ferramenta: string, entrada: Record<string, unknown>): string => avaliarFerramenta(ferramenta, entrada, pasta).acao;

describe('leitura', () => {
  it.each([
    ['arquivo da pasta, relativo', 'Read', { file_path: 'notas.txt' }],
    ['arquivo da pasta, absoluto', 'Read', { file_path: path.join(pasta, 'notas.txt') }],
    ['arquivo que ainda não existe, dentro da pasta', 'Read', { file_path: 'sub/novo.txt' }],
    ['a própria pasta', 'LS', { path: pasta }],
    ['busca sem caminho', 'Glob', { pattern: '**/*.txt' }],
    ['busca por texto, com expressão que parece caminho', 'Grep', { pattern: '^/etc/\\.\\.', path: 'sub' }],
    ['busca por texto com filtro de arquivos', 'Grep', { pattern: 'oi', glob: '*.txt' }],
  ])('permite %s', (_caso, ferramenta, entrada) => {
    expect(acao(ferramenta, entrada)).toBe('permitir');
  });

  it.each([
    ['caminho absoluto fora da pasta', 'Read', { file_path: path.join(fora, 'segredo.txt') }],
    ['subida de nível', 'Read', { file_path: '../fora/segredo.txt' }],
    ['subida de nível disfarçada', 'Read', { file_path: 'sub/../../fora/segredo.txt' }],
    ['a pasta de cima', 'LS', { path: raiz }],
    ['pasta com o mesmo começo de nome', 'Read', { file_path: `${pasta}-outro/x.txt` }],
    ['busca com padrão absoluto', 'Glob', { pattern: `${fora.replaceAll('\\', '/')}/**` }],
    ['busca com padrão que sobe de nível', 'Glob', { pattern: '../**/*.txt' }],
    ['busca por texto com filtro que sobe de nível', 'Grep', { pattern: 'x', glob: '../*' }],
    ['busca por texto em caminho de fora', 'Grep', { pattern: 'x', path: fora }],
    ['caminho que não é texto', 'Read', { file_path: 42 }],
  ])('nega %s', (_caso, ferramenta, entrada) => {
    expect(avaliarFerramenta(ferramenta, entrada, pasta)).toEqual({
      acao: 'negar',
      motivo: 'o bot só lê arquivos da própria pasta de trabalho',
    });
  });

  it('nega a leitura por um atalho que aponta para fora da pasta', (contexto) => {
    try {
      symlinkSync(fora, path.join(pasta, 'atalho'), 'junction');
    } catch {
      contexto.skip();
    }
    expect(acao('Read', { file_path: 'atalho/segredo.txt' })).toBe('negar');
    expect(acao('Read', { file_path: 'notas.txt' })).toBe('permitir');
  });
});

describe('o que muda alguma coisa', () => {
  it.each([
    ['Bash', { command: 'rm -rf x' }, 'rm -rf x'],
    ['Write', { file_path: 'a.txt', content: 'x' }, 'Gravar o arquivo a.txt'],
    ['Edit', { file_path: 'a.txt' }, 'Alterar o arquivo a.txt'],
    ['WebFetch', { url: 'https://exemplo.com' }, 'Abrir https://exemplo.com'],
    ['WebSearch', { query: 'tempo' }, 'Pesquisar na web: tempo'],
    ['FerramentaNova', { a: 1 }, '{"a":1}'],
  ])('pergunta antes de %s', (ferramenta, entrada, resumo) => {
    expect(avaliarFerramenta(ferramenta, entrada, pasta)).toEqual({ acao: 'perguntar', resumo });
  });

  it('pergunta mesmo quando o comando só lê um arquivo de fora', () => {
    expect(acao('Bash', { command: `cat ${path.join(fora, 'segredo.txt')}` })).toBe('perguntar');
  });

  it('corta o resumo no limite do contrato e avisa', () => {
    const veredito = avaliarFerramenta('Bash', { command: 'x'.repeat(LIMITES.resumoAprovacao + 500) }, pasta);
    expect(veredito.acao).toBe('perguntar');
    if (veredito.acao !== 'perguntar') return;
    expect(veredito.resumo).toHaveLength(LIMITES.resumoAprovacao);
    expect(veredito.resumo.endsWith('… (cortado)')).toBe(true);
  });

  it('deixa passar a lista de tarefas do motor, que não toca em nada', () => {
    expect(acao('TodoWrite', { todos: [] })).toBe('permitir');
  });
});
