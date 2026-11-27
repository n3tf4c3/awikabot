import { describe, expect, it } from 'vitest';
import { normalizarCodigoPareamento } from '@awikabot/core';
import { abrirBanco } from './banco';
import { autenticar, criarCodigo, LimitadorDeTentativas, listarDispositivos, origemDoPedido, parear } from './dispositivos';

const DEZ_MINUTOS = 10 * 60_000;

describe('origemDoPedido', () => {
  it.each([
    ['o IPv4 que a Cloudflare escreve, e não a conexão do cloudflared', '203.0.113.7', '172.30.0.3', '203.0.113.7'],
    ['sem o cabeçalho, o endereço da conexão', undefined, '192.168.0.20', '192.168.0.20'],
    ['o IPv4 que o Node entrega escrito como IPv6', undefined, '::ffff:192.168.0.20', '192.168.0.20'],
    ['o IPv6 pelo /64', '2001:db8:1:2:3:4:5:6', '172.30.0.3', '2001:db8:1:2::/64'],
    ['o IPv6 abreviado, no mesmo /64', '2001:db8:1:2::a', '172.30.0.3', '2001:db8:1:2::/64'],
    ['o IPv6 em maiúsculas e com zeros à esquerda, no mesmo /64', '2001:0DB8:0001:0002::1', '172.30.0.3', '2001:db8:1:2::/64'],
    ['o IPv6 com zona', undefined, 'fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['o loopback IPv6', undefined, '::1', '0:0:0:0::/64'],
    ['um cabeçalho que não é endereço cai na conexão', 'qualquer-coisa', '192.168.0.20', '192.168.0.20'],
    ['um cabeçalho vazio cai na conexão', '', '10.0.0.1', '10.0.0.1'],
    ['sem nada, uma origem só para todos', undefined, undefined, 'desconhecida'],
  ])('%s', (_caso, cabecalho, conexao, origem) => {
    expect(origemDoPedido(cabecalho, conexao)).toBe(origem);
  });
});

describe('parear', () => {
  it('se o aparelho não é gravado, o código não fica gasto: a pessoa pareia de novo com o mesmo', () => {
    const banco = abrirBanco(':memory:');
    try {
      const codigo = normalizarCodigoPareamento(criarCodigo(banco));
      banco.exec("CREATE TRIGGER falha_no_aparelho BEFORE INSERT ON dispositivos BEGIN SELECT RAISE(ABORT, 'falha injetada na segunda gravação'); END");
      expect(() => parear(banco, codigo, 'Celular')).toThrow(/falha injetada/);
      expect(listarDispositivos(banco)).toEqual([]);

      banco.exec('DROP TRIGGER falha_no_aparelho');
      const pareado = parear(banco, codigo, 'Celular');
      expect(pareado?.dispositivo.nome).toBe('Celular');
      expect(autenticar(banco, pareado!.token)?.id).toBe(pareado!.dispositivo.id);
      // Uso único continua valendo depois de um pareamento que deu certo.
      expect(parear(banco, codigo, 'Outro')).toBeNull();
      expect(listarDispositivos(banco)).toHaveLength(1);
    } finally {
      banco.close();
    }
  });

  it('código errado ou vencido não deixa transação aberta nem aparelho', () => {
    const banco = abrirBanco(':memory:');
    try {
      const codigo = normalizarCodigoPareamento(criarCodigo(banco, 0));
      expect(parear(banco, 'AAAAAAAAAAAA', 'Celular', 1)).toBeNull();
      expect(parear(banco, codigo, 'Celular', 10 * 60_000)).toBeNull();
      expect(banco.isTransaction).toBe(false);
      expect(listarDispositivos(banco)).toEqual([]);
      expect(parear(banco, codigo, 'Celular', 1)?.dispositivo.nome).toBe('Celular');
    } finally {
      banco.close();
    }
  });
});

describe('LimitadorDeTentativas', () => {
  it('trava a origem no quinto erro, e só ela', () => {
    const trava = new LimitadorDeTentativas();
    for (let i = 0; i < 4; i += 1) trava.registrarFalha('a', 0);
    expect(trava.bloqueado('a', 0)).toBe(false);
    trava.registrarFalha('a', 0);
    expect(trava.bloqueado('a', 0)).toBe(true);
    expect(trava.bloqueado('b', 0)).toBe(false);
  });

  it('solta a origem quando os erros saem da janela de dez minutos', () => {
    const trava = new LimitadorDeTentativas();
    for (let i = 0; i < 5; i += 1) trava.registrarFalha('a', 0);
    expect(trava.bloqueado('a', DEZ_MINUTOS - 1)).toBe(true);
    expect(trava.bloqueado('a', DEZ_MINUTOS)).toBe(false);
  });

  it('com mil erros no servidor inteiro, de origens diferentes, trava todas', () => {
    const trava = new LimitadorDeTentativas();
    for (let i = 0; i < 999; i += 1) trava.registrarFalha(`origem-${i}`, 0);
    expect(trava.bloqueado('nova', 0)).toBe(false);
    trava.registrarFalha('origem-999', 0);
    expect(trava.bloqueado('nova', 0)).toBe(true);
    expect(trava.bloqueado('nova', DEZ_MINUTOS)).toBe(false);
  });

  it('esquece as origens cujos erros saíram da janela', () => {
    const trava = new LimitadorDeTentativas();
    for (let i = 0; i < 100; i += 1) trava.registrarFalha(`origem-${i}`, 0);
    expect(trava.origensGuardadas).toBe(100);
    trava.registrarFalha('outra', DEZ_MINUTOS);
    expect(trava.origensGuardadas).toBe(1);
  });
});
