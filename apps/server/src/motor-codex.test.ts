// O driver do Codex contra um `codex app-server` de mentira (`codex-de-mentira.ts`) e o lado do
// servidor que atende o gancho de verdade (`criarAppDoGancho`), com a política de verdade. Só o
// gestor de aprovações é trocado: aqui ele responde na hora, no lugar da pessoa.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GestorDeAprovacoes } from './aprovacoes';
import { criarAppDoGancho, Ganchos } from './gancho';
import { despacharPorMotor, type PedidoMotor, type ResultadoMotor } from './motor';
import { argumentosDoCodex, classificarFalhaDoCodex, criarMotorCodex, instrucoesDoTurno, ORIENTACAO_DO_AMBIENTE } from './motor-codex';

const MENTIRA = fileURLToPath(new URL('./codex-de-mentira.ts', import.meta.url));
const raiz = mkdtempSync(path.join(os.tmpdir(), 'awika-codex-'));
const pasta = path.join(raiz, 'trabalho', 'bot');
mkdirSync(pasta, { recursive: true });

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

/** Roda um turno e devolve o resultado, os trechos de texto e o que o Codex de mentira recebeu. */
async function turno(
  texto: string,
  opcoes: { sessao?: string | null; semGancho?: boolean; gancho?: { porta: number }; gerenciado?: boolean; binario?: string; parar?: number } = {},
): Promise<{ resultado: ResultadoMotor; trechos: string[]; recebidas: Record<string, unknown>[]; argv: string[] }> {
  rodada += 1;
  const registro = path.join(raiz, `registro-${rodada}.jsonl`);
  const motor = criarMotorCodex({
    binario: opcoes.binario ?? process.execPath,
    prefixo: opcoes.binario ? [] : [MENTIRA],
    ambiente: { ...process.env, CODEX_DE_MENTIRA_REGISTRO: registro } as Record<string, string>,
    configuracaoGerenciada: opcoes.gerenciado ?? false,
    prazoDaParadaMs: 3000,
  });
  const token = ganchos.registrar({ botId: 'bot-1', mensagemId: `msg-${rodada}`, pasta });
  const trechos: string[] = [];
  const pedido: PedidoMotor = {
    motor: 'codex',
    pasta,
    texto,
    instrucoes: 'Responda em português.',
    modelo: 'gpt-6.2-sol',
    esforco: 'high',
    sessao: opcoes.sessao ?? null,
    gancho: opcoes.semGancho ? null : { comando: 'nao-usado', porta: opcoes.gancho?.porta ?? porta, token },
    aoTexto: (trecho) => trechos.push(trecho),
  };
  const emCurso = motor(pedido);
  if (opcoes.parar !== undefined) setTimeout(() => emCurso.parar(), opcoes.parar);
  const resultado = await emCurso.fim;
  ganchos.remover(token);
  let linhas: Record<string, unknown>[] = [];
  try {
    linhas = readFileSync(registro, 'utf8').trim().split('\n').map((linha) => JSON.parse(linha) as Record<string, unknown>);
  } catch {
    // O processo nem subiu.
  }
  const argv = (linhas.find((linha) => 'argv' in linha)?.argv as string[] | undefined) ?? [];
  return { resultado, trechos, recebidas: linhas.filter((linha) => !('argv' in linha)), argv };
}

const recebido = (recebidas: Record<string, unknown>[], metodo: string) =>
  recebidas.find((mensagem) => mensagem.method === metodo)?.params as Record<string, unknown> | undefined;
const respostas = (recebidas: Record<string, unknown>[]) =>
  recebidas.filter((mensagem) => mensagem.method === undefined && 'result' in mensagem).map((mensagem) => mensagem.result);

describe('motor do Codex', () => {
  it('responde aos poucos, numa conversa nova, com o modelo, o esforço e as travas do turno', async () => {
    const { resultado, trechos, recebidas, argv } = await turno('eco olá do Codex');
    expect(resultado).toEqual({ estado: 'completa', texto: 'olá do Codex', sessao: expect.stringMatching(/^thread-/) as string });
    expect(trechos.length).toBeGreaterThanOrEqual(3);
    expect(recebido(recebidas, 'thread/start')).toMatchObject({
      cwd: pasta,
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      developerInstructions: `${ORIENTACAO_DO_AMBIENTE}\n\nResponda em português.`,
      model: 'gpt-6.2-sol',
    });
    expect(recebido(recebidas, 'turn/start')).toMatchObject({
      input: [{ type: 'text', text: 'eco olá do Codex' }],
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      model: 'gpt-6.2-sol',
      effort: 'high',
    });
    // Fora da imagem, a configuração vai em opções; o texto da pessoa nunca vai na linha de comando.
    expect(argv).toEqual(argumentosDoCodex(false));
    expect(argv).toContain('--config=web_search="disabled"');
    expect(argv).toContain('--config=features.apps=false');
    expect(argv.every((opcao) => opcao === 'app-server' || opcao.startsWith('--'))).toBe(true);
    expect(argv.join(' ')).not.toContain('olá');
  });

  it('na imagem, a configuração não vai na linha de comando', async () => {
    const { argv } = await turno('eco oi', { gerenciado: true });
    expect(argv).toEqual(['app-server', '--listen=stdio://']);
  });

  it('retoma a conversa do bot', async () => {
    const { resultado, recebidas } = await turno('eco de volta', { sessao: 'thread-antiga' });
    expect(recebido(recebidas, 'thread/start')).toBeUndefined();
    expect(recebido(recebidas, 'thread/resume')).toMatchObject({ threadId: 'thread-antiga', cwd: pasta, sandbox: 'read-only', approvalsReviewer: 'user' });
    expect(resultado).toMatchObject({ estado: 'completa', sessao: 'thread-antiga' });
  });

  it('uma sessão que o Codex não acha vira falha, e o bot recomeça a conversa no turno seguinte', async () => {
    const { resultado } = await turno('eco oi', { sessao: 'sumiu' });
    expect(resultado).toEqual({ estado: 'falhou', texto: 'O Codex não respondeu: sessão do motor não encontrada.', sessao: null });
  });

  it('o comando aprovado na pessoa roda, com o comando inteiro no cartão', async () => {
    decisao = 'aprovar';
    cartoes.length = 0;
    const { resultado, recebidas } = await turno('comando echo awika-ok > aprovado.txt');
    expect(cartoes).toHaveLength(1);
    expect(cartoes[0]).toMatchObject({ botId: 'bot-1', ferramenta: 'Bash', resumo: "/bin/bash -lc 'echo awika-ok > aprovado.txt'" });
    expect(respostas(recebidas)).toEqual([{ decision: 'accept' }]);
    expect(resultado).toMatchObject({ estado: 'completa', texto: 'rodou' });
  });

  it('o comando negado pela pessoa não roda', async () => {
    decisao = 'negar';
    const { resultado, recebidas } = await turno('comando rm -rf tudo');
    expect(respostas(recebidas)).toEqual([{ decision: 'decline' }]);
    expect(resultado.texto).toBe('negado');
  });

  it.each([
    ['sem gancho', { semGancho: true }],
    ['com o servidor de aprovação fora do ar', { gancho: { porta: 1 } }],
  ])('%s, o comando é negado sem cartão', async (_caso, opcoes) => {
    decisao = 'aprovar';
    cartoes.length = 0;
    const { resultado, recebidas } = await turno('comando echo oi', opcoes);
    expect(cartoes).toHaveLength(0);
    expect(respostas(recebidas)).toEqual([{ decision: 'decline' }]);
    expect(resultado.texto).toBe('negado');
  });

  it('a edição na pasta do bot vai ao cartão com o conteúdo', async () => {
    decisao = 'aprovar';
    cartoes.length = 0;
    const alvo = path.join(pasta, 'notas.txt');
    const { resultado } = await turno(`edicao ${alvo}`);
    expect(cartoes).toHaveLength(1);
    expect(cartoes[0]).toMatchObject({ ferramenta: 'Write', resumo: `Gravar o arquivo ${alvo}\n\nconteúdo novo\n` });
    expect(resultado.texto).toBe('gravou');
  });

  it.each([
    ['fora da pasta do bot', `edicao ${path.join(raiz, 'fora.txt')}`],
    ['na configuração do Codex', `edicao ${path.join(pasta, '.codex', 'config.toml')}`],
    ['movendo para fora da pasta', `mover ${path.join(pasta, 'a.txt')} ${path.join(raiz, 'b.txt')}`],
  ])('a edição %s é negada sem cartão', async (_caso, texto) => {
    decisao = 'aprovar';
    cartoes.length = 0;
    const { resultado, recebidas } = await turno(texto);
    expect(cartoes).toHaveLength(0);
    expect(respostas(recebidas)).toEqual([{ decision: 'decline' }]);
    expect(resultado.texto).toBe('negado');
  });

  it('um comando que roda sem pedir aprovação corta o turno, e a saída dele não chega', async () => {
    const { resultado } = await turno('escapa');
    expect(resultado.estado).toBe('falhou');
    expect(resultado.texto).toBe('[awikabot] Turno interrompido: o Codex executou um comando sem pedir aprovação.');
  });

  it('a busca na web, que não passa por aprovação, corta o turno', async () => {
    const { resultado } = await turno('busca');
    expect(resultado.estado).toBe('falhou');
    expect(resultado.texto).toContain('o Codex tentou usar "webSearch"');
    expect(resultado.texto).not.toContain('achei');
  });

  it('um pedido que o awikabot não atende é recusado', async () => {
    const { resultado } = await turno('entrada');
    expect(resultado).toMatchObject({ estado: 'completa', texto: 'sem entrada' });
  });

  it('parar interrompe o turno e guarda o que já chegou', async () => {
    const { resultado, recebidas } = await turno('lento', { parar: 300 });
    expect(resultado.estado).toBe('parada');
    expect(resultado.texto).toMatch(/^(mais )+$/);
    expect(recebido(recebidas, 'turn/interrupt')).toMatchObject({ threadId: resultado.sessao });
  });

  it('a falha de login vira uma resposta que diz só a classe do erro', async () => {
    const { resultado } = await turno('falha');
    expect(resultado).toMatchObject({ estado: 'falhou', texto: 'O Codex não respondeu: motor sem login válido.' });
    expect(resultado.sessao).toMatch(/^thread-/);
  });

  it('sem o binário, o turno falha e diz isso', async () => {
    const { resultado } = await turno('eco oi', { binario: path.join(raiz, 'nao-existe') });
    expect(resultado).toEqual({ estado: 'falhou', texto: 'O Codex não iniciou neste servidor.', sessao: null });
  });
});

describe('instrucoesDoTurno', () => {
  it('põe a orientação do ambiente antes das instruções do bot, e só ela quando o bot não tem', () => {
    expect(instrucoesDoTurno('')).toBe(ORIENTACAO_DO_AMBIENTE);
    expect(instrucoesDoTurno('Seja breve.')).toBe(`${ORIENTACAO_DO_AMBIENTE}\n\nSeja breve.`);
    expect(ORIENTACAO_DO_AMBIENTE).toContain('require_escalated');
  });
});

describe('classificarFalhaDoCodex', () => {
  it.each([
    ['no rollout found for thread id x', 'sessão do motor não encontrada'],
    ['You are not logged in. Run codex login.', 'motor sem login válido'],
    ['unexpected status 401 Unauthorized', 'motor sem login válido'],
    ["You've hit your usage limit", 'limite de uso do motor'],
    ['The model gpt-9 does not exist', 'modelo não aceito pelo motor'],
    ['algo inesperado', 'não classificado'],
    ['unknown model gpt-9', 'modelo não aceito pelo motor'],
    ['', 'sem mensagem de erro'],
  ])('"%s" vira "%s"', (saida, classe) => {
    expect(classificarFalhaDoCodex(saida)).toBe(classe);
  });
});

describe('despacharPorMotor', () => {
  it('entrega o turno ao motor do bot, e responde com falha ao motor que o servidor não roda', async () => {
    const vistos: string[] = [];
    const motor = despacharPorMotor({
      codex: (pedido) => {
        vistos.push(pedido.motor);
        return { parar: () => {}, fim: Promise.resolve({ estado: 'completa', texto: 'ok', sessao: null }) };
      },
    });
    const base = { pasta, texto: 'oi', instrucoes: '', modelo: null, esforco: null, sessao: 's', gancho: null, aoTexto: () => {} };
    expect(await motor({ ...base, motor: 'codex' }).fim).toMatchObject({ estado: 'completa' });
    const trechos: string[] = [];
    const ausente = await motor({ ...base, motor: 'antigravity', aoTexto: (trecho) => trechos.push(trecho) }).fim;
    expect(ausente).toEqual({ estado: 'falhou', texto: 'Este servidor não roda o motor "antigravity".', sessao: 's' });
    expect(trechos).toEqual([ausente.texto]);
    expect(await motor({ ...base, motor: 'constructor' }).fim).toMatchObject({ estado: 'falhou' });
    expect(vistos).toEqual(['codex']);
  });
});
