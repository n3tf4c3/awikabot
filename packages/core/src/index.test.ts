import { describe, expect, it } from 'vitest';
import { EsquemaSaude, VERSAO_PROTOCOLO } from './index';

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
