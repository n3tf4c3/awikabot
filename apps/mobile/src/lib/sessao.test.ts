import { describe, expect, it, vi } from 'vitest';
import {
  criarGuardaSessao,
  lerSessaoGuardada,
  mesmaSessao,
  serializarSessao,
  type Cofre,
  type Sessao,
} from './sessao';

const TOKEN_A = 'a'.repeat(43);
const TOKEN_B = 'b'.repeat(43);

function sessao(token = TOKEN_A, servidor = 'https://bots.exemplo.com'): Sessao {
  return { servidor, token, dispositivo: { id: 'abcdefgh12345678', nome: 'Meu celular', criadoEm: 1_700_000_000_000 } };
}

function cofreEmMemoria(inicial: string | null = null) {
  let valor = inicial;
  const cofre: Cofre = {
    ler: vi.fn(async () => valor),
    gravar: vi.fn(async (novo: string) => {
      valor = novo;
    }),
    apagar: vi.fn(async () => {
      valor = null;
    }),
  };
  return { cofre, valor: () => valor };
}

describe('lerSessaoGuardada', () => {
  it('lê de volta o que serializarSessao gravou', () => {
    expect(lerSessaoGuardada(serializarSessao(sessao()))).toEqual(sessao());
  });

  it.each([
    ['nada guardado', null],
    ['texto vazio', ''],
    ['JSON quebrado', '{"servidor":'],
    ['JSON que não é objeto', '"texto"'],
    ['sem servidor', JSON.stringify({ token: TOKEN_A, dispositivo: sessao().dispositivo })],
    ['servidor em http público', serializarSessao(sessao(TOKEN_A, 'http://bots.exemplo.com'))],
    ['servidor não normalizado', serializarSessao(sessao(TOKEN_A, 'https://bots.exemplo.com/'))],
    ['token curto', serializarSessao(sessao('curto'))],
    ['dispositivo fora do contrato', JSON.stringify({ ...sessao(), dispositivo: { id: 'x', nome: '', criadoEm: -1 } })],
  ])('devolve null para %s', (_caso, texto) => {
    expect(lerSessaoGuardada(texto)).toBeNull();
  });
});

describe('mesmaSessao', () => {
  it('compara servidor e token', () => {
    expect(mesmaSessao(sessao(), sessao())).toBe(true);
    expect(mesmaSessao(sessao(TOKEN_A), sessao(TOKEN_B))).toBe(false);
    expect(mesmaSessao(sessao(TOKEN_A), sessao(TOKEN_A, 'https://outro.exemplo.com'))).toBe(false);
    expect(mesmaSessao(null, null)).toBe(true);
    expect(mesmaSessao(sessao(), null)).toBe(false);
  });
});

describe('criarGuardaSessao', () => {
  it('começa carregando e fica pronta sem sessão quando o cofre está vazio', async () => {
    const guarda = criarGuardaSessao(cofreEmMemoria().cofre);
    expect(guarda.estado()).toEqual({ fase: 'carregando', sessao: null, desconectado: false });
    await guarda.carregar();
    expect(guarda.estado()).toEqual({ fase: 'pronta', sessao: null, desconectado: false });
  });

  it('carrega a sessão guardada', async () => {
    const guarda = criarGuardaSessao(cofreEmMemoria(serializarSessao(sessao())).cofre);
    await guarda.carregar();
    expect(guarda.estado().sessao).toEqual(sessao());
  });

  it('fica sem sessão quando o cofre falha na leitura', async () => {
    const { cofre } = cofreEmMemoria();
    cofre.ler = async () => {
      throw new Error('cofre indisponível');
    };
    const guarda = criarGuardaSessao(cofre);
    await guarda.carregar();
    expect(guarda.estado()).toEqual({ fase: 'pronta', sessao: null, desconectado: false });
  });

  it('entrar grava no cofre antes de valer e avisa os ouvintes', async () => {
    const memoria = cofreEmMemoria();
    const guarda = criarGuardaSessao(memoria.cofre);
    await guarda.carregar();
    const ouvinte = vi.fn();
    guarda.assinar(ouvinte);

    await guarda.entrar(sessao());

    expect(lerSessaoGuardada(memoria.valor())).toEqual(sessao());
    expect(guarda.estado().sessao).toEqual(sessao());
    expect(ouvinte).toHaveBeenCalledTimes(1);
  });

  it('entrar não vale se o cofre recusar a gravação', async () => {
    const { cofre } = cofreEmMemoria();
    cofre.gravar = async () => {
      throw new Error('sem espaço');
    };
    const guarda = criarGuardaSessao(cofre);
    await guarda.carregar();
    await expect(guarda.entrar(sessao())).rejects.toThrow('sem espaço');
    expect(guarda.estado().sessao).toBeNull();
  });

  it('a leitura atrasada do cofre não desfaz um pareamento', async () => {
    let soltar: (valor: string | null) => void = () => {};
    const memoria = cofreEmMemoria();
    memoria.cofre.ler = () => new Promise((resolver) => (soltar = resolver));
    const guarda = criarGuardaSessao(memoria.cofre);
    const carga = guarda.carregar();
    await guarda.entrar(sessao(TOKEN_B));
    soltar(null);
    await carga;
    expect(guarda.estado().sessao?.token).toBe(TOKEN_B);
  });

  it('sair esquece a sessão e apaga o cofre, sem marcar desconexão', async () => {
    const memoria = cofreEmMemoria(serializarSessao(sessao()));
    const guarda = criarGuardaSessao(memoria.cofre);
    await guarda.carregar();
    await guarda.sair();
    expect(guarda.estado()).toEqual({ fase: 'pronta', sessao: null, desconectado: false });
    expect(memoria.valor()).toBeNull();
  });

  it('sair grava um valor inútil quando não consegue apagar', async () => {
    const memoria = cofreEmMemoria(serializarSessao(sessao()));
    memoria.cofre.apagar = async () => {
      throw new Error('não apagou');
    };
    const guarda = criarGuardaSessao(memoria.cofre);
    await guarda.carregar();
    await guarda.sair();
    expect(lerSessaoGuardada(memoria.valor())).toBeNull();
  });

  it('sairSeAtual apaga a sessão recusada e marca a desconexão', async () => {
    const memoria = cofreEmMemoria(serializarSessao(sessao()));
    const guarda = criarGuardaSessao(memoria.cofre);
    await guarda.carregar();
    await expect(guarda.sairSeAtual(sessao())).resolves.toBe(true);
    expect(guarda.estado()).toEqual({ fase: 'pronta', sessao: null, desconectado: true });
    expect(memoria.valor()).toBeNull();
  });

  it('sairSeAtual não mexe na sessão nova quando a recusa é de uma antiga', async () => {
    const memoria = cofreEmMemoria(serializarSessao(sessao(TOKEN_A)));
    const guarda = criarGuardaSessao(memoria.cofre);
    await guarda.carregar();
    await guarda.entrar(sessao(TOKEN_B));

    await expect(guarda.sairSeAtual(sessao(TOKEN_A))).resolves.toBe(false);

    expect(guarda.estado().sessao?.token).toBe(TOKEN_B);
    expect(lerSessaoGuardada(memoria.valor())?.token).toBe(TOKEN_B);
    expect(memoria.cofre.apagar).not.toHaveBeenCalled();
  });

  it('sairSeAtual não faz nada sem sessão', async () => {
    const memoria = cofreEmMemoria();
    const guarda = criarGuardaSessao(memoria.cofre);
    await guarda.carregar();
    await expect(guarda.sairSeAtual(sessao())).resolves.toBe(false);
    expect(guarda.estado().desconectado).toBe(false);
  });

  it('entrar depois de uma desconexão limpa o aviso', async () => {
    const guarda = criarGuardaSessao(cofreEmMemoria(serializarSessao(sessao())).cofre);
    await guarda.carregar();
    await guarda.sairSeAtual(sessao());
    await guarda.entrar(sessao(TOKEN_B));
    expect(guarda.estado().desconectado).toBe(false);
  });

  describe('escritas no cofre em fila', () => {
    /** Cofre em que cada escrita só termina quando o teste manda, na ordem que o teste quiser. */
    function cofreLento(inicial: string | null) {
      let valor = inicial;
      const pendentes: { nome: string; terminar: () => void }[] = [];
      const adiar = (nome: string, efeito: () => void): Promise<void> =>
        new Promise((resolver) => {
          pendentes.push({
            nome,
            terminar: () => {
              efeito();
              resolver();
            },
          });
        });
      const cofre: Cofre = {
        ler: async () => valor,
        gravar: (novo) => adiar('gravar', () => (valor = novo)),
        apagar: () => adiar('apagar', () => (valor = null)),
      };
      return { cofre, valor: () => valor, pendentes };
    }

    const assentar = (): Promise<void> => new Promise((resolver) => setTimeout(resolver, 0));

    it('desparear e parear em seguida termina com a sessão nova na memória e no cofre', async () => {
      const lento = cofreLento(serializarSessao(sessao(TOKEN_A)));
      const guarda = criarGuardaSessao(lento.cofre);
      await guarda.carregar();

      const saida = guarda.sair();
      const entrada = guarda.entrar(sessao(TOKEN_B));
      await assentar();
      // O gravar do pareamento espera o apagar do despareamento: só uma escrita por vez.
      expect(lento.pendentes.map((pendente) => pendente.nome)).toEqual(['apagar']);

      lento.pendentes[0]?.terminar();
      await assentar();
      expect(lento.pendentes.map((pendente) => pendente.nome)).toEqual(['apagar', 'gravar']);
      lento.pendentes[1]?.terminar();
      await Promise.all([saida, entrada]);

      expect(guarda.estado().sessao?.token).toBe(TOKEN_B);
      expect(lerSessaoGuardada(lento.valor())?.token).toBe(TOKEN_B);
    });

    it('sair logo depois de entrar termina sem sessão na memória e no cofre', async () => {
      const lento = cofreLento(null);
      const guarda = criarGuardaSessao(lento.cofre);
      await guarda.carregar();

      const entrada = guarda.entrar(sessao(TOKEN_A));
      const saida = guarda.sair();
      await assentar();
      lento.pendentes[0]?.terminar();
      await assentar();
      lento.pendentes[1]?.terminar();
      await Promise.all([entrada, saida]);

      expect(lento.pendentes.map((pendente) => pendente.nome)).toEqual(['gravar', 'apagar']);
      expect(guarda.estado().sessao).toBeNull();
      expect(lento.valor()).toBeNull();
    });

    it('dois pareamentos seguidos terminam com o último na memória e no cofre', async () => {
      const lento = cofreLento(null);
      const guarda = criarGuardaSessao(lento.cofre);
      await guarda.carregar();

      const primeira = guarda.entrar(sessao(TOKEN_A));
      const segunda = guarda.entrar(sessao(TOKEN_B));
      await assentar();
      lento.pendentes[0]?.terminar();
      await assentar();
      lento.pendentes[1]?.terminar();
      await Promise.all([primeira, segunda]);

      expect(guarda.estado().sessao?.token).toBe(TOKEN_B);
      expect(lerSessaoGuardada(lento.valor())?.token).toBe(TOKEN_B);
    });

    it('uma escrita que falha não trava as seguintes', async () => {
      const memoria = cofreEmMemoria();
      const gravar = memoria.cofre.gravar;
      let falhar = true;
      memoria.cofre.gravar = async (valor) => {
        if (falhar) {
          falhar = false;
          throw new Error('sem espaço');
        }
        await gravar(valor);
      };
      const guarda = criarGuardaSessao(memoria.cofre);
      await guarda.carregar();

      await expect(guarda.entrar(sessao(TOKEN_A))).rejects.toThrow('sem espaço');
      await guarda.entrar(sessao(TOKEN_B));

      expect(guarda.estado().sessao?.token).toBe(TOKEN_B);
      expect(lerSessaoGuardada(memoria.valor())?.token).toBe(TOKEN_B);
    });
  });

  it('quem cancela a assinatura para de ser avisado', async () => {
    const guarda = criarGuardaSessao(cofreEmMemoria().cofre);
    const ouvinte = vi.fn();
    const cancelar = guarda.assinar(ouvinte);
    await guarda.carregar();
    cancelar();
    await guarda.entrar(sessao());
    expect(ouvinte).toHaveBeenCalledTimes(1);
  });
});
