import { describe, expect, it, vi } from 'vitest';
import { botDoAviso, prepararAviso, type Permissao, type RecursosDoAviso } from './aviso-push';

const ENDERECO = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';

function recursos(extra: Partial<RecursosDoAviso> & { inicial?: Permissao; resposta?: Permissao } = {}) {
  const { inicial = 'granted', resposta = 'granted', ...resto } = extra;
  const ordem: string[] = [];
  const montados: RecursosDoAviso = {
    projetoExpo: 'projeto-de-teste',
    ehAparelho: true,
    preparar: vi.fn(async () => {
      ordem.push('preparar');
    }),
    permissao: vi.fn(async () => {
      ordem.push('permissao');
      return inicial;
    }),
    pedirPermissao: vi.fn(async () => {
      ordem.push('pedirPermissao');
      return resposta;
    }),
    obterEndereco: vi.fn(async () => {
      ordem.push('obterEndereco');
      return ENDERECO;
    }),
    registrar: vi.fn(async () => {
      ordem.push('registrar');
    }),
    ...resto,
  };
  return { montados, ordem };
}

describe('prepararAviso', () => {
  it('com permissão, pega o endereço com o projeto do app e o entrega ao servidor', async () => {
    const { montados, ordem } = recursos();
    await expect(prepararAviso(montados)).resolves.toBe('registrado');
    expect(ordem).toEqual(['preparar', 'permissao', 'obterEndereco', 'registrar']);
    expect(montados.obterEndereco).toHaveBeenCalledWith('projeto-de-teste');
    expect(montados.registrar).toHaveBeenCalledWith(ENDERECO);
  });

  it('pergunta a quem ainda não respondeu, e registra se a pessoa deixar', async () => {
    const { montados, ordem } = recursos({ inicial: 'undetermined', resposta: 'granted' });
    await expect(prepararAviso(montados)).resolves.toBe('registrado');
    expect(ordem).toEqual(['preparar', 'permissao', 'pedirPermissao', 'obterEndereco', 'registrar']);
  });

  it.each([
    ['a pessoa diz não na pergunta', 'undetermined', 'denied', ['preparar', 'permissao', 'pedirPermissao']],
    ['a pessoa já tinha dito não: não pergunta de novo', 'denied', 'granted', ['preparar', 'permissao']],
  ] as const)('%s', async (_caso, inicial, resposta, esperado) => {
    const { montados, ordem } = recursos({ inicial, resposta });
    await expect(prepararAviso(montados)).resolves.toBe('sem_permissao');
    expect(ordem).toEqual(esperado);
    expect(montados.registrar).not.toHaveBeenCalled();
  });

  it('app sem projeto na conta Expo não pede nada nem fala com o servidor', async () => {
    const { montados, ordem } = recursos({ projetoExpo: null });
    await expect(prepararAviso(montados)).resolves.toBe('sem_projeto');
    expect(ordem).toEqual([]);
  });

  it('simulador não pede nada nem fala com o servidor', async () => {
    const { montados, ordem } = recursos({ ehAparelho: false });
    await expect(prepararAviso(montados)).resolves.toBe('sem_aparelho');
    expect(ordem).toEqual([]);
  });

  it.each([
    ['o serviço de push não dá o endereço', { obterEndereco: async () => Promise.reject(new Error('sem rede')) }],
    ['o servidor não guarda o endereço', { registrar: async () => Promise.reject(new Error('sem rede')) }],
    ['a permissão não pode ser lida', { permissao: async () => Promise.reject(new Error('módulo ausente')) }],
  ])('%s: não rejeita, e diz que falhou', async (_caso, extra) => {
    const { montados } = recursos(extra);
    await expect(prepararAviso(montados)).resolves.toBe('falhou');
  });

  it('endereço fora do formato não vai ao servidor', async () => {
    const { montados } = recursos({ obterEndereco: async () => 'https://outro.lugar/qualquer-coisa' });
    await expect(prepararAviso(montados)).resolves.toBe('falhou');
    expect(montados.registrar).not.toHaveBeenCalled();
  });
});

describe('botDoAviso', () => {
  it('lê o bot que o servidor mandou no aviso', () => {
    expect(botDoAviso({ botId: 'abcdefgh12345678' })).toBe('abcdefgh12345678');
  });

  it.each([
    ['sem dados', undefined],
    ['dados que não são objeto', 'abcdefgh12345678'],
    ['sem o bot', { outro: 1 }],
    ['um bot fora do formato', { botId: '../parear' }],
    ['um bot que não é texto', { botId: 12345678 }],
  ])('%s: não abre conversa nenhuma', (_caso, dados) => {
    expect(botDoAviso(dados)).toBeNull();
  });
});
