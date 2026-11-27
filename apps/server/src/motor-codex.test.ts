// O driver do Codex contra um `codex app-server` de mentira (`codex-de-mentira.ts`) e o lado do
// servidor que atende o gancho de verdade (`criarAppDoGancho`), com a política de verdade. Só o
// gestor de aprovações é trocado: aqui ele responde na hora, no lugar da pessoa.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GestorDeAprovacoes } from './aprovacoes';
import { criarAppDoGancho, Ganchos } from './gancho';
import { despacharPorMotor, type PedidoMotor, type ResultadoMotor } from './motor';
import {
  agiuSemPedido,
  argumentosDoCodex,
  classificarFalhaDoCodex,
  criarMotorCodex,
  instrucoesDoTurno,
  ORIENTACAO_DO_AMBIENTE,
  prepararCasaDoCodex,
  SAIDA_DA_CAIXA_QUE_NAO_SOBE,
} from './motor-codex';

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
  opcoes: {
    sessao?: string | null;
    semGancho?: boolean;
    gancho?: { porta: number };
    gerenciado?: boolean;
    binario?: string;
    parar?: number;
    /** Como a caixa de areia responde à prova da partida; sem isto, como na imagem: não sobe. */
    caixa?: 'sobe' | 'outra';
  } = {},
): Promise<{ resultado: ResultadoMotor; trechos: string[]; recebidas: Record<string, unknown>[]; argv: string[]; prova: string[] | undefined }> {
  rodada += 1;
  const registro = path.join(raiz, `registro-${rodada}.jsonl`);
  const motor = criarMotorCodex({
    binario: opcoes.binario ?? process.execPath,
    prefixo: opcoes.binario ? [] : [MENTIRA],
    ambiente: {
      ...process.env,
      CODEX_DE_MENTIRA_REGISTRO: registro,
      ...(opcoes.caixa ? { CODEX_DE_MENTIRA_CAIXA: opcoes.caixa } : {}),
    } as Record<string, string>,
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
  const prova = linhas.find((linha) => 'sandbox' in linha)?.sandbox as string[] | undefined;
  return { resultado, trechos, recebidas: linhas.filter((linha) => !('argv' in linha) && !('sandbox' in linha)), argv, prova };
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

  it.each([
    ['um comando que termina bem', 'escapa', 'um comando'],
    ['um comando que sai com erro depois de ler', 'escapa-falha', 'um comando'],
    ['um comando que imita a caixa de areia que não sobe, com o que leu', 'escapa-imita', 'um comando'],
    ['uma edição que falha no meio', 'escapa-edicao', 'uma edição'],
  ])('%s, sem pedir aprovação, corta o turno, e a saída dele não chega', async (_caso, roteiro, acao) => {
    cartoes.length = 0;
    const { resultado } = await turno(roteiro);
    expect(cartoes).toHaveLength(0);
    expect(resultado).toEqual({ estado: 'falhou', texto: `[awikabot] Turno interrompido: o Codex executou ${acao} sem pedir aprovação.`, sessao: null });
  });

  it.each([
    ['numa conversa nova', null],
    ['numa conversa retomada', 'thread-antiga'],
  ])('o turno cortado %s não deixa sessão para retomar: o que rodou sem pedido pode estar nela', async (_caso, sessao) => {
    const { resultado, recebidas } = await turno('escapa', { sessao });
    expect(recebido(recebidas, sessao === null ? 'thread/start' : 'thread/resume')).toBeDefined();
    expect(resultado).toMatchObject({ estado: 'falhou', sessao: null });
  });

  it('o turno cortado por usar o que não tem cartão também não deixa sessão', async () => {
    const { resultado } = await turno('busca', { sessao: 'thread-antiga' });
    expect(resultado).toMatchObject({ estado: 'falhou', sessao: null });
  });

  it('a tentativa que a caixa de areia não deixou começar não corta o turno, e o pedido seguinte vai ao cartão', async () => {
    decisao = 'aprovar';
    cartoes.length = 0;
    const { resultado, recebidas } = await turno('caixa-nao-sobe ls');
    expect(cartoes).toHaveLength(1);
    expect(cartoes[0]).toMatchObject({ ferramenta: 'Bash', resumo: "/bin/bash -lc 'ls'" });
    expect(respostas(recebidas)).toEqual([{ decision: 'accept' }]);
    expect(resultado).toMatchObject({ estado: 'completa', texto: 'rodou' });
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

  it('sem o binário, o Codex fica desligado na partida e o turno diz isso', async () => {
    const { resultado } = await turno('eco oi', { binario: path.join(raiz, 'nao-existe') });
    expect(resultado).toEqual({ estado: 'falhou', texto: 'O Codex está desligado neste servidor: ele não iniciou.', sessao: null });
  });
});

// Com a caixa de areia de pé, o Codex roda sem pedido os comandos que só leem, em todo o disco, e o
// corte chega depois. Na partida, o driver roda um comando nela pelo `codex sandbox`.
describe('caixa de areia na partida', () => {
  it('como na imagem, a caixa de areia não sobe e o Codex fica ligado; a prova roda com a configuração dos turnos', async () => {
    const fora = await turno('eco oi');
    expect(fora.resultado).toMatchObject({ estado: 'completa', texto: 'oi' });
    expect(fora.prova?.slice(0, 2)).toEqual(['sandbox', '--config=approval_policy="on-request"']);
    expect(fora.prova).toContain('--config=sandbox_mode="read-only"');
    expect(fora.prova?.slice(fora.prova.indexOf('--'), -1)).toEqual(['--', process.execPath, '-e']);

    // Na imagem, a configuração está em /etc/codex e não vai na linha de comando, também na prova.
    const naImagem = await turno('eco oi', { gerenciado: true });
    expect(naImagem.resultado).toMatchObject({ estado: 'completa' });
    expect(naImagem.prova?.slice(0, 2)).toEqual(['sandbox', '--']);
  });

  it.each([
    ['sobe, como fora do contêiner', 'sobe', 'a caixa de areia dele sobe aqui, e os comandos que só leem rodariam sem aprovação'],
    ['falha com outra saída', 'outra', 'não deu para confirmar que a caixa de areia dele não sobe aqui'],
  ] as const)('se a caixa de areia %s, o Codex fica desligado: nenhum turno sobe o processo, e a sessão do bot fica', async (_caso, caixa, motivo) => {
    cartoes.length = 0;
    const { resultado, trechos, recebidas, argv } = await turno('escapa', { caixa, sessao: 'thread-antiga' });
    expect(resultado).toEqual({ estado: 'falhou', texto: `O Codex está desligado neste servidor: ${motivo}.`, sessao: 'thread-antiga' });
    expect(trechos).toEqual([resultado.texto]);
    expect(argv).toEqual([]);
    expect(recebidas).toEqual([]);
    expect(cartoes).toHaveLength(0);
  });
});

describe('agiuSemPedido', () => {
  const comando = { type: 'commandExecution', id: 'c' };
  it.each([
    ['comando que terminou bem', { ...comando, status: 'completed', exitCode: 0, aggregatedOutput: 'x' }, true],
    ['comando que falhou depois de rodar', { ...comando, status: 'failed', exitCode: 3, aggregatedOutput: 'lido\n' }, true],
    ['comando que falhou sem código', { ...comando, status: 'failed', exitCode: null, aggregatedOutput: null }, true],
    ['saída da caixa de areia com outro código', { ...comando, status: 'failed', exitCode: 2, aggregatedOutput: SAIDA_DA_CAIXA_QUE_NAO_SOBE }, true],
    ['saída da caixa de areia com algo a mais', { ...comando, status: 'failed', exitCode: 1, aggregatedOutput: `${SAIDA_DA_CAIXA_QUE_NAO_SOBE}lido\n` }, true],
    ['estado desconhecido', { ...comando, status: 'inProgress' }, true],
    ['edição que falhou', { type: 'fileChange', id: 'e', status: 'failed' }, true],
    ['edição com a saída da caixa de areia', { type: 'fileChange', id: 'e', status: 'failed', exitCode: 1, aggregatedOutput: SAIDA_DA_CAIXA_QUE_NAO_SOBE }, true],
    ['comando recusado', { ...comando, status: 'declined' }, false],
    ['edição recusada', { type: 'fileChange', id: 'e', status: 'declined' }, false],
    ['comando que a caixa de areia não deixou começar', { ...comando, status: 'failed', exitCode: 1, aggregatedOutput: SAIDA_DA_CAIXA_QUE_NAO_SOBE }, false],
  ])('%s', (_caso, item, agiu) => {
    expect(agiuSemPedido(item)).toBe(agiu);
  });
});

describe('prepararCasaDoCodex', () => {
  it('cria a pasta do Codex que falta, só para o dono, e não mexe sem CODEX_HOME', () => {
    const casa = path.join(raiz, 'volume-antigo', 'codex');
    expect(existsSync(casa)).toBe(false);
    prepararCasaDoCodex({ PATH: '/usr/bin' });
    expect(existsSync(casa)).toBe(false);
    criarMotorCodex({ binario: 'nao-usado', ambiente: { CODEX_HOME: casa }, configuracaoGerenciada: true });
    expect(statSync(casa).isDirectory()).toBe(true);
    if (process.platform !== 'win32') expect(statSync(casa).mode & 0o777).toBe(0o700);
    // De novo, com a pasta já lá, não falha.
    prepararCasaDoCodex({ CODEX_HOME: casa });
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
