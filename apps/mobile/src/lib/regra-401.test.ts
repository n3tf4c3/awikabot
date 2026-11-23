import { describe, expect, it } from 'vitest';
import { criarApi, type Buscar } from './api';
import { ErroApi } from './erros';
import { criarGuardaSessao, lerSessaoGuardada, serializarSessao, type Cofre, type Sessao } from './sessao';

/**
 * A regra do 401 com as peças de verdade ligadas como no app (`src/servicos.ts`): o cliente da API
 * lê a sessão da guarda a cada pedido e avisa a guarda da recusa. Só a rede e o cofre são falsos.
 */

const TOKEN_ANTIGO = 'a'.repeat(43);
const TOKEN_NOVO = 'n'.repeat(43);

function sessao(token: string): Sessao {
  return {
    servidor: 'https://bots.exemplo.com',
    token,
    dispositivo: { id: 'abcdefgh12345678', nome: 'Meu celular', criadoEm: 1 },
  };
}

interface Resposta {
  status: number;
  texto: string;
}

const RECUSA_DO_TOKEN: Resposta = { status: 401, texto: JSON.stringify({ erro: 'nao_autenticado' }) };
const LISTA_VAZIA: Resposta = { status: 200, texto: JSON.stringify({ bots: [] }) };

/**
 * App com a sessão `inicial` já guardada. Cada pedido fica pendente até o teste responder,
 * a não ser que o teste traga a própria rede em `rede`.
 */
async function montar(inicial: Sessao, rede?: Buscar) {
  let guardado: string | null = serializarSessao(inicial);
  const cofre: Cofre = {
    ler: async () => guardado,
    gravar: async (valor) => {
      guardado = valor;
    },
    apagar: async () => {
      guardado = null;
    },
  };
  const pedidos: { token: string | undefined; responder: (resposta: Resposta) => void }[] = [];
  const buscar: Buscar = (_url, pedido) =>
    new Promise((resolver) => {
      pedidos.push({
        token: pedido.headers.authorization?.replace('Bearer ', ''),
        responder: ({ status, texto }) => resolver({ status, text: async () => texto }),
      });
    });

  const guarda = criarGuardaSessao(cofre);
  const api = criarApi({
    buscar: rede ?? buscar,
    sessaoAtual: () => guarda.estado().sessao,
    aoNaoAutenticado: (recusada) => guarda.sairSeAtual(recusada),
  });
  await guarda.carregar();
  return { api, guarda, pedidos, noCofre: () => lerSessaoGuardada(guardado) };
}

async function codigoDoErro(promessa: Promise<unknown>): Promise<string> {
  try {
    await promessa;
  } catch (erro) {
    if (erro instanceof ErroApi) return erro.codigo;
    throw erro;
  }
  throw new Error('a chamada deveria ter falhado');
}

describe('regra do 401 com a API e a guarda de sessão de verdade', () => {
  it('401 nao_autenticado para a sessão atual apaga a sessão da memória e do cofre', async () => {
    const { api, guarda, pedidos, noCofre } = await montar(sessao(TOKEN_ANTIGO));

    const pedido = codigoDoErro(api.listarBots());
    pedidos[0]?.responder(RECUSA_DO_TOKEN);

    expect(await pedido).toBe('nao_autenticado');
    expect(guarda.estado()).toEqual({ fase: 'pronta', sessao: null, desconectado: true });
    expect(noCofre()).toBeNull();
    // Sem sessão, o pedido seguinte nem sai para a rede.
    expect(await codigoDoErro(api.listarBots())).toBe('nao_autenticado');
    expect(pedidos).toHaveLength(1);
  });

  it('401 atrasado de uma sessão antiga não derruba a sessão nova', async () => {
    const { api, guarda, pedidos, noCofre } = await montar(sessao(TOKEN_ANTIGO));

    // O pedido sai com o token antigo e fica sem resposta enquanto a pessoa despareia e pareia de novo.
    const atrasado = codigoDoErro(api.listarBots());
    await guarda.sair();
    await guarda.entrar(sessao(TOKEN_NOVO));
    pedidos[0]?.responder(RECUSA_DO_TOKEN);

    expect(await atrasado).toBe('nao_autenticado');
    expect(pedidos[0]?.token).toBe(TOKEN_ANTIGO);
    expect(guarda.estado()).toEqual({ fase: 'pronta', sessao: sessao(TOKEN_NOVO), desconectado: false });
    expect(noCofre()).toEqual(sessao(TOKEN_NOVO));

    // E a sessão nova segue valendo: o pedido seguinte sai com o token novo.
    const seguinte = api.listarBots();
    pedidos[1]?.responder(LISTA_VAZIA);
    await expect(seguinte).resolves.toEqual({ bots: [] });
    expect(pedidos[1]?.token).toBe(TOKEN_NOVO);
  });

  it.each([
    ['HTML de um proxy', '<html><body>Entre para continuar</body></html>'],
    ['corpo vazio', ''],
    ['outro código do contrato', JSON.stringify({ erro: 'codigo_invalido' })],
  ])('401 com %s não apaga a sessão', async (_caso, texto) => {
    const { api, guarda, pedidos, noCofre } = await montar(sessao(TOKEN_ANTIGO));

    const pedido = codigoDoErro(api.listarBots());
    pedidos[0]?.responder({ status: 401, texto });

    expect(await pedido).not.toBe('nao_autenticado');
    expect(guarda.estado()).toEqual({ fase: 'pronta', sessao: sessao(TOKEN_ANTIGO), desconectado: false });
    expect(noCofre()).toEqual(sessao(TOKEN_ANTIGO));
  });

  it('erro de rede não apaga a sessão', async () => {
    const semRede: Buscar = () => Promise.reject(new TypeError('Network request failed'));
    const { api, guarda, noCofre } = await montar(sessao(TOKEN_ANTIGO), semRede);

    expect(await codigoDoErro(api.listarBots())).toBe('rede');
    expect(guarda.estado().sessao).toEqual(sessao(TOKEN_ANTIGO));
    expect(noCofre()).toEqual(sessao(TOKEN_ANTIGO));
  });
});
