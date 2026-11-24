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
    ['Write', { file_path: 'a.txt', content: 'x' }, 'Gravar o arquivo a.txt\n\nx'],
    ['Edit', { file_path: 'a.txt' }, 'Alterar o arquivo a.txt'],
    ['Edit', { file_path: 'a.txt', old_string: 'um', new_string: 'dois' }, 'Alterar o arquivo a.txt\n\nSai:\num\nEntra:\ndois'],
    [
      'MultiEdit',
      { file_path: 'a.txt', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: '' }] },
      'Alterar o arquivo a.txt\n\nSai:\na\nEntra:\nb\n\nSai:\nc\nEntra:\n',
    ],
    ['NotebookEdit', { notebook_path: 'sub/n.ipynb', new_source: 'print(1)' }, 'Alterar o arquivo sub/n.ipynb\n\nprint(1)'],
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

  it('corta um conteúdo longo de gravação, mantendo o nome do arquivo no começo', () => {
    const veredito = avaliarFerramenta('Write', { file_path: 'a.txt', content: 'y'.repeat(LIMITES.resumoAprovacao * 2) }, pasta);
    expect(veredito.acao).toBe('perguntar');
    if (veredito.acao !== 'perguntar') return;
    expect(veredito.resumo).toHaveLength(LIMITES.resumoAprovacao);
    expect(veredito.resumo.startsWith('Gravar o arquivo a.txt\n\nyyy')).toBe(true);
  });

  it('deixa passar a lista de tarefas do motor, que não toca em nada', () => {
    expect(acao('TodoWrite', { todos: [] })).toBe('permitir');
  });
});

describe('gravação', () => {
  const FERRAMENTAS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const;
  const entradaDe = (ferramenta: string, caminho: unknown): Record<string, unknown> =>
    ferramenta === 'NotebookEdit' ? { notebook_path: caminho, new_source: 'x' } : { file_path: caminho, content: 'x' };

  describe.each(FERRAMENTAS)('%s', (ferramenta) => {
    it.each([
      ['arquivo novo na pasta, relativo', 'novo.txt'],
      ['arquivo numa subpasta, absoluto', path.join(pasta, 'sub', 'novo.txt')],
      ['arquivo com nome parecido com o da configuração', 'claude.json'],
    ])('pergunta antes de gravar %s', (_caso, caminho) => {
      expect(acao(ferramenta, entradaDe(ferramenta, caminho))).toBe('perguntar');
    });

    it.each([
      ['caminho absoluto fora da pasta', path.join(fora, 'x.txt')],
      ['subida de nível', '../fora/x.txt'],
      ['subida de nível disfarçada', 'sub/../../fora/x.txt'],
      ['pasta com o mesmo começo de nome', `${pasta}-outro/x.txt`],
      ['caminho que não é texto', 42],
      ['caminho ausente', undefined],
    ])('nega %s, sem perguntar', (_caso, caminho) => {
      expect(avaliarFerramenta(ferramenta, entradaDe(ferramenta, caminho), pasta)).toEqual({
        acao: 'negar',
        motivo: 'o bot só grava arquivos na própria pasta de trabalho',
      });
    });

    it.each([
      ['a configuração do motor na pasta do bot', '.claude/settings.json'],
      ['a configuração local do motor', path.join(pasta, '.claude', 'settings.local.json')],
      ['a configuração escrita com outra caixa', '.Claude/settings.json'],
      ['uma pasta de configuração dentro de uma subpasta', 'sub/.claude/skills/x/SKILL.md'],
      ['os servidores MCP do projeto', '.mcp.json'],
      ['a configuração alcançada por um caminho torto', 'sub/../.claude/settings.json'],
    ])('nega gravar %s, sem perguntar', (_caso, caminho) => {
      expect(avaliarFerramenta(ferramenta, entradaDe(ferramenta, caminho), pasta)).toEqual({
        acao: 'negar',
        motivo: 'o bot não altera a configuração do motor',
      });
    });
  });

  it('nega a gravação por um atalho que aponta para fora da pasta', (contexto) => {
    try {
      symlinkSync(fora, path.join(pasta, 'atalho-de-gravacao'), 'junction');
    } catch {
      contexto.skip();
    }
    expect(acao('Write', { file_path: 'atalho-de-gravacao/novo.txt', content: 'x' })).toBe('negar');
  });
});
