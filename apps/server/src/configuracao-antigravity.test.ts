import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  comandoNaPastaDoBot,
  decidirNoGanchoDoAntigravity,
  FERRAMENTAS_COM_PEDIDO,
  ganchosDoAntigravity,
  pastaDeConfiguracao,
  prepararConfiguracaoDoAntigravity,
  prepararPastaDaSessao,
} from './configuracao-antigravity';

const raiz = mkdtempSync(path.join(os.tmpdir(), 'awika-agy-config-'));
afterAll(() => rmSync(raiz, { recursive: true, force: true }));

describe('gancho do Antigravity', () => {
  it.each([...FERRAMENTAS_COM_PEDIDO])('sai calado para %s, que chega ao driver como pedido de permissão', (ferramenta) => {
    expect(decidirNoGanchoDoAntigravity(JSON.stringify({ toolCall: { name: ferramenta, args: {} } }))).toBeNull();
  });

  it.each([
    ['a busca na web', { toolCall: { name: 'search_web', args: { query: 'x' } } }],
    ['a leitura de endereço', { toolCall: { name: 'read_url_content', args: { Url: 'https://exemplo.test' } } }],
    ['um subagente', { toolCall: { name: 'invoke_subagent', args: {} } }],
    ['um agendamento', { toolCall: { name: 'schedule', args: {} } }],
    ['uma ferramenta de servidor MCP', { toolCall: { name: 'mcp_plantado_rodar', args: {} } }],
    ['um nome da documentação que o binário não usa', { toolCall: { name: 'view_file', args: {} } }],
    ['uma ferramenta que uma versão nova trouxer', { toolCall: { name: 'ferramenta_nova', args: {} } }],
    ['um nome com outra caixa', { toolCall: { name: 'Run_Command', args: {} } }],
    ['uma chamada sem nome', { toolCall: {} }],
    ['um nome que não é texto', { toolCall: { name: ['run_command'] } }],
    ['uma entrada sem a chamada', {}],
  ])('nega %s', (_caso, entrada) => {
    expect(decidirNoGanchoDoAntigravity(JSON.stringify(entrada))).toMatchObject({ decision: 'deny' });
  });

  it.each(['', 'isto não é JSON {{{', 'null', '"run_command"'])('nega a entrada ilegível %j', (entrada) => {
    expect(decidirNoGanchoDoAntigravity(entrada)).toMatchObject({ decision: 'deny' });
  });

  it('no terminal, reescreve a linha do comando para ela partir da pasta do bot', () => {
    const entrada = JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'ls' } } });
    expect(decidirNoGanchoDoAntigravity(entrada, '/data/trabalho/bot')).toEqual({
      decision: 'allow',
      reason: 'o comando parte da pasta do bot',
      overwrite: { CommandLine: "cd '/data/trabalho/bot' && ls" },
    });
    // Sem a linha não há o que reescrever: o pedido segue, e o driver o nega.
    expect(decidirNoGanchoDoAntigravity(JSON.stringify({ toolCall: { name: 'run_command', args: {} } }), '/data/trabalho/bot')).toBeNull();
    // Sem saber a pasta, sai calado: o pedido segue como veio.
    expect(decidirNoGanchoDoAntigravity(entrada, null)).toBeNull();
    // Só no terminal: as outras ferramentas da lista seguem sem o gancho opinar.
    for (const ferramenta of ['read_file', 'write_file', 'edit_file']) {
      expect(decidirNoGanchoDoAntigravity(JSON.stringify({ toolCall: { name: ferramenta } }), '/data/trabalho/bot')).toBeNull();
    }
    // E saber a pasta não abre o que não está na lista.
    expect(decidirNoGanchoDoAntigravity(JSON.stringify({ toolCall: { name: 'search_web' } }), '/data/trabalho/bot')).toMatchObject({ decision: 'deny' });
  });

  it.each([
    ['uma pasta comum', '/data/trabalho/abc', 'ls -la', "cd '/data/trabalho/abc' && ls -la"],
    ['uma pasta com espaço', '/dados do bot/abc', 'pwd', "cd '/dados do bot/abc' && pwd"],
    ['uma pasta com aspa simples', "/d'agua/abc", 'pwd', "cd '/d'\\''agua/abc' && pwd"],
    ['um comando composto', '/p', 'a; b && c', "cd '/p' && a; b && c"],
  ])('a linha que roda parte da pasta do bot: %s', (_caso, pastaDoBot, linha, esperado) => {
    expect(comandoNaPastaDoBot(pastaDoBot, linha)).toBe(esperado);
  });

  it('vale para toda ferramenta', () => {
    const ganchos = JSON.parse(ganchosDoAntigravity('node servidor.mjs gancho-antigravity')) as {
      hooks: { PreToolUse: { matcher: string; hooks: { type: string; command: string }[] }[] };
    };
    expect(ganchos.hooks.PreToolUse).toHaveLength(1);
    expect(ganchos.hooks.PreToolUse[0]).toMatchObject({ matcher: '.*', hooks: [{ type: 'command', command: 'node servidor.mjs gancho-antigravity' }] });
  });
});

describe('configuração pessoal do Antigravity', () => {
  const ajustesDe = (casa: string): string => path.join(casa, '.gemini', 'antigravity-cli', 'settings.json');

  it('num volume novo, cria a pasta e grava o gancho, a lista vazia de servidores MCP e os ajustes', () => {
    const casa = path.join(raiz, 'novo');
    expect(prepararConfiguracaoDoAntigravity({ casa, comandoDoGancho: 'gancho', comChave: false })).toBeNull();
    expect(readFileSync(path.join(pastaDeConfiguracao(casa), 'hooks.json'), 'utf8')).toBe(ganchosDoAntigravity('gancho'));
    expect(readFileSync(path.join(pastaDeConfiguracao(casa), 'mcp_config.json'), 'utf8')).toBe('');
    expect(JSON.parse(readFileSync(ajustesDe(casa), 'utf8'))).toEqual({
      toolPermission: 'request-review',
      allowNonWorkspaceAccess: false,
      enableTerminalSandbox: false,
    });
  });

  it('com os ajustes ilegíveis, começa do zero', () => {
    const casa = path.join(raiz, 'ilegivel');
    mkdirSync(path.dirname(ajustesDe(casa)), { recursive: true });
    writeFileSync(ajustesDe(casa), '{{{');
    expect(prepararConfiguracaoDoAntigravity({ casa, comandoDoGancho: 'gancho', comChave: true })).toBeNull();
    expect(JSON.parse(readFileSync(ajustesDe(casa), 'utf8'))).toMatchObject({ modelProvider: 'gemini', toolPermission: 'request-review' });
  });

  it.each([
    ['uma lista de plugins', (config: string) => writeFileSync(path.join(config, 'plugins.json'), '{"entries":[]}'), 'há uma lista de plugins na configuração do Antigravity'],
    ['um plugin instalado', (config: string) => mkdirSync(path.join(config, 'plugins', 'x'), { recursive: true }), 'há um plugin instalado na configuração do Antigravity'],
  ])('recusa %s', (caso, plantar, motivo) => {
    const casa = path.join(raiz, caso.replace(/\s/g, '-'));
    mkdirSync(pastaDeConfiguracao(casa), { recursive: true });
    plantar(pastaDeConfiguracao(casa));
    expect(prepararConfiguracaoDoAntigravity({ casa, comandoDoGancho: 'gancho', comChave: false })).toBe(motivo);
  });

  it('aceita a pasta de plugins vazia', () => {
    const casa = path.join(raiz, 'plugins-vazia');
    mkdirSync(path.join(pastaDeConfiguracao(casa), 'plugins'), { recursive: true });
    expect(prepararConfiguracaoDoAntigravity({ casa, comandoDoGancho: 'gancho', comChave: false })).toBeNull();
  });
});

describe('pasta da sessão do Antigravity', () => {
  it('cria a pasta, e a aceita vazia', () => {
    expect(prepararPastaDaSessao(path.join(raiz, 'sessoes', 'bot-1'))).toBeNull();
    expect(prepararPastaDaSessao(path.join(raiz, 'sessoes', 'bot-1'))).toBeNull();
  });

  it('apaga o que achar dentro dela, e só dentro dela', () => {
    const pasta = path.join(raiz, 'sessoes', 'suja');
    const vizinha = path.join(raiz, 'sessoes', 'vizinha');
    mkdirSync(path.join(pasta, '.agents', 'plugins', 'x'), { recursive: true });
    writeFileSync(path.join(pasta, '.agents', 'hooks.json'), '{}');
    writeFileSync(path.join(pasta, 'AGENTS.md'), 'x');
    mkdirSync(vizinha, { recursive: true });
    writeFileSync(path.join(vizinha, 'fica.txt'), 'x');
    expect(prepararPastaDaSessao(pasta, path.join(raiz, 'sessoes'))).toBeNull();
    expect(readdirSync(pasta)).toEqual([]);
    expect(readdirSync(vizinha)).toEqual(['fica.txt']);
  });

  it.each([
    ['a própria pasta das sessões', path.join(raiz, 'sessoes')],
    ['uma pasta fora da pasta das sessões', path.join(raiz, 'outra')],
    ['uma pasta que sobe de nível', path.join(raiz, 'sessoes', '..', 'outra')],
  ])('não mexe em %s', (_caso, pasta) => {
    mkdirSync(path.join(raiz, 'outra'), { recursive: true });
    writeFileSync(path.join(raiz, 'outra', 'fica.txt'), 'x');
    expect(prepararPastaDaSessao(pasta, path.join(raiz, 'sessoes'))).toBe('a pasta da sessão do Antigravity está fora do lugar');
    expect(readdirSync(path.join(raiz, 'outra'))).toEqual(['fica.txt']);
  });

  it('recusa a pasta dentro de um repositório Git, em qualquer nível acima', () => {
    const repositorio = path.join(raiz, 'repositorio');
    mkdirSync(path.join(repositorio, '.git'), { recursive: true });
    expect(prepararPastaDaSessao(path.join(repositorio, 'a', 'b', 'bot-1'))).toBe('a pasta da sessão do Antigravity está dentro de um repositório Git');
  });

  it('recusa também numa árvore de trabalho, em que o repositório é marcado por um arquivo', () => {
    const arvore = path.join(raiz, 'arvore');
    mkdirSync(arvore, { recursive: true });
    writeFileSync(path.join(arvore, '.git'), 'gitdir: /outro/lugar');
    expect(prepararPastaDaSessao(path.join(arvore, 'bot-1'))).toBe('a pasta da sessão do Antigravity está dentro de um repositório Git');
  });
});
