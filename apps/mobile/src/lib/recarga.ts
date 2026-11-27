/** Quanto esperar antes de cada nova tentativa: cresce a cada falha seguida e para no último valor. */
export const ESPERAS_DA_RECARGA_MS: readonly number[] = [1000, 2000, 4000, 8000, 16_000, 30_000];

export interface Recarga {
  /** Busca agora. Se falhar, tenta de novo sozinha, com espera crescente, até dar certo. */
  pedir(): void;
  /** Cancela a tentativa marcada e ignora o resultado do pedido em curso. `pedir` volta a valer depois. */
  parar(): void;
}

interface Opcoes {
  carregar: () => Promise<void>;
  esperasMs?: readonly number[];
  /** Relógio, para o teste dirigir. */
  agendar?: (tarefa: () => void, ms: number) => unknown;
  cancelar?: (marcado: unknown) => void;
}

/**
 * Mantém uma busca tentando até dar certo. Serve à lista de pedidos de aprovação pendentes: se ela
 * falha uma vez e ninguém tenta de novo, um bot parado à espera de aprovação fica sem cartão na tela
 * até outro evento qualquer provocar a busca.
 *
 * Cada `pedir` começa uma rodada nova e desliga a anterior: o resultado de um pedido antigo não marca
 * tentativa nenhuma. Quem cria a recarga a para quando a sessão acaba.
 */
export function criarRecarga(opcoes: Opcoes): Recarga {
  const esperas = opcoes.esperasMs ?? ESPERAS_DA_RECARGA_MS;
  const agendar = opcoes.agendar ?? ((tarefa: () => void, ms: number) => setTimeout(tarefa, ms));
  const cancelar = opcoes.cancelar ?? ((marcado: unknown) => clearTimeout(marcado as ReturnType<typeof setTimeout>));
  let rodada = 0;
  let marcada: unknown = null;

  function desmarcar(): void {
    if (marcada === null) return;
    cancelar(marcada);
    marcada = null;
  }

  function tentar(daRodada: number, falhasSeguidas: number): void {
    opcoes.carregar().then(
      () => {},
      () => {
        if (daRodada !== rodada) return;
        const espera = esperas[Math.min(falhasSeguidas, esperas.length - 1)] ?? 0;
        marcada = agendar(() => {
          marcada = null;
          if (daRodada === rodada) tentar(daRodada, falhasSeguidas + 1);
        }, espera);
      },
    );
  }

  return {
    pedir() {
      desmarcar();
      rodada += 1;
      tentar(rodada, 0);
    },
    parar() {
      desmarcar();
      rodada += 1;
    },
  };
}
