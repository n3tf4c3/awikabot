import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EsquemaSaude, VERSAO_PROTOCOLO } from '@awikabot/core';
import { criarServidor } from './app';

const servidor = criarServidor({ versao: '9.9.9-teste' });
let base = '';

beforeAll(async () => {
  await new Promise<void>((pronto) => { servidor.listen(0, '127.0.0.1', pronto); });
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});

afterAll(async () => {
  servidor.closeAllConnections();
  await new Promise<void>((fim) => { servidor.close(() => fim()); });
});

describe('GET /healthz', () => {
  it('responde 200 com o contrato de saúde do core', async () => {
    const resposta = await fetch(`${base}/healthz`);
    expect(resposta.status).toBe(200);
    expect(resposta.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(resposta.headers.get('cache-control')).toBe('no-store');
    expect(resposta.headers.get('x-content-type-options')).toBe('nosniff');
    expect(EsquemaSaude.parse(await resposta.json())).toEqual({
      status: 'ok',
      versao: '9.9.9-teste',
      protocolo: VERSAO_PROTOCOLO,
    });
  });

  it('ignora a query string', async () => {
    const resposta = await fetch(`${base}/healthz?x=1`);
    expect(resposta.status).toBe(200);
  });

  it.each(['POST', 'PUT', 'DELETE'])('recusa %s com 405', async (metodo) => {
    const resposta = await fetch(`${base}/healthz`, { method: metodo });
    expect(resposta.status).toBe(405);
    expect(resposta.headers.get('allow')).toBe('GET');
    expect(await resposta.json()).toEqual({ erro: 'metodo_nao_permitido' });
  });
});

describe('rota desconhecida', () => {
  it.each(['/', '/healthz/', '/api'])('%s responde 404', async (caminho) => {
    const resposta = await fetch(`${base}${caminho}`);
    expect(resposta.status).toBe(404);
    expect(await resposta.json()).toEqual({ erro: 'nao_encontrado' });
  });
});
