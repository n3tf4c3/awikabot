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

/** Quanto a fila de um assinante guarda enquanto a escrita para ele está parada. */
export interface LimitesDaFila {
  itens: number;
  /** Soma do tamanho dos eventos já prontos para escrever, em caracteres. */
  caracteres: number;
}

export const LIMITES_DA_FILA_DE_EVENTOS: LimitesDaFila = { itens: 1000, caracteres: 2_000_000 };

/** Um evento pronto para escrever no fluxo. */
export interface EventoParaEscrever {
  id: string;
  dados: string;
}

/**
 * A fila de um assinante do fluxo de eventos, entre o barramento e a escrita na conexão. O barramento
 * não espera ninguém: se o app lê devagar, ou parou de ler, os eventos se acumulam aqui. Passado o
 * teto, a fila solta o que acumulou e guarda um aviso só, `ressincronizar`, com o id do último
 * evento: o app busca as listas e as conversas de novo e segue desse ponto. Enquanto o aviso não
 * sai, o que chega só move esse id, sem ocupar memória.
 *
 * Um evento sozinho entra mesmo maior que o teto de caracteres: sem nada acumulado, não há o que soltar.
 */
export class FilaDeEventos {
  private fila: EventoParaEscrever[] = [];
  private acumulado = 0;
  /** O id do último evento solto; enquanto não for `null`, a fila é só o aviso. */
  private perdidoAte: string | null = null;
  private readonly limites: LimitesDaFila;

  constructor(limites: LimitesDaFila = LIMITES_DA_FILA_DE_EVENTOS) {
    this.limites = limites;
  }

  get itens(): number {
    return this.perdidoAte === null ? this.fila.length : 1;
  }

  get caracteres(): number {
    return this.acumulado;
  }

  por(item: EventoNumerado): void {
    if (this.perdidoAte !== null) {
      this.perdidoAte = item.id;
      return;
    }
    const dados = JSON.stringify(item.evento);
    const cheia = this.fila.length >= this.limites.itens || (this.fila.length > 0 && this.acumulado + dados.length > this.limites.caracteres);
    if (cheia) {
      this.fila = [];
      this.acumulado = 0;
      this.perdidoAte = item.id;
      return;
    }
    this.fila.push({ id: item.id, dados });
    this.acumulado += dados.length;
  }

  tirar(): EventoParaEscrever | undefined {
    if (this.perdidoAte !== null) {
      const aviso: Evento = { tipo: 'ressincronizar' };
      const id = this.perdidoAte;
      this.perdidoAte = null;
      return { id, dados: JSON.stringify(aviso) };
    }
    const proximo = this.fila.shift();
    if (proximo) this.acumulado -= proximo.dados.length;
    return proximo;
  }
}
