import { describe, expect, it } from 'vitest';
import {
  EsquemaBotEdicao,
  EsquemaBotEntrada,
  EsquemaEvento,
  EsquemaPedidoPareamento,
  EsquemaPedidoTurno,
  EsquemaSaude,
  LIMITES,
  VERSAO_PROTOCOLO,
  normalizarCodigoPareamento,
} from './index';

describe('EsquemaSaude', () => {
  it('aceita a resposta de saúde na versão atual do protocolo', () => {
    const saude = { status: 'ok', versao: '0.0.0', protocolo: VERSAO_PROTOCOLO };
    expect(EsquemaSaude.parse(saude)).toEqual(saude);
  });

  it.each([
    ['status diferente de ok', { status: 'degradado', versao: '0.0.0', protocolo: 1 }],
    ['versão vazia', { status: 'ok', versao: '', protocolo: 1 }],
    ['protocolo zero', { status: 'ok', versao: '0.0.0', protocolo: 0 }],
    ['protocolo fracionário', { status: 'ok', versao: '0.0.0', protocolo: 1.5 }],
    ['campo faltando', { status: 'ok', versao: '0.0.0' }],
  ])('recusa %s', (_caso, entrada) => {
    expect(EsquemaSaude.safeParse(entrada).success).toBe(false);
  });
});

describe('pareamento', () => {
  it.each([
    ['ABCD-EFGH-2345', 'ABCDEFGH2345'],
    ['abcd efgh 2345', 'ABCDEFGH2345'],
    [' abcdefgh2345 ', 'ABCDEFGH2345'],
  ])('normaliza o código "%s"', (digitado, esperado) => {
    expect(normalizarCodigoPareamento(digitado)).toBe(esperado);
    expect(EsquemaPedidoPareamento.parse({ codigo: digitado, nome: 'Celular' }).codigo).toBe(esperado);
  });

  it.each([['ABCD-EFGH-234'], ['ABCD-EFGH-23451'], ['ABCD-EFGH-2340'], ['ABCD-EFGH-234!'], ['']])(
    'recusa o código "%s"',
    (codigo) => {
      expect(EsquemaPedidoPareamento.safeParse({ codigo, nome: 'Celular' }).success).toBe(false);
    },
  );

  it('recusa nome vazio ou longo demais', () => {
    const codigo = 'ABCD-EFGH-2345';
    expect(EsquemaPedidoPareamento.safeParse({ codigo, nome: '   ' }).success).toBe(false);
    expect(EsquemaPedidoPareamento.safeParse({ codigo, nome: 'x'.repeat(LIMITES.nomeDispositivo + 1) }).success).toBe(false);
  });
});

describe('bots', () => {
  it('preenche instruções e modelo quando não vêm', () => {
    expect(EsquemaBotEntrada.parse({ nome: ' Scout ' })).toEqual({ nome: 'Scout', instrucoes: '', modelo: null });
  });

  it.each([['--dangerously-skip-permissions'], ['-p'], ['modelo com espaço'], ['a;b'], ['']])(
    'recusa o modelo "%s"',
    (modelo) => {
      expect(EsquemaBotEntrada.safeParse({ nome: 'Scout', modelo }).success).toBe(false);
    },
  );

  it.each([['sonnet'], ['claude-sonnet-5-5'], ['opus[1m]'], ['provedor:modelo.v2']])('aceita o modelo "%s"', (modelo) => {
    expect(EsquemaBotEntrada.parse({ nome: 'Scout', modelo }).modelo).toBe(modelo);
  });

  it('recusa edição vazia e aceita limpar o modelo', () => {
    expect(EsquemaBotEdicao.safeParse({}).success).toBe(false);
    expect(EsquemaBotEdicao.parse({ modelo: null })).toEqual({ modelo: null });
  });

  it('recusa instruções acima do limite', () => {
    const instrucoes = 'x'.repeat(LIMITES.instrucoes + 1);
    expect(EsquemaBotEntrada.safeParse({ nome: 'Scout', instrucoes }).success).toBe(false);
  });
});

describe('conversa e eventos', () => {
  it('apara o texto do turno e recusa texto vazio ou longo demais', () => {
    expect(EsquemaPedidoTurno.parse({ texto: '  oi  ' })).toEqual({ texto: 'oi' });
    expect(EsquemaPedidoTurno.safeParse({ texto: '   ' }).success).toBe(false);
    expect(EsquemaPedidoTurno.safeParse({ texto: 'x'.repeat(LIMITES.texto + 1) }).success).toBe(false);
  });

  it('distingue os eventos pelo tipo', () => {
    const id = 'abcdefgh12345678';
    expect(EsquemaEvento.parse({ tipo: 'texto', botId: id, mensagemId: id, posicao: 0, trecho: 'oi' }).tipo).toBe('texto');
    expect(EsquemaEvento.safeParse({ tipo: 'texto', botId: id, mensagemId: id, trecho: 'oi' }).success).toBe(false);
    expect(EsquemaEvento.safeParse({ tipo: 'texto', botId: id, mensagemId: id, posicao: -1, trecho: 'oi' }).success).toBe(false);
    expect(EsquemaEvento.parse({ tipo: 'ressincronizar' }).tipo).toBe('ressincronizar');
    expect(EsquemaEvento.safeParse({ tipo: 'texto', botId: id }).success).toBe(false);
    expect(EsquemaEvento.safeParse({ tipo: 'desconhecido' }).success).toBe(false);
  });
});
