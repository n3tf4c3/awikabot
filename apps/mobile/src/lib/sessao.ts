import { EsquemaRespostaPareamento, type Dispositivo } from '@awikabot/core';
import { normalizarEnderecoServidor } from './endereco-servidor';

/** O que o app guarda depois de parear: onde fica o servidor e a credencial deste aparelho. */
export interface Sessao {
  /** URL base do servidor, já normalizada, sem barra no fim. */
  readonly servidor: string;
  readonly token: string;
  readonly dispositivo: Dispositivo;
}

/** Onde a sessão fica guardada no aparelho. No app, o `expo-secure-store`. */
export interface Cofre {
  ler(): Promise<string | null>;
  gravar(valor: string): Promise<void>;
  apagar(): Promise<void>;
}

export interface EstadoSessao {
  /** `carregando` até a primeira leitura do cofre terminar. */
  readonly fase: 'carregando' | 'pronta';
  readonly sessao: Sessao | null;
  /** O servidor recusou o token e a sessão foi apagada: a tela de pareamento explica. */
  readonly desconectado: boolean;
}

const EsquemaCredencial = EsquemaRespostaPareamento.pick({ token: true, dispositivo: true });

export function serializarSessao(sessao: Sessao): string {
  return JSON.stringify({ servidor: sessao.servidor, token: sessao.token, dispositivo: sessao.dispositivo });
}

/** Lê o que estava no cofre. Qualquer coisa fora do formato vira `null`. */
export function lerSessaoGuardada(texto: string | null): Sessao | null {
  if (texto === null) return null;
  let bruto: unknown;
  try {
    bruto = JSON.parse(texto);
  } catch {
    return null;
  }
  if (typeof bruto !== 'object' || bruto === null) return null;
  const servidor: unknown = (bruto as { servidor?: unknown }).servidor;
  if (typeof servidor !== 'string') return null;
  const endereco = normalizarEnderecoServidor(servidor);
  const credencial = EsquemaCredencial.safeParse(bruto);
  if (!endereco.ok || endereco.url !== servidor || !credencial.success) return null;
  return { servidor, token: credencial.data.token, dispositivo: credencial.data.dispositivo };
}

export function mesmaSessao(a: Sessao | null, b: Sessao | null): boolean {
  if (a === null || b === null) return a === b;
  return a.servidor === b.servidor && a.token === b.token;
}

export interface GuardaSessao {
  estado(): EstadoSessao;
  assinar(ouvinte: () => void): () => void;
  /** Lê o cofre uma vez, na partida do app. */
  carregar(): Promise<void>;
  /** Guarda a sessão nova no cofre e só então passa a usá-la. */
  entrar(sessao: Sessao): Promise<void>;
  /** Esquece o servidor a pedido da pessoa. */
  sair(): Promise<void>;
  /**
   * Esquece a sessão porque o servidor recusou o token, mas só se `sessao` ainda for a atual:
   * a resposta atrasada de uma sessão antiga não derruba a nova.
   */
  sairSeAtual(sessao: Sessao): Promise<boolean>;
}

export function criarGuardaSessao(cofre: Cofre): GuardaSessao {
  let estado: EstadoSessao = { fase: 'carregando', sessao: null, desconectado: false };
  const ouvintes = new Set<() => void>();

  function mudar(novo: EstadoSessao): void {
    estado = novo;
    for (const ouvinte of [...ouvintes]) ouvinte();
  }

  /**
   * As escritas no cofre correm uma de cada vez, na ordem em que foram pedidas. Sem isso, o apagar
   * de um despareamento poderia terminar depois do gravar do pareamento seguinte e esvaziar o cofre
   * com a sessão nova já em uso.
   */
  let fila: Promise<unknown> = Promise.resolve();
  function naVez<T>(escrita: () => Promise<T>): Promise<T> {
    const feita = fila.then(escrita);
    fila = feita.catch(() => {});
    return feita;
  }

  /** Sobe a cada pedido de entrar ou sair: a escrita que termina só vale em memória se ainda for o último. */
  let pedidos = 0;

  function apagarDoCofre(): Promise<void> {
    return naVez(async () => {
      try {
        await cofre.apagar();
      } catch {
        // Sem conseguir apagar, grava um valor que não é sessão: a próxima partida cai no pareamento.
        await cofre.gravar('');
      }
    });
  }

  return {
    estado: () => estado,

    assinar(ouvinte) {
      ouvintes.add(ouvinte);
      return () => {
        ouvintes.delete(ouvinte);
      };
    },

    async carregar() {
      let sessao: Sessao | null = null;
      try {
        sessao = lerSessaoGuardada(await cofre.ler());
      } catch {
        sessao = null;
      }
      // Quem pareou enquanto a leitura corria já decidiu a sessão.
      if (estado.fase === 'pronta') return;
      mudar({ fase: 'pronta', sessao, desconectado: false });
    },

    async entrar(sessao) {
      pedidos += 1;
      const meu = pedidos;
      await naVez(() => cofre.gravar(serializarSessao(sessao)));
      // Um pedido mais novo já decidiu a sessão, e a escrita dele vem depois desta no cofre.
      if (meu !== pedidos) return;
      mudar({ fase: 'pronta', sessao, desconectado: false });
    },

    async sair() {
      pedidos += 1;
      mudar({ fase: 'pronta', sessao: null, desconectado: false });
      await apagarDoCofre();
    },

    async sairSeAtual(sessao) {
      if (!mesmaSessao(estado.sessao, sessao)) return false;
      pedidos += 1;
      mudar({ fase: 'pronta', sessao: null, desconectado: true });
      try {
        await apagarDoCofre();
      } catch {
        // O token já não vale no servidor: se ficar no cofre, a próxima partida cai aqui de novo.
      }
      return true;
    },
  };
}
