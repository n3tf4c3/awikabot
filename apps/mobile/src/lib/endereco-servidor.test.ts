import { describe, expect, it } from 'vitest';
import tabela from '../../../../packages/core/casos/endereco-servidor.json';
import { mensagemDoEndereco, normalizarEnderecoServidor } from './endereco-servidor';

function url(texto: string): string | null {
  const lido = normalizarEnderecoServidor(texto);
  return lido.ok ? lido.url : null;
}

function motivo(texto: string): string | null {
  const lido = normalizarEnderecoServidor(texto);
  return lido.ok ? null : lido.motivo;
}

describe('normalizarEnderecoServidor', () => {
  it('aceita https e tira espaços, barra final e porta padrão', () => {
    expect(url('  https://bots.exemplo.com/  ')).toBe('https://bots.exemplo.com');
    expect(url('https://bots.exemplo.com:443')).toBe('https://bots.exemplo.com');
    expect(url('https://bots.exemplo.com:8443')).toBe('https://bots.exemplo.com:8443');
  });

  it('põe esquema e host em minúsculas e preserva o caminho', () => {
    expect(url('HTTPS://Bots.Exemplo.COM/Awika/')).toBe('https://bots.exemplo.com/Awika');
  });

  it('assume https quando falta o esquema num endereço público', () => {
    expect(url('bots.exemplo.com')).toBe('https://bots.exemplo.com');
    expect(url('bots.exemplo.com:8787/api')).toBe('https://bots.exemplo.com:8787/api');
    expect(url('8.8.8.8')).toBe('https://8.8.8.8');
  });

  it('assume http quando falta o esquema na rede local', () => {
    expect(url('192.168.1.10:8787')).toBe('http://192.168.1.10:8787');
    expect(url('localhost:8787')).toBe('http://localhost:8787');
    expect(url('LOCALHOST')).toBe('http://localhost');
  });

  it('subdomínio de localhost é um nome como outro qualquer: só com https', () => {
    expect(url('dev.localhost:8787')).toBe('https://dev.localhost:8787');
    expect(url('https://dev.localhost')).toBe('https://dev.localhost');
  });

  it.each([
    'http://localhost:8787',
    'http://127.0.0.1:8787',
    'http://10.0.2.2:8787',
    'http://172.16.0.1',
    'http://172.31.255.254',
    'http://192.168.0.5:8787',
    'http://169.254.10.20',
    'http://[::1]:8787',
    'http://[fd12:3456:789a::1]',
    'http://[fe80::1]',
  ])('aceita http na rede local: %s', (endereco) => {
    expect(url(endereco)).toBe(endereco);
  });

  it('tira a porta 80 do http', () => {
    expect(url('http://192.168.0.5:80/')).toBe('http://192.168.0.5');
  });

  it.each([
    'http://bots.exemplo.com',
    'http://8.8.8.8',
    'http://172.32.0.1',
    'http://172.15.0.1',
    'http://192.169.0.1',
    'http://100.64.0.1',
    'http://meupc.local',
    'http://dev.localhost',
    'http://localhost.localhost:8787',
    'http://localhost.exemplo.com',
    'http://[2001:db8::1]',
  ])('recusa http fora da rede local: %s', (endereco) => {
    expect(motivo(endereco)).toBe('http_fora_da_rede_local');
  });

  it('aceita https em qualquer host', () => {
    expect(url('https://192.168.0.5')).toBe('https://192.168.0.5');
    expect(url('https://[2001:db8::1]:8443')).toBe('https://[2001:db8::1]:8443');
  });

  it('recusa vazio', () => {
    expect(motivo('')).toBe('vazio');
    expect(motivo('   ')).toBe('vazio');
  });

  it('recusa outro esquema', () => {
    expect(motivo('ftp://bots.exemplo.com')).toBe('esquema');
    expect(motivo('ws://localhost:8787')).toBe('esquema');
  });

  it('recusa usuário e senha no endereço', () => {
    expect(motivo('https://ana:senha@bots.exemplo.com')).toBe('credenciais');
    expect(motivo('ana@bots.exemplo.com')).toBe('credenciais');
  });

  it.each([
    'https://',
    'https://bots exemplo.com',
    'https://bots.exemplo.com?x=1',
    'https://bots.exemplo.com/#topo',
    'https://bots..exemplo.com',
    'https://-bots.exemplo.com',
    'https://bots_1.exemplo.com',
    'https://bots.exemplo.com:0',
    'https://bots.exemplo.com:65536',
    'https://bots.exemplo.com:porta',
    'https://256.1.1.1',
    'https://10.0.1',
    'https://[::1',
    'https://[1::2::3]',
    'https://[12345::1]',
    'https://::1',
    'https://bots.exemplo.com/a b',
  ])('recusa endereço malformado: %s', (endereco) => {
    expect(motivo(endereco)).toBe('invalido');
  });
});

describe('mensagemDoEndereco', () => {
  it('explica a exigência de https', () => {
    expect(mensagemDoEndereco('http_fora_da_rede_local')).toMatch(/https:\/\//);
  });
});

// A mesma tabela que o app de desktop testa em `apps/desktop/crates/cliente/src/endereco.rs`.
// Mudar a regra aqui exige mudar a tabela, e a tabela mudada quebra o teste do desktop até a
// regra de lá ser igualada.
describe('tabela de casos compartilhada com o app de desktop', () => {
  const casos: ({ entrada: string; url: string; motivo?: undefined } | { entrada: string; motivo: string; url?: undefined })[] =
    tabela.casos;

  it('tem casos de todos os tipos', () => {
    expect(casos.length).toBeGreaterThanOrEqual(90);
    expect(new Set(casos.map((caso) => caso.motivo ?? 'aceito'))).toEqual(
      new Set(['aceito', 'vazio', 'invalido', 'esquema', 'credenciais', 'http_fora_da_rede_local']),
    );
  });

  it.each(casos.map((caso) => [JSON.stringify(caso.entrada), caso] as const))('%s', (_nome, caso) => {
    const lido = normalizarEnderecoServidor(caso.entrada);
    expect(lido).toEqual(caso.url === undefined ? { ok: false, motivo: caso.motivo } : { ok: true, url: caso.url });
  });
});
