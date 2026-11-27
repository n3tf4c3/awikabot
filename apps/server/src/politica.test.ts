import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LIMITES } from '@awikabot/core';
import { avaliarFerramenta, avaliarFerramentaDoDecisor } from './politica';

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
    ['arquivo da pasta cujo nome começa com til, pelo "./"', 'Read', { file_path: './~rascunho.txt' }],
    ['arquivo com til no meio do caminho', 'Read', { file_path: 'sub/~rascunho.txt' }],
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

  // O gancho recebe o caminho como o modelo o escreveu; o Claude Code só o interpreta depois, tirando
  // os espaços das pontas e trocando o "~" do começo pela pasta do usuário do motor (na imagem, o
  // volume, com o login e o banco). No 2.1.332, o `path` do Glob e do Grep chega assim ao gancho, e a
  // ferramenta lê o arquivo de fora; o Read e o Write chegam já expandidos.
  it.each([
    ['o login do motor pelo "~"', 'Read', { file_path: '~/claude/.credentials.json' }],
    ['a pasta do usuário', 'LS', { path: '~' }],
    ['a pasta de outro usuário', 'Read', { file_path: '~root/.ssh/id_ed25519' }],
    ['"~" depois de espaços', 'Read', { file_path: ' \t~/claude/.credentials.json' }],
    ['busca a partir do "~"', 'Glob', { pattern: '**/*', path: '~/claude' }],
    ['busca com padrão que começa com "~"', 'Glob', { pattern: '~/claude/**' }],
    ['busca com padrão que começa com "~" depois de um espaço', 'Glob', { pattern: ' ~/claude/**' }],
    ['busca com padrão absoluto depois de um espaço', 'Glob', { pattern: ` ${fora.replaceAll('\\', '/')}/**` }],
    ['busca por texto num arquivo do "~"', 'Grep', { pattern: '.', path: '~/claude/.credentials.json', output_mode: 'content' }],
    ['busca por texto no "~" de outro usuário', 'Grep', { pattern: '.', path: '~awikabot/claude' }],
    ['busca por texto no "~" depois de um espaço', 'Grep', { pattern: '.', path: ' ~/claude' }],
    ['busca por texto num caminho absoluto de fora depois de um espaço', 'Grep', { pattern: '.', path: ` ${fora}` }],
    ['busca num caminho absoluto de fora depois de um espaço', 'Glob', { pattern: '*.txt', path: ` ${fora}` }],
    ['busca por texto com filtro que começa com "~"', 'Grep', { pattern: 'x', glob: '~/claude/*' }],
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

  // A pessoa aprova o que leu. O cartão leva até `LIMITES.resumoAprovacao` caracteres, e a aprovação
  // libera a ação inteira: o que não cabe inteiro no cartão não chega a ser perguntado.
  describe('ação que não cabe inteira no cartão', () => {
    const limite = LIMITES.resumoAprovacao;
    const GRANDE_DEMAIS = { acao: 'negar', motivo: 'a ação não cabe inteira no cartão de aprovação; divida-a em partes menores' };
    /** O texto que, somado ao começo fixo do resumo, dá o tamanho pedido. */
    const ate = (tamanho: number, comeco: string): string => 'x'.repeat(tamanho - comeco.length);

    it.each([
      ['um comando', 'Bash', (n: number) => ({ command: ate(n, '') }), ''],
      ['um comando do Codex, com o aviso da pasta', 'Bash', (n: number) => ({ command: ate(n, `\n\n(na pasta ${fora})`), cwd: fora }), ''],
      ['uma gravação', 'Write', (n: number) => ({ file_path: 'a.txt', content: ate(n, 'Gravar o arquivo a.txt\n\n') }), 'Gravar o arquivo a.txt\n\n'],
      ['uma troca de texto', 'Edit', (n: number) => ({ file_path: 'a.txt', old_string: 'um', new_string: ate(n, 'Alterar o arquivo a.txt\n\nSai:\num\nEntra:\n') }), 'Alterar o arquivo a.txt\n\nSai:\num\nEntra:\n'],
      ['uma edição do Codex, em diff', 'Edit', (n: number) => ({ file_path: 'a.txt', diff: ate(n, 'Alterar o arquivo a.txt\n\n') }), 'Alterar o arquivo a.txt\n\n'],
      ['uma célula de caderno', 'NotebookEdit', (n: number) => ({ notebook_path: 'n.ipynb', new_source: ate(n, 'Alterar o arquivo n.ipynb\n\n') }), 'Alterar o arquivo n.ipynb\n\n'],
      ['um endereço', 'WebFetch', (n: number) => ({ url: ate(n, 'Abrir ') }), 'Abrir '],
      ['uma ferramenta desconhecida', 'FerramentaNova', (n: number) => ({ a: ate(n, '{"a":""}') }), '{"a":"'],
    ])('%s: no limite vai inteira para a pessoa; um caractere a mais é negado sem cartão', (_caso, ferramenta, entradaCom, comeco) => {
      const noLimite = avaliarFerramenta(ferramenta, entradaCom(limite), pasta);
      expect(noLimite.acao).toBe('perguntar');
      if (noLimite.acao !== 'perguntar') return;
      expect(noLimite.resumo).toHaveLength(limite);
      expect(noLimite.resumo.startsWith(comeco)).toBe(true);
      expect(noLimite.resumo).not.toContain('cortado');

      expect(avaliarFerramenta(ferramenta, entradaCom(limite + 1), pasta)).toEqual(GRANDE_DEMAIS);
    });

    it('nega uma gravação longa em vez de mostrar só o começo dela', () => {
      expect(avaliarFerramenta('Write', { file_path: 'a.txt', content: 'y'.repeat(limite * 2) }, pasta)).toEqual(GRANDE_DEMAIS);
    });

    it('o conteúdo conta em unidades do contrato: um emoji conta por dois', () => {
      expect(acao('Bash', { command: '😀'.repeat(limite / 2) })).toBe('perguntar');
      expect(avaliarFerramenta('Bash', { command: `${'😀'.repeat(limite / 2)}x` }, pasta)).toEqual(GRANDE_DEMAIS);
    });
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
      // No 2.1.332 a gravação chega ao gancho já expandida; o "~" que chegasse cru iria ao cartão como
      // se fosse uma pasta dentro da do bot.
      ['caminho que começa com "~"', '~/.bashrc'],
      ['caminho no "~" de outro usuário', '~root/.bashrc'],
      ['subida de nível depois de um espaço', ' ../fora/x.txt'],
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
      ['o gancho que o Antigravity leria da pasta', '.agents/hooks.json'],
      ['os servidores MCP que o Antigravity leria da pasta', '.agents/mcp_config.json'],
      ['a pasta do Antigravity com outro nome', '_agents/hooks.json'],
      ['a pasta do Antigravity com o nome antigo', 'sub/.agent/plugins/x/plugin.json'],
      ['a pasta do Antigravity com o quarto nome', '_agent/hooks.json'],
      ['a configuração alcançada por um caminho torto', 'sub/../.claude/settings.json'],
      ['a configuração depois de um espaço', ' .claude/settings.json'],
      ['os servidores MCP com um espaço no fim', '.mcp.json '],
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

// O driver do Codex traduz cada pedido para estas ferramentas (`motor-codex.ts`): o comando vem com
// a pasta em que roda, e a edição vem como diff, que também apaga e move arquivos.
describe('pedidos do Codex', () => {
  it('o comando mostra a pasta em que roda quando ela não é a do bot', () => {
    expect(avaliarFerramenta('Bash', { command: "/bin/bash -lc 'ls'", cwd: pasta }, pasta)).toEqual({ acao: 'perguntar', resumo: "/bin/bash -lc 'ls'" });
    expect(avaliarFerramenta('Bash', { command: "/bin/bash -lc 'ls'", cwd: fora }, pasta)).toEqual({
      acao: 'perguntar',
      resumo: `/bin/bash -lc 'ls'\n\n(na pasta ${fora})`,
    });
  });

  it('a gravação mostra o diff, e apagar e mover dizem o que fazem', () => {
    expect(avaliarFerramenta('Write', { file_path: 'novo.txt', diff: 'linha nova\n' }, pasta)).toEqual({
      acao: 'perguntar',
      resumo: 'Gravar o arquivo novo.txt\n\nlinha nova\n',
    });
    expect(avaliarFerramenta('Edit', { file_path: 'notas.txt', diff: '-oi\n', apagar: true }, pasta)).toEqual({
      acao: 'perguntar',
      resumo: 'Apagar o arquivo notas.txt\n\n-oi\n',
    });
    expect(avaliarFerramenta('Edit', { file_path: 'notas.txt', diff: '', mover_para: 'sub/notas.txt' }, pasta)).toEqual({
      acao: 'perguntar',
      resumo: 'Mover o arquivo notas.txt para sub/notas.txt\n\n',
    });
  });

  it.each([
    ['mover para fora da pasta', { file_path: 'notas.txt', diff: '', mover_para: path.join(fora, 'notas.txt') }, 'o bot só grava arquivos na própria pasta de trabalho'],
    ['mover sem destino legível', { file_path: 'notas.txt', diff: '', mover_para: 42 }, 'o bot só grava arquivos na própria pasta de trabalho'],
    ['mover para a configuração do Codex', { file_path: 'notas.txt', diff: '', mover_para: '.codex/config.toml' }, 'o bot não altera a configuração do motor'],
    ['gravar na configuração do Codex', { file_path: '.codex/config.toml', diff: 'x' }, 'o bot não altera a configuração do motor'],
    ['gravar na configuração do Codex com outra caixa', { file_path: 'sub/.Codex/hooks.json', diff: 'x' }, 'o bot não altera a configuração do motor'],
  ])('nega %s, sem perguntar', (_caso, entrada, motivo) => {
    expect(avaliarFerramenta('Edit', entrada, pasta)).toEqual({ acao: 'negar', motivo });
  });
});

describe('turno de um decisor', () => {
  it('só deixa passar a entrega da resposta presa ao esquema', () => {
    expect(avaliarFerramentaDoDecisor('StructuredOutput')).toEqual({ acao: 'permitir' });
  });

  it.each(['Read', 'Glob', 'TodoWrite', 'Bash', 'Write', 'WebSearch', 'mcp__awika__delegar', 'structuredoutput', ''])('nega %s, sem perguntar', (ferramenta) => {
    expect(avaliarFerramentaDoDecisor(ferramenta)).toEqual({ acao: 'negar', motivo: 'o turno de um decisor não usa ferramentas' });
  });

  it('num turno de bot, a entrega da resposta não passa sozinha', () => {
    expect(acao('StructuredOutput', {})).toBe('perguntar');
  });
});
