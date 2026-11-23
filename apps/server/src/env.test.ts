import { describe, expect, it } from 'vitest';
import { EnvInvalida, lerEnv } from './env';

describe('lerEnv', () => {
  it('usa loopback e a porta padrão quando nada é informado', () => {
    expect(lerEnv({})).toEqual({ NODE_ENV: 'development', AWIKA_HOST: '127.0.0.1', AWIKA_PORTA: 8790 });
  });

  it('lê host e porta informados', () => {
    const env = lerEnv({ NODE_ENV: 'production', AWIKA_HOST: '0.0.0.0', AWIKA_PORTA: '9000' });
    expect(env).toEqual({ NODE_ENV: 'production', AWIKA_HOST: '0.0.0.0', AWIKA_PORTA: 9000 });
  });

  it.each([['0'], ['65536'], ['abc'], ['80.5'], ['']])('recusa a porta "%s"', (porta) => {
    expect(() => lerEnv({ AWIKA_PORTA: porta })).toThrow(EnvInvalida);
  });

  it('diz o nome da variável recusada sem repetir o valor', () => {
    try {
      lerEnv({ AWIKA_PORTA: 'valor-secreto', NODE_ENV: 'outro-secreto' });
      expect.unreachable('devia ter recusado');
    } catch (erro) {
      expect(erro).toBeInstanceOf(EnvInvalida);
      const invalida = erro as EnvInvalida;
      expect([...invalida.campos].sort()).toEqual(['AWIKA_PORTA', 'NODE_ENV']);
      expect(invalida.message).not.toContain('secreto');
    }
  });
});
