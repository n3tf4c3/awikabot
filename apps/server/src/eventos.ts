import type { Evento } from '@awikabot/core';
import { novoId } from './ids';

export interface EventoNumerado {
  /** `<época>-<sequência>`. A época muda a cada partida do servidor. */
  id: string;
  evento: Evento;
}

type Ouvinte = (item: EventoNumerado) => void;

/** Distribui os eventos aos apps conectados e guarda os mais recentes para quem reconecta. */
export class Barramento {
  readonly epoca: string = novoId();
  private seq = 0;
  private readonly recentes: { seq: number; evento: Evento }[] = [];
  private readonly ouvintes = new Set<Ouvinte>();
  private readonly capacidade: number;

  constructor(capacidade = 500) {
    this.capacidade = capacidade;
  }

  /** Id do evento mais recente. Quem conecta agora retoma a partir dele. */
  cursor(): string {
    return `${this.epoca}-${this.seq}`;
  }

  publicar(evento: Evento): void {
    this.seq += 1;
    this.recentes.push({ seq: this.seq, evento });
    if (this.recentes.length > this.capacidade) this.recentes.shift();
    const item = { id: `${this.epoca}-${this.seq}`, evento };
    for (const ouvinte of this.ouvintes) ouvinte(item);
  }

  /**
   * Com `desde`, entrega primeiro o que o app perdeu. Se não dá para saber o que ele perdeu
   * (outra época, ou eventos que já saíram da memória), manda `ressincronizar`.
   * Devolve a função que cancela a assinatura.
   */
  assinar(desde: string | undefined, ouvinte: Ouvinte): () => void {
    if (desde !== undefined) {
      const perdidos = this.perdidosDesde(desde);
      if (perdidos === null) {
        ouvinte({ id: `${this.epoca}-${this.seq}`, evento: { tipo: 'ressincronizar' } });
      } else {
        for (const perdido of perdidos) ouvinte({ id: `${this.epoca}-${perdido.seq}`, evento: perdido.evento });
      }
    }
    this.ouvintes.add(ouvinte);
    return () => {
      this.ouvintes.delete(ouvinte);
    };
  }

  private perdidosDesde(desde: string): { seq: number; evento: Evento }[] | null {
    const [epoca, numero] = desde.split('-');
    const seq = Number(numero);
    if (epoca !== this.epoca || numero === undefined || !Number.isInteger(seq) || seq < 0 || seq > this.seq) return null;
    const maisAntigo = this.recentes[0]?.seq ?? this.seq + 1;
    if (seq + 1 < maisAntigo) return null;
    return this.recentes.filter((recente) => recente.seq > seq);
  }
}
