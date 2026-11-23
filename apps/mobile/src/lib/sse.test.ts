import { describe, expect, it } from 'vitest';
import { criarAnalisadorSse, type EventoSse } from './sse';

function analisar(pedacos: string[]): EventoSse[] {
  const analisador = criarAnalisadorSse();
  return pedacos.flatMap((pedaco) => analisador.alimentar(pedaco));
}

describe('criarAnalisadorSse', () => {
  it('monta um evento com id, tipo e dados', () => {
    expect(analisar(['id: e1-7\nevent: evento\ndata: {"tipo":"ressincronizar"}\n\n'])).toEqual([
      { id: 'e1-7', evento: 'evento', dados: '{"tipo":"ressincronizar"}' },
    ]);
  });

  it('só entrega o evento quando chega a linha em branco', () => {
    const analisador = criarAnalisadorSse();
    expect(analisador.alimentar('event: evento\ndata: a\n')).toEqual([]);
    expect(analisador.alimentar('\n')).toEqual([{ id: null, evento: 'evento', dados: 'a' }]);
  });

  it('usa "message" quando não vem o campo event', () => {
    expect(analisar(['data: oi\n\n'])).toEqual([{ id: null, evento: 'message', dados: 'oi' }]);
  });

  it('junta várias linhas de data com quebra de linha', () => {
    expect(analisar(['data: a\ndata:\ndata: b\n\n'])).toEqual([{ id: null, evento: 'message', dados: 'a\n\nb' }]);
  });

  it('tira só um espaço depois dos dois-pontos', () => {
    expect(analisar(['data:  dois\ndata:sem\n\n'])).toEqual([{ id: null, evento: 'message', dados: ' dois\nsem' }]);
  });

  it('entrega o ping de dados vazios, como o servidor manda', () => {
    expect(analisar(['event: ping\ndata: \n\n'])).toEqual([{ id: null, evento: 'ping', dados: '' }]);
  });

  it('não entrega evento sem nenhuma linha de data e zera o tipo', () => {
    expect(analisar(['event: ping\n\ndata: x\n\n'])).toEqual([{ id: null, evento: 'message', dados: 'x' }]);
  });

  it('ignora comentários, campos desconhecidos e retry', () => {
    expect(analisar([': comentário\nretry: 3000\noutro: 1\ndata: x\n\n'])).toEqual([
      { id: null, evento: 'message', dados: 'x' },
    ]);
  });

  it('trata linha sem dois-pontos como campo de valor vazio', () => {
    expect(analisar(['data\n\n'])).toEqual([{ id: null, evento: 'message', dados: '' }]);
  });

  it('mantém o último id nos eventos seguintes', () => {
    expect(analisar(['id: 1\ndata: a\n\ndata: b\n\nid: 2\ndata: c\n\n']).map((evento) => evento.id)).toEqual([
      '1',
      '1',
      '2',
    ]);
  });

  it('aceita id vazio e ignora id com caractere nulo', () => {
    expect(analisar(['id: 1\ndata: a\n\nid\ndata: b\n\nid: x\0y\ndata: c\n\n']).map((evento) => evento.id)).toEqual([
      '1',
      '',
      '',
    ]);
  });

  it('ignora a marca de ordem de bytes no começo', () => {
    expect(analisar(['﻿data: x\n\n'])).toEqual([{ id: null, evento: 'message', dados: 'x' }]);
  });

  it.each([
    ['\\n', '\n'],
    ['\\r\\n', '\r\n'],
    ['\\r', '\r'],
  ])('aceita %s como fim de linha', (_nome, fim) => {
    const fluxo = ['id: 9', 'event: evento', 'data: {"a":1}', '', 'event: ping', 'data: ', '', ''].join(fim);
    expect(analisar([fluxo])).toEqual([
      { id: '9', evento: 'evento', dados: '{"a":1}' },
      { id: '9', evento: 'ping', dados: '' },
    ]);
  });

  it('não vê linha em branco quando o \\r\\n é cortado entre dois pedaços', () => {
    expect(analisar(['data: a\r', '\ndata: b\r', '\n\r', '\n'])).toEqual([{ id: null, evento: 'message', dados: 'a\nb' }]);
  });

  it('trata \\r seguido de outro texto como fim de linha completo', () => {
    expect(analisar(['data: a\r', 'data: b\r', '\r'])).toEqual([{ id: null, evento: 'message', dados: 'a\nb' }]);
  });

  describe('corte em qualquer posição', () => {
    const fluxo = [
      '﻿: abertura\r\n',
      'event: ping\r\ndata: \r\n\r\n',
      'id: ep-1\nevent: evento\ndata: {"tipo":"texto","trecho":"olá, mundo: 1\\n2"}\n\n',
      'id: ep-2\revent: evento\rdata: linha 1\rdata: linha 2\r\r',
      'event: ping\ndata: \n\n',
    ].join('');
    const esperado = analisar([fluxo]);

    it('o fluxo inteiro rende os quatro eventos', () => {
      expect(esperado).toEqual([
        { id: null, evento: 'ping', dados: '' },
        { id: 'ep-1', evento: 'evento', dados: '{"tipo":"texto","trecho":"olá, mundo: 1\\n2"}' },
        { id: 'ep-2', evento: 'evento', dados: 'linha 1\nlinha 2' },
        { id: 'ep-2', evento: 'ping', dados: '' },
      ]);
    });

    it('dá o mesmo resultado cortando em dois pedaços, em todo ponto', () => {
      for (let corte = 0; corte <= fluxo.length; corte += 1) {
        expect(analisar([fluxo.slice(0, corte), fluxo.slice(corte)]), `corte em ${corte}`).toEqual(esperado);
      }
    });

    it('dá o mesmo resultado em três pedaços, em todo par de pontos', () => {
      for (let a = 0; a <= fluxo.length; a += 1) {
        for (let b = a; b <= fluxo.length; b += 1) {
          const obtido = analisar([fluxo.slice(0, a), fluxo.slice(a, b), fluxo.slice(b)]);
          if (JSON.stringify(obtido) !== JSON.stringify(esperado)) {
            expect(obtido, `cortes em ${a} e ${b}`).toEqual(esperado);
          }
        }
      }
    });

    it('dá o mesmo resultado um caractere por vez', () => {
      expect(analisar([...fluxo])).toEqual(esperado);
    });
  });
});
