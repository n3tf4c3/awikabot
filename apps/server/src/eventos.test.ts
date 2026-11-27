import { describe, expect, it } from 'vitest';
import type { Evento } from '@awikabot/core';
import { Barramento, FilaDeEventos, type EventoNumerado } from './eventos';

const id = 'abcdefgh12345678';
const texto = (trecho: string): Evento => ({ tipo: 'texto', botId: id, mensagemId: id, posicao: 0, trecho });
const trechos = (itens: EventoNumerado[]): string[] =>
  itens.map((item) => (item.evento.tipo === 'texto' ? item.evento.trecho : item.evento.tipo));

describe('Barramento', () => {
  it('entrega cada evento a todos os assinantes, numerado em ordem', () => {
    const barramento = new Barramento();
    const a: EventoNumerado[] = [];
    const b: EventoNumerado[] = [];
    barramento.assinar(undefined, (item) => a.push(item));
    barramento.assinar(undefined, (item) => b.push(item));
    barramento.publicar(texto('um'));
    barramento.publicar(texto('dois'));
    expect(trechos(a)).toEqual(['um', 'dois']);
    expect(b.map((item) => item.id)).toEqual([`${barramento.epoca}-1`, `${barramento.epoca}-2`]);
  });

  it('informa o id do evento mais recente como ponto de retomada', () => {
    const barramento = new Barramento();
    expect(barramento.cursor()).toBe(`${barramento.epoca}-0`);
    barramento.publicar(texto('um'));
    expect(barramento.cursor()).toBe(`${barramento.epoca}-1`);
    const recebidos: EventoNumerado[] = [];
    barramento.assinar(barramento.cursor(), (item) => recebidos.push(item));
    barramento.publicar(texto('dois'));
    expect(trechos(recebidos)).toEqual(['dois']);
  });

  it('para de entregar depois do cancelamento', () => {
    const barramento = new Barramento();
    const recebidos: EventoNumerado[] = [];
    const cancelar = barramento.assinar(undefined, (item) => recebidos.push(item));
    barramento.publicar(texto('um'));
    cancelar();
    barramento.publicar(texto('dois'));
    expect(trechos(recebidos)).toEqual(['um']);
  });

  it('reenvia só o que o app perdeu desde o último id', () => {
    const barramento = new Barramento();
    for (const trecho of ['um', 'dois', 'tres']) barramento.publicar(texto(trecho));
    const recebidos: EventoNumerado[] = [];
    barramento.assinar(`${barramento.epoca}-1`, (item) => recebidos.push(item));
    expect(trechos(recebidos)).toEqual(['dois', 'tres']);
  });

  it('não reenvia nada a quem já está em dia', () => {
    const barramento = new Barramento();
    barramento.publicar(texto('um'));
    const recebidos: EventoNumerado[] = [];
    barramento.assinar(`${barramento.epoca}-1`, (item) => recebidos.push(item));
    expect(recebidos).toEqual([]);
  });

  it.each([
    ['outra época', 'zzzzzzzzzzzzzzzz-1'],
    ['id sem número', 'qualquer'],
    ['número à frente do servidor', 'EPOCA-99'],
    ['evento que já saiu da memória', 'EPOCA-0'],
  ])('manda ressincronizar com %s', (_caso, desde) => {
    const barramento = new Barramento(2);
    for (const trecho of ['um', 'dois', 'tres']) barramento.publicar(texto(trecho));
    const recebidos: EventoNumerado[] = [];
    barramento.assinar(desde.replace('EPOCA', barramento.epoca), (item) => recebidos.push(item));
    expect(trechos(recebidos)).toEqual(['ressincronizar']);
  });
});

describe('FilaDeEventos', () => {
  const item = (numero: number, trecho = 'x'): EventoNumerado => ({ id: `epoca-${numero}`, evento: texto(trecho) });
  const esvaziar = (fila: FilaDeEventos): { id: string; tipo: string }[] => {
    const saida: { id: string; tipo: string }[] = [];
    for (let proximo = fila.tirar(); proximo !== undefined; proximo = fila.tirar()) {
      saida.push({ id: proximo.id, tipo: (JSON.parse(proximo.dados) as Evento).tipo });
    }
    return saida;
  };

  it('entrega na ordem o que cabe, já pronto para escrever', () => {
    const fila = new FilaDeEventos({ itens: 3, caracteres: 10_000 });
    fila.por(item(1, 'um'));
    fila.por(item(2, 'dois'));
    expect(fila.itens).toBe(2);
    expect(fila.tirar()).toEqual({ id: 'epoca-1', dados: JSON.stringify(texto('um')) });
    expect(fila.tirar()).toEqual({ id: 'epoca-2', dados: JSON.stringify(texto('dois')) });
    expect(fila.tirar()).toBeUndefined();
    expect(fila.caracteres).toBe(0);
  });

  it('com a escrita parada, a fila não passa do teto de itens por mais que se publique', () => {
    const fila = new FilaDeEventos({ itens: 5, caracteres: 1_000_000 });
    for (let numero = 1; numero <= 10_000; numero += 1) {
      fila.por(item(numero));
      expect(fila.itens).toBeLessThanOrEqual(5);
    }
    // O que se acumulou foi solto: sai um aviso só, com o id do último evento, para o app buscar tudo de novo.
    expect(esvaziar(fila)).toEqual([{ id: 'epoca-10000', tipo: 'ressincronizar' }]);
  });

  it('depois do aviso, o que chega volta a ser entregue na ordem', () => {
    const fila = new FilaDeEventos({ itens: 2, caracteres: 1_000_000 });
    for (let numero = 1; numero <= 3; numero += 1) fila.por(item(numero));
    expect(fila.tirar()).toMatchObject({ id: 'epoca-3' });
    fila.por(item(4));
    fila.por(item(5));
    expect(esvaziar(fila)).toEqual([
      { id: 'epoca-4', tipo: 'texto' },
      { id: 'epoca-5', tipo: 'texto' },
    ]);
  });

  it('o que chega antes de o aviso sair não se acumula atrás dele', () => {
    const fila = new FilaDeEventos({ itens: 2, caracteres: 1_000_000 });
    for (let numero = 1; numero <= 50; numero += 1) fila.por(item(numero));
    expect(fila.itens).toBe(1);
    expect(esvaziar(fila)).toEqual([{ id: 'epoca-50', tipo: 'ressincronizar' }]);
  });

  it('o teto de caracteres vale para o que está acumulado', () => {
    const fila = new FilaDeEventos({ itens: 1000, caracteres: 500 });
    const grande = 'y'.repeat(200);
    fila.por(item(1, grande));
    fila.por(item(2, grande));
    expect(fila.caracteres).toBeLessThanOrEqual(500);
    fila.por(item(3, grande));
    expect(fila.caracteres).toBeLessThanOrEqual(500);
    expect(esvaziar(fila)).toEqual([{ id: 'epoca-3', tipo: 'ressincronizar' }]);
  });

  it('um evento sozinho passa, mesmo maior que o teto de caracteres: sem fila, não há o que soltar', () => {
    const fila = new FilaDeEventos({ itens: 1000, caracteres: 100 });
    fila.por(item(1, 'z'.repeat(5000)));
    expect(esvaziar(fila)).toEqual([{ id: 'epoca-1', tipo: 'texto' }]);
  });
});
