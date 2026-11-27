import { describe, expect, it, vi } from 'vitest';
import { criarRecarga, ESPERAS_DA_RECARGA_MS } from './recarga';

/** Relógio que o teste adianta à mão: guarda o que foi marcado e com que espera. */
function relogioDeTeste() {
  const marcados: { tarefa: () => void; ms: number; estado: 'marcado' | 'cancelado' | 'vencido' }[] = [];
  return {
    marcados,
    agendar: (tarefa: () => void, ms: number) => {
      const marcado = { tarefa, ms, estado: 'marcado' as const };
      marcados.push(marcado);
      return marcado;
    },
    cancelar: (marcado: unknown) => {
      (marcado as { estado: string }).estado = 'cancelado';
    },
    /** Dispara o último marcado, se ainda está de pé. Um relógio só vence uma vez. */
    vencer: () => {
      const ultimo = marcados.at(-1);
      if (ultimo?.estado !== 'marcado') return;
      ultimo.estado = 'vencido';
      ultimo.tarefa();
    },
    pendentes: () => marcados.filter((marcado) => marcado.estado === 'marcado').length,
  };
}

/** Deixa as promessas pendentes andarem. */
const assentar = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('criarRecarga', () => {
  it('busca na hora e, se dá certo, não marca nova tentativa', async () => {
    const relogio = relogioDeTeste();
    const carregar = vi.fn(async () => {});
    criarRecarga({ carregar, ...relogio }).pedir();
    await assentar();
    expect(carregar).toHaveBeenCalledTimes(1);
    expect(relogio.marcados).toEqual([]);
  });

  it('depois de uma falha, tenta de novo sozinha até dar certo, esperando cada vez mais', async () => {
    const relogio = relogioDeTeste();
    let falhasRestantes = 3;
    const carregar = vi.fn(async () => {
      if (falhasRestantes > 0) {
        falhasRestantes -= 1;
        throw new Error('sem rede');
      }
    });
    criarRecarga({ carregar, ...relogio }).pedir();
    for (let i = 0; i < 3; i += 1) {
      await assentar();
      relogio.vencer();
    }
    await assentar();

    expect(carregar).toHaveBeenCalledTimes(4);
    expect(relogio.marcados.map((marcado) => marcado.ms)).toEqual([1000, 2000, 4000]);
    // Deu certo: nada mais fica marcado.
    relogio.vencer();
    await assentar();
    expect(carregar).toHaveBeenCalledTimes(4);
  });

  it('a espera para de crescer no último valor da lista', async () => {
    const relogio = relogioDeTeste();
    const carregar = vi.fn(async () => {
      throw new Error('sem rede');
    });
    criarRecarga({ carregar, ...relogio }).pedir();
    for (let i = 0; i < ESPERAS_DA_RECARGA_MS.length + 2; i += 1) {
      await assentar();
      relogio.vencer();
    }
    await assentar();
    const esperas = relogio.marcados.map((marcado) => marcado.ms);
    expect(esperas.slice(0, ESPERAS_DA_RECARGA_MS.length)).toEqual([...ESPERAS_DA_RECARGA_MS]);
    expect(esperas.slice(ESPERAS_DA_RECARGA_MS.length)).toEqual(esperas.slice(ESPERAS_DA_RECARGA_MS.length).map(() => 30_000));
  });

  it('parar cancela a tentativa marcada, e o pedido que ainda corria não marca outra', async () => {
    const relogio = relogioDeTeste();
    let rejeitar: (erro: unknown) => void = () => {};
    const carregar = vi.fn(
      () =>
        new Promise<void>((_ok, falha) => {
          rejeitar = falha;
        }),
    );
    const recarga = criarRecarga({ carregar, ...relogio });

    // Com uma tentativa marcada.
    recarga.pedir();
    rejeitar(new Error('sem rede'));
    await assentar();
    expect(relogio.pendentes()).toBe(1);
    recarga.parar();
    expect(relogio.pendentes()).toBe(0);

    // Com um pedido em curso: a sessão acabou antes de a resposta chegar.
    recarga.pedir();
    recarga.parar();
    rejeitar(new Error('sem rede'));
    await assentar();
    expect(relogio.pendentes()).toBe(0);
    expect(carregar).toHaveBeenCalledTimes(2);
  });

  it('pedir de novo recomeça a contagem e desliga a rodada anterior', async () => {
    const relogio = relogioDeTeste();
    const carregar = vi.fn(async () => {
      throw new Error('sem rede');
    });
    const recarga = criarRecarga({ carregar, ...relogio });
    recarga.pedir();
    await assentar();
    relogio.vencer();
    await assentar();
    expect(relogio.marcados.map((marcado) => marcado.ms)).toEqual([1000, 2000]);

    // A pessoa tocou em "Tentar de novo", ou o fluxo pediu nova carga.
    recarga.pedir();
    await assentar();
    expect(relogio.marcados.map((marcado) => marcado.ms)).toEqual([1000, 2000, 1000]);
    expect(relogio.pendentes()).toBe(1);
    expect(carregar).toHaveBeenCalledTimes(3);
  });
});
