import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ESPERA_APROVACAO_MS, normalizarCodigoPareamento, type Aprovacao } from '@awikabot/core';
import { AvisoPush, CANAL_DE_APROVACOES, type Buscar, type MensagemDeAviso } from './aviso';
import { abrirBanco, type Banco } from './banco';
import { criarBot } from './bots';
import { autenticar, criarCodigo, enderecosDeAviso, gravarEnderecoDeAviso, parear, revogar, revogarTodos } from './dispositivos';

const ENDERECO_A = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const ENDERECO_B = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]';

function montar() {
  const banco = abrirBanco(':memory:');
  const aparelho = (nome: string) => parear(banco, normalizarCodigoPareamento(criarCodigo(banco)), nome)!.dispositivo.id;
  const bot = criarBot(banco, { nome: 'Scout', instrucoes: '', modelo: null });
  return { banco, aparelho, bot };
}

function pedido(botId: string): Aprovacao {
  return {
    id: 'aprovacao0000001',
    botId,
    mensagemId: 'mensagem00000001',
    ferramenta: 'Bash',
    resumo: 'cat /data/segredo && rm -rf build',
    estado: 'pendente',
    criadaEm: 1,
    resolvidaEm: null,
  };
}

/** Um serviço de push de mentira: guarda o que recebeu e responde o que o teste mandar. */
function servico(responder: (mensagens: MensagemDeAviso[]) => Response | Promise<Response>) {
  const recebidos: { endereco: string; pedido: RequestInit; mensagens: MensagemDeAviso[] }[] = [];
  const buscar: Buscar = async (endereco, pedido) => {
    const mensagens = JSON.parse(String(pedido.body)) as MensagemDeAviso[];
    recebidos.push({ endereco, pedido, mensagens });
    return responder(mensagens);
  };
  return { recebidos, buscar };
}

const tudoCerto = (mensagens: MensagemDeAviso[]) => Response.json({ data: mensagens.map((_, i) => ({ status: 'ok', id: `recibo-${i}` })) });

describe('aviso de pedido de aprovação', () => {
  it('avisa cada aparelho com endereço, só com o nome do bot, e nada do pedido', async () => {
    const { banco, aparelho, bot } = montar();
    gravarEnderecoDeAviso(banco, aparelho('Celular'), ENDERECO_A);
    gravarEnderecoDeAviso(banco, aparelho('Tablet'), ENDERECO_B);
    aparelho('Computador, sem endereço');
    const { recebidos, buscar } = servico(tudoCerto);

    expect(await new AvisoPush({ banco, endereco: 'https://servico.teste/push', buscar }).avisarPedido(pedido(bot.id))).toBe(2);

    expect(recebidos).toHaveLength(1);
    expect(recebidos[0]?.endereco).toBe('https://servico.teste/push');
    expect(recebidos[0]?.pedido.method).toBe('POST');
    expect(recebidos[0]?.mensagens).toEqual(
      [ENDERECO_A, ENDERECO_B].map((to) => ({
        to,
        title: 'Scout pede aprovação',
        body: 'Abra o awikabot para ver o pedido e decidir.',
        data: { botId: bot.id },
        sound: 'default',
        priority: 'high',
        channelId: CANAL_DE_APROVACOES,
        ttl: ESPERA_APROVACAO_MS / 1000,
      })),
    );
    // O que vai ao terceiro não leva o pedido: nem a ferramenta, nem o comando, nem o id dele.
    const enviado = String(recebidos[0]?.pedido.body);
    for (const segredo of ['Bash', 'segredo', 'rm -rf', 'aprovacao0000001', 'mensagem00000001']) expect(enviado).not.toContain(segredo);
  });

  it('sem nenhum endereço, não fala com o serviço', async () => {
    const { banco, aparelho, bot } = montar();
    aparelho('Celular');
    const { recebidos, buscar } = servico(tudoCerto);
    expect(await new AvisoPush({ banco, buscar }).avisarPedido(pedido(bot.id))).toBe(0);
    expect(recebidos).toEqual([]);
  });

  it('aparelho revogado não é avisado, nem um a um, nem todos de uma vez', async () => {
    const { banco, aparelho, bot } = montar();
    const celular = aparelho('Celular');
    const tablet = aparelho('Tablet');
    gravarEnderecoDeAviso(banco, celular, ENDERECO_A);
    gravarEnderecoDeAviso(banco, tablet, ENDERECO_B);

    revogar(banco, celular);
    expect(enderecosDeAviso(banco)).toEqual([{ dispositivoId: tablet, endereco: ENDERECO_B }]);
    // Revogado, ele não volta a gravar endereço.
    gravarEnderecoDeAviso(banco, celular, ENDERECO_A);
    expect(enderecosDeAviso(banco).map((destino) => destino.endereco)).toEqual([ENDERECO_B]);

    revogarTodos(banco);
    expect(enderecosDeAviso(banco)).toEqual([]);
    const { recebidos, buscar } = servico(tudoCerto);
    expect(await new AvisoPush({ banco, buscar }).avisarPedido(pedido(bot.id))).toBe(0);
    expect(recebidos).toEqual([]);
  });

  it('o mesmo celular pareado de novo é avisado uma vez só', () => {
    const { banco, aparelho } = montar();
    const antigo = aparelho('Celular');
    const novo = aparelho('Celular, de novo');
    gravarEnderecoDeAviso(banco, antigo, ENDERECO_A);
    gravarEnderecoDeAviso(banco, novo, ENDERECO_A);
    expect(enderecosDeAviso(banco)).toEqual([{ dispositivoId: novo, endereco: ENDERECO_A }]);
    gravarEnderecoDeAviso(banco, novo, null);
    expect(enderecosDeAviso(banco)).toEqual([]);
  });

  it('o endereço que o serviço diz não existir mais é esquecido; os outros ficam', async () => {
    const { banco, aparelho, bot } = montar();
    const celular = aparelho('Celular');
    const tablet = aparelho('Tablet');
    gravarEnderecoDeAviso(banco, celular, ENDERECO_A);
    gravarEnderecoDeAviso(banco, tablet, ENDERECO_B);
    // Os recibos vêm na ordem dos avisos: o do celular diz que o endereço não existe mais.
    const { buscar } = servico((mensagens) =>
      Response.json({
        data: mensagens.map((mensagem) =>
          mensagem.to === ENDERECO_A ? { status: 'error', message: 'não existe', details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: 'x' },
        ),
      }),
    );
    expect(await new AvisoPush({ banco, buscar }).avisarPedido(pedido(bot.id))).toBe(1);
    expect(enderecosDeAviso(banco)).toEqual([{ dispositivoId: tablet, endereco: ENDERECO_B }]);
  });

  it.each([
    ['o serviço fora do ar', () => Promise.reject(new TypeError('fetch failed'))],
    ['o serviço demorando além do prazo', () => new Promise<Response>(() => {})],
    ['uma recusa do serviço', () => new Response('erro', { status: 500 })],
    ['uma resposta que não é JSON', () => new Response('<html>', { status: 200 })],
    ['uma resposta sem a lista de recibos', () => Response.json({ errors: [{ code: 'X' }] })],
  ])('%s não derruba nada e não apaga endereço', async (_caso, responder) => {
    const { banco, aparelho, bot } = montar();
    gravarEnderecoDeAviso(banco, aparelho('Celular'), ENDERECO_A);
    const buscar: Buscar = async (_endereco, pedidoHttp) => {
      const promessa = responder();
      // O prazo de verdade é o do sinal: quem demora é cortado por ele.
      return Promise.race([
        promessa,
        new Promise<Response>((_ok, falha) => pedidoHttp.signal?.addEventListener('abort', () => falha(pedidoHttp.signal?.reason))),
      ]);
    };
    await expect(new AvisoPush({ banco, buscar, prazoMs: 50 }).avisarPedido(pedido(bot.id))).resolves.toBe(0);
    expect(enderecosDeAviso(banco)).toHaveLength(1);
  });

  it('pedido de um bot que já não existe avisa com um nome genérico', async () => {
    const { banco, aparelho } = montar();
    gravarEnderecoDeAviso(banco, aparelho('Celular'), ENDERECO_A);
    const { recebidos, buscar } = servico(tudoCerto);
    await new AvisoPush({ banco, buscar }).avisarPedido(pedido('botbotbotbotbot9'));
    expect(recebidos[0]?.mensagens[0]?.title).toBe('Um bot pede aprovação');
  });
});

describe('banco de antes do endereço de aviso', () => {
  it('ganha a coluna ao abrir, com os aparelhos como estavam e sem endereço', () => {
    const pasta = mkdtempSync(path.join(os.tmpdir(), 'awikabot-aviso-'));
    try {
      const arquivo = path.join(pasta, 'awikabot.db');
      const antigo: Banco = abrirBanco(arquivo, 4);
      const token = parear(antigo, normalizarCodigoPareamento(criarCodigo(antigo)), 'Celular')!;
      antigo.close();

      const banco = abrirBanco(arquivo);
      try {
        expect(autenticar(banco, token.token)?.id).toBe(token.dispositivo.id);
        expect(enderecosDeAviso(banco)).toEqual([]);
        gravarEnderecoDeAviso(banco, token.dispositivo.id, ENDERECO_A);
        expect(enderecosDeAviso(banco)).toEqual([{ dispositivoId: token.dispositivo.id, endereco: ENDERECO_A }]);
      } finally {
        banco.close();
      }
    } finally {
      rmSync(pasta, { recursive: true, force: true });
    }
  });
});
