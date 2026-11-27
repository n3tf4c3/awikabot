// O driver do Antigravity contra um `agy acp` de mentira (`antigravity-de-mentira.ts`) e o lado do
// servidor que atende o gancho de verdade (`criarAppDoGancho`), com a política de verdade. Só o
// gestor de aprovações é trocado: aqui ele responde na hora, no lugar da pessoa.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GestorDeAprovacoes } from './aprovacoes';
import { comandoNaPastaDoBot, ganchosDoAntigravity } from './configuracao-antigravity';
import { criarAppDoGancho, Ganchos } from './gancho';
import type { PedidoMotor, ResultadoMotor } from './motor';
import { classificarFalhaDoAntigravity, consultasDoPedido, criarMotorAntigravity, instrucoesDoTurno } from './motor-antigravity';

const MENTIRA = fileURLToPath(new URL('./antigravity-de-mentira.ts', import.meta.url));
const raiz = mkdtempSync(path.join(os.tmpdir(), 'awika-agy-'));
const pasta = path.join(raiz, 'trabalho', 'bot');
const casa = path.join(raiz, 'casa');
const pastaDasSessoes = path.join(raiz, 'antigravity');
const pastaDaSessao = path.join(pastaDasSessoes, 'bot');
const configuracao = path.join(casa, '.gemini', 'config');
const ajustes = path.join(casa, '.gemini', 'antigravity-cli', 'settings.json');
const COMANDO_DO_GANCHO = 'node servidor.mjs gancho-antigravity';
mkdirSync(pasta, { recursive: true });
mkdirSync(casa, { recursive: true });

type Pedido = Parameters<GestorDeAprovacoes['pedir']>[0];
const cartoes: Pedido[] = [];
let decisao: 'aprovar' | 'negar' = 'aprovar';
const ganchos = new Ganchos();
const aprovacoes = {
  pedir: async (pedido: Pedido) => {
    cartoes.push(pedido);
    return decisao;
  },
} as unknown as GestorDeAprovacoes;
let servidor: Server;
let porta = 0;

beforeAll(async () => {
  servidor = serve({ fetch: criarAppDoGancho({ ganchos, aprovacoes }).fetch, hostname: '127.0.0.1', port: 0 }) as Server;
  await new Promise<void>((pronto) => servidor.once('listening', () => pronto()));
  porta = (servidor.address() as AddressInfo).port;
});

afterAll(async () => {
  servidor.closeAllConnections();
  await new Promise<void>((fim) => servidor.close(() => fim()));
  rmSync(raiz, { recursive: true, force: true });
});

let rodada = 0;

/** Roda um turno e devolve o resultado, os trechos de texto e o que o Antigravity de mentira recebeu. */
async function turno(
  texto: string,
  opcoes: {
    sessao?: string | null;
    semGancho?: boolean;
    gancho?: { porta: number };
    binario?: string;
    /**
     * Quando pedir a parada: assim que o primeiro trecho chegar, ou logo depois de o turno ser
     * pedido, antes de qualquer trecho. Nenhum dos dois depende de quanto o processo demora a subir.
     */
    parar?: 'no_primeiro_trecho' | 'antes_de_qualquer_trecho';
    modelo?: string;
    ambiente?: Record<string, string>;
  } = {},
): Promise<{ resultado: ResultadoMotor; trechos: string[]; recebidas: Record<string, unknown>[]; argv: string[]; cwd: string | null; pastaDoBot: string | null }> {
  rodada += 1;
  const registro = path.join(raiz, `registro-${rodada}.jsonl`);
  const motor = criarMotorAntigravity({
    binario: opcoes.binario ?? process.execPath,
    prefixo: opcoes.binario ? [] : [MENTIRA],
    ambiente: { ...process.env, HOME: casa, USERPROFILE: casa, ANTIGRAVITY_DE_MENTIRA_REGISTRO: registro, ...opcoes.ambiente } as Record<string, string>,
    pastaDasSessoes,
    comandoDoGancho: COMANDO_DO_GANCHO,
    prazoDaParadaMs: 3000,
  });
  const token = ganchos.registrar({ botId: 'bot-1', mensagemId: `msg-${rodada}`, pasta });
  const trechos: string[] = [];
  const pedido: PedidoMotor = {
    motor: 'antigravity',
    pasta,
    texto,
    instrucoes: 'Responda em português.',
    modelo: opcoes.modelo ?? 'gemini-4-neon',
    esforco: 'high',
    sessao: opcoes.sessao ?? null,
    gancho: opcoes.semGancho ? null : { comando: 'nao-usado', porta: opcoes.gancho?.porta ?? porta, token },
    aoTexto: (trecho) => {
      trechos.push(trecho);
      if (opcoes.parar === 'no_primeiro_trecho' && trechos.length === 1) emCurso.parar();
    },
  };
  const emCurso = motor(pedido);
  if (opcoes.parar === 'antes_de_qualquer_trecho') emCurso.parar();
  const resultado = await emCurso.fim;
  ganchos.remover(token);
  let linhas: Record<string, unknown>[] = [];
  try {
    linhas = readFileSync(registro, 'utf8').trim().split('\n').map((linha) => JSON.parse(linha) as Record<string, unknown>);
  } catch {
    // O processo nem subiu.
  }
  const partida = linhas.find((linha) => 'argv' in linha);
  return {
    resultado,
    trechos,
    recebidas: linhas.filter((linha) => !('argv' in linha)),
    argv: (partida?.argv as string[] | undefined) ?? [],
    cwd: (partida?.cwd as string | undefined) ?? null,
    pastaDoBot: (partida?.pastaDoBot as string | undefined) ?? null,
  };
}

const recebido = (recebidas: Record<string, unknown>[], metodo: string) =>
  recebidas.find((mensagem) => mensagem.method === metodo)?.params as Record<string, unknown> | undefined;
const opcoesTrocadas = (recebidas: Record<string, unknown>[]) =>
  recebidas.filter((mensagem) => mensagem.method === 'session/set_config_option').map((mensagem) => mensagem.params as Record<string, unknown>);
const respostas = (recebidas: Record<string, unknown>[]) =>
  recebidas.filter((mensagem) => mensagem.method === undefined && 'result' in mensagem).map((mensagem) => mensagem.result);
const PERMITIU = { outcome: { outcome: 'selected', optionId: 'allow' } };
const NEGOU = { outcome: { outcome: 'selected', optionId: 'deny' } };

describe('motor do Antigravity', () => {
  it('responde aos poucos, numa conversa nova, com o modelo, o esforço e as instruções do bot', async () => {
    const { resultado, trechos, recebidas, argv, cwd, pastaDoBot } = await turno('eco olá do Antigravity');
    expect(resultado).toEqual({ estado: 'completa', texto: 'olá do Antigravity', sessao: expect.stringMatching(/^sessao-/) as string });
    expect(trechos.length).toBeGreaterThanOrEqual(3);
    expect(recebido(recebidas, 'initialize')).toMatchObject({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    expect(recebido(recebidas, 'session/new')).toEqual({
      cwd: pastaDaSessao,
      mcpServers: [],
      _meta: { antigravity: { systemPrompt: { append: instrucoesDoTurno('Responda em português.', pasta) } } },
    });
    expect(opcoesTrocadas(recebidas)).toEqual([
      { sessionId: resultado.sessao, configId: 'model', value: 'gemini-4-neon' },
      { sessionId: resultado.sessao, configId: 'thought_level', value: 'high' },
    ]);
    expect(recebido(recebidas, 'session/prompt')).toEqual({ sessionId: resultado.sessao, prompt: [{ type: 'text', text: 'eco olá do Antigravity' }] });
    // Sem a chave de API no ambiente, o acesso é o login guardado pelo próprio Antigravity.
    expect(recebido(recebidas, 'authenticate')).toBeUndefined();
    // O texto da pessoa nunca vai na linha de comando, e a sessão abre fora da pasta do bot.
    expect(argv).toEqual(['acp']);
    expect(cwd).toBe(pastaDaSessao);
    expect(path.relative(pasta, pastaDaSessao).startsWith('..')).toBe(true);
    expect(readdirSync(pastaDaSessao)).toEqual([]);
    // O gancho do Antigravity herda do processo a pasta do bot, de onde os comandos partem.
    expect(pastaDoBot).toBe(pasta);
  });

  it('antes do turno, repõe o gancho e os ajustes que fecham o que roda sem pedido', async () => {
    writeFileSync(path.join(configuracao, 'hooks.json'), '{"hooks":{}}');
    writeFileSync(path.join(configuracao, 'mcp_config.json'), '{"mcpServers":{"plantado":{"command":"sh"}}}');
    writeFileSync(ajustes, JSON.stringify({ permissions: { allow: ['command(*)'] }, agentMode: 'auto', toolPermission: 'always-proceed', model: 'Gemini 4 Neon' }));
    await turno('eco oi');
    expect(readFileSync(path.join(configuracao, 'hooks.json'), 'utf8')).toBe(ganchosDoAntigravity(COMANDO_DO_GANCHO));
    expect(readFileSync(path.join(configuracao, 'mcp_config.json'), 'utf8')).toBe('');
    expect(JSON.parse(readFileSync(ajustes, 'utf8'))).toEqual({
      model: 'Gemini 4 Neon',
      toolPermission: 'request-review',
      allowNonWorkspaceAccess: false,
      enableTerminalSandbox: false,
    });
  });

  it('com a chave de API no ambiente, autentica por ela e liga o provedor', async () => {
    const { resultado, recebidas } = await turno('eco oi', { ambiente: { GEMINI_API_KEY: 'chave-de-teste' } });
    expect(resultado.estado).toBe('completa');
    expect(recebido(recebidas, 'authenticate')).toEqual({ methodId: 'gemini-api-key' });
    expect(JSON.parse(readFileSync(ajustes, 'utf8'))).toMatchObject({ modelProvider: 'gemini' });
    // No turno seguinte, sem a chave, o provedor sai.
    await turno('eco oi');
    expect(JSON.parse(readFileSync(ajustes, 'utf8'))).not.toHaveProperty('modelProvider');
  });

  it('retoma a conversa do bot sem pedir o histórico de volta', async () => {
    const { resultado, recebidas } = await turno('eco de volta', { sessao: 'sessao-antiga' });
    expect(recebido(recebidas, 'session/new')).toBeUndefined();
    expect(recebido(recebidas, 'session/load')).toBeUndefined();
    expect(recebido(recebidas, 'session/resume')).toMatchObject({ sessionId: 'sessao-antiga', cwd: pastaDaSessao, mcpServers: [] });
    expect(resultado).toEqual({ estado: 'completa', texto: 'de volta', sessao: 'sessao-antiga' });
  });

  it('uma sessão que o Antigravity não acha vira falha, e o bot recomeça a conversa no turno seguinte', async () => {
    const { resultado } = await turno('eco oi', { sessao: 'sumiu' });
    expect(resultado).toEqual({ estado: 'falhou', texto: 'O Antigravity não respondeu: sessão do motor não encontrada.', sessao: null });
  });

  it('um modelo que o Antigravity não oferece vira falha, sem rodar o turno', async () => {
    const { resultado, recebidas } = await turno('eco oi', { modelo: 'modelo-que-nao-existe' });
    expect(recebido(recebidas, 'session/prompt')).toBeUndefined();
    expect(resultado).toMatchObject({ estado: 'falhou', texto: 'O Antigravity não respondeu: modelo não aceito pelo motor.' });
  });

  it('uma sessão que abre num modo que aprova sozinho é posta no modo que pergunta', async () => {
    const { resultado, recebidas } = await turno('eco oi', { ambiente: { ANTIGRAVITY_DE_MENTIRA_MODO: 'auto' } });
    expect(opcoesTrocadas(recebidas)[0]).toMatchObject({ configId: 'mode', value: 'default' });
    expect(resultado.estado).toBe('completa');
  });

  it('se o modo que pergunta não pega, o turno não roda', async () => {
    const { resultado, recebidas } = await turno('eco oi', { ambiente: { ANTIGRAVITY_DE_MENTIRA_MODO: 'auto', ANTIGRAVITY_DE_MENTIRA_MODO_PRESO: '1' } });
    expect(recebido(recebidas, 'session/prompt')).toBeUndefined();
    expect(resultado).toMatchObject({ estado: 'falhou', texto: 'O Antigravity não respondeu: motor fora do modo que pede aprovação.' });
  });

  it('o comando aprovado pela pessoa roda, com a linha inteira no cartão', async () => {
    decisao = 'aprovar';
    cartoes.length = 0;
    const { resultado, recebidas } = await turno('comando echo awika-ok > aprovado.txt');
    expect(cartoes).toHaveLength(1);
    // O cartão mostra a linha como ela roda: o gancho a faz partir da pasta do bot.
    expect(cartoes[0]).toMatchObject({ botId: 'bot-1', ferramenta: 'Bash', resumo: comandoNaPastaDoBot(pasta, 'echo awika-ok > aprovado.txt') });
    expect(cartoes[0]?.resumo).toBe(`cd '${pasta}' && echo awika-ok > aprovado.txt`);
    expect(respostas(recebidas)).toContainEqual(PERMITIU);
    // O que o modelo diz antes e depois da ferramenta fica em parágrafos.
    expect(resultado).toMatchObject({ estado: 'completa', texto: 'Vou rodar.\n\nrodou' });
  });

  it('o comando negado pela pessoa não roda', async () => {
    decisao = 'negar';
    const { resultado, recebidas } = await turno('comando rm -rf tudo');
    expect(respostas(recebidas)).toContainEqual(NEGOU);
    expect(resultado.texto).toBe('Vou rodar.\n\nnegado');
  });

  it.each([
    ['sem gancho', { semGancho: true }],
    ['com o servidor de aprovação fora do ar', { gancho: { porta: 1 } }],
  ])('%s, o comando é negado sem cartão', async (_caso, opcoes) => {
    decisao = 'aprovar';
    cartoes.length = 0;
    const { resultado, recebidas } = await turno('comando echo oi', opcoes);
    expect(cartoes).toHaveLength(0);
    expect(respostas(recebidas)).toContainEqual(NEGOU);
    expect(resultado.texto).toBe('Vou rodar.\n\nnegado');
  });

  it('a gravação na pasta do bot vai ao cartão com o conteúdo', async () => {
    decisao = 'aprovar';
    cartoes.length = 0;
    const alvo = path.join(pasta, 'notas.txt');
    const { resultado } = await turno(`gravar ${alvo}`);
    expect(cartoes).toHaveLength(1);
    expect(cartoes[0]).toMatchObject({ ferramenta: 'Write', resumo: `Gravar o arquivo ${alvo}\n\nconteúdo novo` });
    expect(resultado.texto).toBe('gravou');
  });

  it('a edição na pasta do bot vai ao cartão com o que sai e o que entra', async () => {
    decisao = 'aprovar';
    cartoes.length = 0;
    const alvo = path.join(pasta, 'notas.txt');
    const { resultado } = await turno(`editar ${alvo}`);
    expect(cartoes).toHaveLength(1);
    expect(cartoes[0]).toMatchObject({ ferramenta: 'Edit', resumo: `Alterar o arquivo ${alvo}\n\nSai:\nantes\nEntra:\ndepois` });
    expect(resultado.texto).toBe('editou');
  });

  it.each([
    ['fora da pasta do bot', path.join(raiz, 'fora.txt')],
    ['na pasta da sessão', path.join(pastaDaSessao, 'notas.txt')],
    ['na pasta que o Antigravity leria como configuração', path.join(pasta, '.agents', 'hooks.json')],
    ['na configuração pessoal do Antigravity', path.join(configuracao, 'hooks.json')],
  ])('a gravação %s é negada sem cartão', async (_caso, alvo) => {
    decisao = 'aprovar';
    cartoes.length = 0;
    const { resultado, recebidas } = await turno(`gravar ${alvo}`);
    expect(cartoes).toHaveLength(0);
    expect(respostas(recebidas)).toContainEqual(NEGOU);
    expect(resultado.texto).toBe('negado');
  });

  it('a leitura na pasta do bot passa sem cartão, e fora dela é negada', async () => {
    decisao = 'aprovar';
    cartoes.length = 0;
    const dentro = await turno(`ler ${path.join(pasta, 'notas.txt')}`);
    expect(dentro.resultado.texto).toBe('leu');
    expect(respostas(dentro.recebidas)).toContainEqual(PERMITIU);
    const fora = await turno(`ler ${path.join(casa, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')}`);
    expect(fora.resultado.texto).toBe('negado');
    expect(respostas(fora.recebidas)).toContainEqual(NEGOU);
    expect(cartoes).toHaveLength(0);
  });

  it.each([
    ['um comando sem a linha', 'sem-linha', 'negado'],
    ['um tipo de ferramenta que o awikabot não conhece', 'estranho', 'negado'],
  ])('%s é negado sem cartão', async (_caso, roteiro, texto) => {
    decisao = 'aprovar';
    cartoes.length = 0;
    const { resultado, recebidas } = await turno(roteiro);
    expect(cartoes).toHaveLength(0);
    expect(respostas(recebidas)).toContainEqual(NEGOU);
    expect(resultado).toMatchObject({ estado: 'completa', texto });
  });

  it('um pedido que só oferece "permitir sempre" é negado: cada ação passa por um cartão', async () => {
    decisao = 'aprovar';
    cartoes.length = 0;
    const { resultado, recebidas } = await turno('para-sempre echo oi');
    expect(cartoes).toHaveLength(0);
    expect(respostas(recebidas)).toContainEqual({ outcome: { outcome: 'cancelled' } });
    expect(resultado.texto).toBe('negado');
  });

  it('um comando que roda sem pedir permissão corta o turno, e a saída dele não chega', async () => {
    cartoes.length = 0;
    const { resultado } = await turno('escapa');
    expect(cartoes).toHaveLength(0);
    expect(resultado.estado).toBe('falhou');
    expect(resultado.texto).toBe('[awikabot] Turno interrompido: o Antigravity usou uma ferramenta do tipo "execute" sem pedir aprovação.');
  });

  it('a busca na web que o gancho nega não corta o turno', async () => {
    const { resultado } = await turno('busca');
    expect(resultado).toMatchObject({ estado: 'completa', texto: 'negado' });
  });

  it('a busca na web que roda, sem o gancho, corta o turno', async () => {
    const { resultado } = await turno('busca-escapa');
    expect(resultado.estado).toBe('falhou');
    expect(resultado.texto).toContain('uma ferramenta do tipo "search" sem pedir aprovação');
    expect(resultado.texto).not.toContain('achei');
  });

  it('um pedido que o awikabot não atende é recusado', async () => {
    const { resultado } = await turno('entrada');
    expect(resultado).toMatchObject({ estado: 'completa', texto: 'sem arquivo' });
  });

  it('parar cancela o turno e guarda o que já chegou', async () => {
    // A parada sai quando o primeiro trecho chega, e não depois de um tempo fixo: num computador
    // lento o processo podia nem ter falado ainda, e o teste reprovava sem o driver ter perdido nada.
    const { resultado, recebidas, trechos } = await turno('lento', { parar: 'no_primeiro_trecho' });
    expect(resultado.estado).toBe('parada');
    expect(trechos.length).toBeGreaterThan(0);
    // O texto guardado é exatamente o que chegou, nem mais nem menos.
    expect(resultado.texto).toBe(trechos.join(''));
    expect(resultado.texto).toMatch(/^(mais )+$/);
    expect(recebido(recebidas, 'session/cancel')).toEqual({ sessionId: resultado.sessao });
  });

  it('parar antes de qualquer trecho encerra o turno como parado, com o texto que chegou até ali', async () => {
    const { resultado, trechos } = await turno('lento', { parar: 'antes_de_qualquer_trecho' });
    expect(resultado.estado).toBe('parada');
    expect(resultado.texto).toBe(trechos.join(''));
  });

  it('a falha de login vira uma resposta que diz só a classe do erro', async () => {
    const { resultado } = await turno('falha');
    expect(resultado).toMatchObject({ estado: 'falhou', texto: 'O Antigravity não respondeu: motor sem login válido.' });
    expect(resultado.sessao).toMatch(/^sessao-/);
  });

  it('sem o binário, o turno falha e diz isso', async () => {
    const { resultado } = await turno('eco oi', { binario: path.join(raiz, 'nao-existe') });
    expect(resultado).toEqual({ estado: 'falhou', texto: 'O Antigravity não iniciou neste servidor.', sessao: null });
  });

  it('o que estiver na pasta da sessão é apagado antes de o Antigravity subir', async () => {
    // É o que um comando aprovado deixaria ali para valer como configuração no turno seguinte.
    mkdirSync(path.join(pastaDaSessao, '.agents'), { recursive: true });
    writeFileSync(path.join(pastaDaSessao, '.agents', 'hooks.json'), '{}');
    writeFileSync(path.join(pastaDaSessao, 'solto.txt'), 'x');
    const { resultado, cwd } = await turno('eco oi', { sessao: 'sessao-antiga' });
    expect(resultado).toEqual({ estado: 'completa', texto: 'oi', sessao: 'sessao-antiga' });
    expect(cwd).toBe(pastaDaSessao);
    expect(readdirSync(pastaDaSessao)).toEqual([]);
    // Nada fora da pasta da sessão foi tocado.
    expect(existsSync(pasta)).toBe(true);
    expect(existsSync(path.join(configuracao, 'hooks.json'))).toBe(true);
  });

  it('com um plugin instalado na configuração pessoal, o turno não começa', async () => {
    mkdirSync(path.join(configuracao, 'plugins', 'plantado'), { recursive: true });
    const { resultado, argv } = await turno('eco oi');
    rmSync(path.join(configuracao, 'plugins'), { recursive: true, force: true });
    expect(argv).toEqual([]);
    expect(resultado).toMatchObject({ estado: 'falhou', texto: '[awikabot] O Antigravity não rodou: há um plugin instalado na configuração do Antigravity.' });
  });

  it('a pasta da sessão não pode ficar dentro de um repositório Git', async () => {
    mkdirSync(path.join(raiz, '.git'));
    const { resultado, argv } = await turno('eco oi');
    rmSync(path.join(raiz, '.git'), { recursive: true, force: true });
    expect(argv).toEqual([]);
    expect(resultado.texto).toBe('[awikabot] O Antigravity não rodou: a pasta da sessão do Antigravity está dentro de um repositório Git.');
    expect(existsSync(pastaDaSessao)).toBe(true);
  });
});

describe('consultasDoPedido', () => {
  it.each([
    ['comando', { kind: 'execute', rawInput: { CommandLine: 'ls -la' } }, [{ ferramenta: 'Bash', entrada: { command: "cd '/pasta/do bot' && ls -la" } }]],
    ['comando sem linha', { kind: 'execute', title: 'ls -la', rawInput: {} }, null],
    ['leitura', { kind: 'read', locations: [{ path: '/a/b.txt' }] }, [{ ferramenta: 'Read', entrada: { file_path: '/a/b.txt' } }]],
    ['leitura sem caminho', { kind: 'read', locations: [] }, null],
    ['leitura com um caminho ilegível', { kind: 'read', locations: [{ path: '/a' }, { linha: 3 }] }, null],
    [
      'gravação',
      { kind: 'edit', content: [{ type: 'diff', path: '/a/b.txt', newText: 'novo' }] },
      [{ ferramenta: 'Write', entrada: { file_path: '/a/b.txt', content: 'novo' } }],
    ],
    [
      'edição de trecho',
      { kind: 'edit', content: [{ type: 'diff', path: '/a/b.txt', oldText: 'x', newText: 'y' }] },
      [{ ferramenta: 'Edit', entrada: { file_path: '/a/b.txt', old_string: 'x', new_string: 'y' } }],
    ],
    ['edição sem o que muda', { kind: 'edit', locations: [{ path: '/a/b.txt' }], content: [] }, null],
    ['edição sem caminho', { kind: 'edit', content: [{ type: 'diff', newText: 'y' }] }, null],
    ['busca na web', { kind: 'search', title: '"x" on Web' }, null],
    ['tipo desconhecido', { kind: 'fetch', rawInput: { Url: 'https://exemplo.test' } }, null],
    ['sem tipo', {}, null],
  ])('%s', (_caso, chamada, esperado) => {
    expect(consultasDoPedido(chamada, '/pasta/do bot')).toEqual(esperado);
  });
});

describe('classificarFalhaDoAntigravity', () => {
  it.each([
    ['Failed to read session 123; retry, or load it with session/load', 'sessão do motor não encontrada'],
    ['Authentication required', 'motor sem login válido'],
    ['modelProvider is set to "gemini" in settings.json, but the GEMINI_API_KEY environment variable is not set.', 'motor sem login válido'],
    ['Resource exhausted: quota exceeded', 'limite de uso do motor'],
    ['Thinking level "high" is not offered for model "GPT-OSS 120B (Medium)"', 'modelo não aceito pelo motor'],
    ['o Antigravity não entrou no modo que pede aprovação', 'motor fora do modo que pede aprovação'],
    ['', 'sem mensagem de erro'],
    ['qualquer outra coisa', 'não classificado'],
  ])('%s', (saida, classe) => {
    expect(classificarFalhaDoAntigravity(saida)).toBe(classe);
  });
});
