import { describe, expect, it } from 'vitest';
import { ambienteDoMotor, EnvInvalida, lerEnv, lerEnvDoGancho } from './env';

describe('lerEnv', () => {
  it('usa loopback, a porta padrão e o motor real quando nada é informado', () => {
    expect(lerEnv({})).toEqual({
      NODE_ENV: 'development',
      AWIKA_HOST: '127.0.0.1',
      AWIKA_PORTA: 8790,
      AWIKA_PORTA_GANCHO: 8791,
      AWIKA_DADOS: './dados',
      AWIKA_MOTOR: 'claude-code',
      AWIKA_CLAUDE_BIN: 'claude',
      AWIKA_CODEX_BIN: 'codex',
      AWIKA_MOTORES_EM_PROVA: [],
      AWIKA_TURNOS_SIMULTANEOS: 4,
      AWIKA_GANCHO: 'opcao',
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

  it('recusa a porta do gancho igual à porta da API', () => {
    try {
      lerEnv({ AWIKA_PORTA: '9000', AWIKA_PORTA_GANCHO: '9000' });
      expect.unreachable('devia ter recusado');
    } catch (erro) {
      expect((erro as EnvInvalida).campos).toEqual(['AWIKA_PORTA_GANCHO']);
    }
  });

  it('recusa o motor simulado em produção e o aceita fora dela', () => {
    expect(() => lerEnv({ NODE_ENV: 'production', AWIKA_MOTOR: 'simulado' })).toThrow(EnvInvalida);
    expect(lerEnv({ NODE_ENV: 'test', AWIKA_MOTOR: 'simulado' }).AWIKA_MOTOR).toBe('simulado');
  });

  it('lê os motores em prova, e só aceita os do catálogo', () => {
    expect(lerEnv({ AWIKA_MOTORES_EM_PROVA: ' codex , ' }).AWIKA_MOTORES_EM_PROVA).toEqual(['codex']);
    for (const lista of ['antigravity', 'codex,--model=x', 'Codex']) {
      try {
        lerEnv({ AWIKA_MOTORES_EM_PROVA: lista });
        expect.unreachable('devia ter recusado');
      } catch (erro) {
        expect((erro as EnvInvalida).campos).toEqual(['AWIKA_MOTORES_EM_PROVA']);
      }
    }
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

describe('ambienteDoMotor', () => {
  it('passa o que o motor precisa e segura a configuração e os segredos do servidor', () => {
    const origem = {
      PATH: '/usr/bin',
      HOME: '/data',
      CLAUDE_CONFIG_DIR: '/data/claude',
      DISABLE_AUTOUPDATER: '1',
      ANTHROPIC_API_KEY: 'chave-do-motor',
      LC_ALL: 'pt_BR.UTF-8',
      HTTPS_PROXY: 'http://proxy:3128',
      Path: 'C:\\Windows',
      AWIKA_DADOS: '/data',
      AWIKA_PORTA_GANCHO: '8791',
      AWIKA_TURNO_TOKEN: 'de-outro-turno',
      EXPO_ACCESS_TOKEN: 'segredo-de-push',
      DATABASE_URL: 'segredo',
      NODE_OPTIONS: '--require ./x.js',
      VAZIA: undefined,
    };
    expect(ambienteDoMotor(origem)).toEqual({
      PATH: '/usr/bin',
      HOME: '/data',
      CLAUDE_CONFIG_DIR: '/data/claude',
      DISABLE_AUTOUPDATER: '1',
      ANTHROPIC_API_KEY: 'chave-do-motor',
      LC_ALL: 'pt_BR.UTF-8',
      HTTPS_PROXY: 'http://proxy:3128',
      Path: 'C:\\Windows',
    });
  });

  it('dá a cada motor só as variáveis dele', () => {
    const origem = {
      PATH: '/usr/bin',
      CLAUDE_CONFIG_DIR: '/data/claude',
      ANTHROPIC_API_KEY: 'chave-do-claude',
      CODEX_HOME: '/data/codex',
      OPENAI_API_KEY: 'chave-do-codex',
      AWIKA_CODEX_BIN: 'codex',
    };
    expect(ambienteDoMotor(origem, 'claude-code')).toEqual({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/data/claude', ANTHROPIC_API_KEY: 'chave-do-claude' });
    expect(ambienteDoMotor(origem, 'codex')).toEqual({ PATH: '/usr/bin', CODEX_HOME: '/data/codex', OPENAI_API_KEY: 'chave-do-codex' });
  });
});

describe('lerEnvDoGancho', () => {
  it('lê a porta e o token do turno', () => {
    expect(lerEnvDoGancho({ AWIKA_PORTA_GANCHO: '8791', AWIKA_TURNO_TOKEN: 'abc' })).toEqual({ porta: 8791, token: 'abc' });
  });

  it.each([
    ['sem nada', {}],
    ['sem token', { AWIKA_PORTA_GANCHO: '8791' }],
    ['token vazio', { AWIKA_PORTA_GANCHO: '8791', AWIKA_TURNO_TOKEN: '' }],
    ['porta que não é número', { AWIKA_PORTA_GANCHO: 'abc', AWIKA_TURNO_TOKEN: 'abc' }],
    ['porta fora da faixa', { AWIKA_PORTA_GANCHO: '70000', AWIKA_TURNO_TOKEN: 'abc' }],
  ])('devolve nulo %s', (_caso, origem) => {
    expect(lerEnvDoGancho(origem)).toBeNull();
  });
});
