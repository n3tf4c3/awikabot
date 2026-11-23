import { describe, expect, it } from 'vitest';
import type { Evento } from '@awikabot/core';
import { Barramento, type EventoNumerado } from './eventos';

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
