import { describe, expect, it } from 'vitest';
import { EnvInvalida, lerEnv } from './env';

describe('lerEnv', () => {
  it('usa loopback, a porta padrão e o motor real quando nada é informado', () => {
    expect(lerEnv({})).toEqual({
      NODE_ENV: 'development',
      AWIKA_HOST: '127.0.0.1',
      AWIKA_PORTA: 8790,
      AWIKA_DADOS: './dados',
      AWIKA_MOTOR: 'claude-code',
      AWIKA_CLAUDE_BIN: 'claude',
      AWIKA_TURNOS_SIMULTANEOS: 4,
    });
  });

  it('lê os valores informados', () => {
    const env = lerEnv({
      NODE_ENV: 'production',
      AWIKA_HOST: '0.0.0.0',
      AWIKA_PORTA: '9000',
      AWIKA_DADOS: '/data',
      AWIKA_TURNOS_SIMULTANEOS: '2',
    });
    expect(env).toMatchObject({ AWIKA_HOST: '0.0.0.0', AWIKA_PORTA: 9000, AWIKA_DADOS: '/data', AWIKA_TURNOS_SIMULTANEOS: 2 });
  });

  it.each([['0'], ['65536'], ['abc'], ['80.5'], ['']])('recusa a porta "%s"', (porta) => {
    expect(() => lerEnv({ AWIKA_PORTA: porta })).toThrow(EnvInvalida);
  });

  it.each([['0'], ['17'], ['muitos']])('recusa o limite de turnos "%s"', (limite) => {
    expect(() => lerEnv({ AWIKA_TURNOS_SIMULTANEOS: limite })).toThrow(EnvInvalida);
  });

  it('recusa o motor simulado em produção e o aceita fora dela', () => {
    expect(() => lerEnv({ NODE_ENV: 'production', AWIKA_MOTOR: 'simulado' })).toThrow(EnvInvalida);
    expect(lerEnv({ NODE_ENV: 'test', AWIKA_MOTOR: 'simulado' }).AWIKA_MOTOR).toBe('simulado');
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
