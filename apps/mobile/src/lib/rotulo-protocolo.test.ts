import { describe, expect, it } from 'vitest';
import { VERSAO_PROTOCOLO } from '@awikabot/core';
import { rotuloProtocolo } from './rotulo-protocolo';

describe('rotuloProtocolo', () => {
  it('mostra a versão do contrato do core por padrão', () => {
    expect(rotuloProtocolo()).toBe(`Protocolo ${VERSAO_PROTOCOLO}`);
  });

  it('mostra a versão informada', () => {
    expect(rotuloProtocolo(7)).toBe('Protocolo 7');
  });
});
