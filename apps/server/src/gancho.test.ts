// O lado do gancho que o motor executa: qualquer coisa fora do esperado tem de virar "negar".
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { configuracaoGerenciada, configuracaoPorOpcao, gerenciadaInstalada, PRAZO_DO_GANCHO_S } from './configuracao-motor';
import { executarGancho, PRAZO_DO_PEDIDO_MS } from './gancho';
import { classificarFalha, prepararChamada } from './motor-claude-code';

const servidores: Server[] = [];
afterEach(async () => {
  for (const servidor of servidores.splice(0)) {
    servidor.closeAllConnections();
    await new Promise<void>((fim) => servidor.close(() => fim()));
  }
});

async function subir(tratar: Parameters<typeof createServer>[1]): Promise<number> {
  const servidor = createServer(tratar);
  servidores.push(servidor);
  await new Promise<void>((pronto) => servidor.listen(0, '127.0.0.1', () => pronto()));
  return (servidor.address() as AddressInfo).port;
}

async function rodar(configuracao: { porta: number; token: string } | null, prazoMs = 2000) {
  const saidas: string[] = [];
  await executarGancho(configuracao, { prazoMs, escrever: (saida) => saidas.push(saida), lerEntrada: () => '{"tool_name":"Bash"}' });
  expect(saidas).toHaveLength(1);
  const { hookSpecificOutput: resposta } = JSON.parse(saidas[0] ?? '{}') as {
    hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
  };
  expect(resposta.hookEventName).toBe('PreToolUse');
  return { decisao: resposta.permissionDecision, motivo: resposta.permissionDecisionReason };
}

describe('gancho executado pelo motor', () => {
  it('repassa a decisão de permitir, com o token do turno', async () => {
    let tokenRecebido: string | undefined;
    const porta = await subir((pedido, resposta) => {
      tokenRecebido = String(pedido.headers['x-awika-turno']);
      resposta.end(JSON.stringify({ decisao: 'allow', motivo: 'aprovado pela pessoa' }));
    });
    expect(await rodar({ porta, token: 'token-do-turno' })).toEqual({ decisao: 'allow', motivo: 'aprovado pela pessoa' });
    expect(tokenRecebido).toBe('token-do-turno');
  });

  it('nega sem configuração', async () => {
    expect(await rodar(null)).toEqual({ decisao: 'deny', motivo: 'gancho sem configuração' });
  });

  it('nega quando não há servidor na porta', async () => {
    const porta = await subir(() => {});
    servidores[0]?.close();
    expect((await rodar({ porta, token: 'x' })).decisao).toBe('deny');
  });

  it.each([
    ['uma resposta que não é JSON', 'isto não é JSON'],
    ['uma decisão desconhecida', JSON.stringify({ decisao: 'talvez' })],
    ['um corpo vazio', ''],
  ])('nega diante de %s', async (_caso, corpo) => {
    const porta = await subir((_pedido, resposta) => resposta.end(corpo));
    expect((await rodar({ porta, token: 'x' })).decisao).toBe('deny');
  });

  it('nega por conta própria quando o servidor aceita o pedido e nunca responde', async () => {
    const porta = await subir(() => {
      // Servidor travado: recebe e fica em silêncio.
    });
    const inicio = Date.now();
    expect(await rodar({ porta, token: 'x' }, 150)).toEqual({ decisao: 'deny', motivo: 'servidor de aprovação não respondeu a tempo' });
    expect(Date.now() - inicio).toBeLessThan(1500);
  });

  it('desiste antes de o motor cortar o gancho', () => {
    // Um gancho cortado pelo motor não bloqueia a ferramenta: o gancho precisa negar primeiro.
    expect(PRAZO_DO_PEDIDO_MS).toBeLessThan(PRAZO_DO_GANCHO_S * 1000);
  });
});

describe('configuração do motor', () => {
  const pasta = mkdtempSync(path.join(os.tmpdir(), 'awikabot-config-motor-'));
  afterAll(() => {
    rmSync(pasta, { recursive: true, force: true });
  });
  const comando = '"/usr/local/bin/node" "/app/server.mjs" gancho';

  it('a gerenciada leva o gancho em toda ferramenta e bloqueia ganchos de outras origens', () => {
    expect(configuracaoGerenciada(comando)).toEqual({
      allowManagedHooksOnly: true,
      hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: comando, timeout: PRAZO_DO_GANCHO_S }] }] },
    });
  });

  it('só dá a instalação por boa quando o arquivo é exatamente o esperado', () => {
    const arquivo = path.join(pasta, 'managed-settings.json');
    expect(gerenciadaInstalada(comando, arquivo)).toBe(false);

    writeFileSync(arquivo, JSON.stringify(configuracaoGerenciada(comando), null, 2));
    expect(gerenciadaInstalada(comando, arquivo)).toBe(true);
    expect(gerenciadaInstalada('"node" "outro.mjs" gancho', arquivo)).toBe(false);

    writeFileSync(arquivo, JSON.stringify({ ...configuracaoGerenciada(comando), allowManagedHooksOnly: false }));
    expect(gerenciadaInstalada(comando, arquivo)).toBe(false);
    writeFileSync(arquivo, JSON.stringify(configuracaoPorOpcao(comando)));
    expect(gerenciadaInstalada(comando, arquivo)).toBe(false);
    writeFileSync(arquivo, 'não é JSON');
    expect(gerenciadaInstalada(comando, arquivo)).toBe(false);
  });
});

describe('chamada do motor', () => {
  const gancho = { comando: 'node server.mjs gancho', porta: 8791, token: 'token-do-turno' };
  const pedido = { instrucoes: 'Seja breve.', modelo: 'claude-opus-5-5', esforco: 'high', sessao: 'sessao-1', gancho };

  it('nunca lê a configuração deixada na pasta do bot', () => {
    for (const ganchoGerenciado of [true, false]) {
      expect(prepararChamada(pedido, { ambiente: {}, ganchoGerenciado }).args).toContain('--setting-sources=user');
    }
  });

  it('fora da imagem, leva o gancho na linha de comando', () => {
    const { args } = prepararChamada(pedido, { ambiente: {}, ganchoGerenciado: false });
    expect(args).toContain(`--settings=${JSON.stringify(configuracaoPorOpcao(gancho.comando))}`);
  });

  it('na imagem, o gancho é o gerenciado e não vai na linha de comando', () => {
    const { args } = prepararChamada(pedido, { ambiente: {}, ganchoGerenciado: true });
    expect(args.some((arg) => arg.startsWith('--settings='))).toBe(false);
  });

  it('entrega ao gancho a porta e o token deste turno, por cima do que vier do ambiente', () => {
    const { ambiente } = prepararChamada(pedido, { ambiente: { PATH: '/usr/bin', AWIKA_TURNO_TOKEN: 'velho' }, ganchoGerenciado: true });
    expect(ambiente).toEqual({ PATH: '/usr/bin', AWIKA_PORTA_GANCHO: '8791', AWIKA_TURNO_TOKEN: 'token-do-turno' });
  });

  it('toda opção vai na forma nome=valor', () => {
    const { args } = prepararChamada(pedido, { ambiente: {}, ganchoGerenciado: false });
    expect(args.filter((arg) => arg !== '-p' && !/^--[a-z-]+(=|$)/.test(arg))).toEqual([]);
    expect(args).toContain('--append-system-prompt=Seja breve.');
    expect(args).toContain('--resume=sessao-1');
    expect(args).toContain('--effort=high');
  });

  it('o turno de bot não tira ferramentas nem prende a resposta a um esquema', () => {
    const { args } = prepararChamada(pedido, { ambiente: {}, ganchoGerenciado: true });
    expect(args.some((arg) => arg.startsWith('--tools') || arg.startsWith('--json-schema') || arg === '--strict-mcp-config')).toBe(false);
  });

  it('o turno de decisão roda sem ferramentas nem servidor MCP, com a resposta presa ao esquema', () => {
    const esquema = { type: 'object', properties: { resposta: { type: 'boolean' } } };
    const { args } = prepararChamada({ ...pedido, saida: { esquema } }, { ambiente: {}, ganchoGerenciado: true });
    expect(args).toEqual(expect.arrayContaining(['--tools=', '--strict-mcp-config', `--json-schema=${JSON.stringify(esquema)}`, '--setting-sources=user']));
    expect(args.filter((arg) => arg !== '-p' && !/^--[a-z-]+(=|$)/.test(arg))).toEqual([]);
  });

  it('sem modelo nem esforço, deixa o padrão do motor', () => {
    const { args } = prepararChamada({ ...pedido, modelo: null, esforco: null }, { ambiente: {}, ganchoGerenciado: true });
    expect(args.some((arg) => arg.startsWith('--model') || arg.startsWith('--effort'))).toBe(false);
  });
});

describe('classificação da falha do motor para o log', () => {
  it.each([
    ['No conversation found with session ID: abc', 'sessão do motor não encontrada'],
    ['Invalid API key · Please run /login', 'motor sem login válido'],
    ['Claude usage limit reached. Your limit will reset at 3pm', 'limite de uso do motor'],
    ['', 'sem saída de erro'],
    ['a pessoa escreveu: minha senha é 1234', 'não classificado'],
  ])('%s', (saida, classe) => {
    expect(classificarFalha(saida)).toBe(classe);
  });
});
