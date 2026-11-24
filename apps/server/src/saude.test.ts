import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { arquivosDaVigia, conferirSaude, enderecoDaSaude, FALHAS_PARA_REINICIAR, proximoPasso, registrarProcesso } from './saude';

const raiz = mkdtempSync(path.join(os.tmpdir(), 'awikabot-saude-'));
let servidor: Server;
let porta = 0;
let status = 200;
let pasta = '';
let caso = 0;

beforeAll(async () => {
  servidor = createServer((_pedido, resposta) => {
    resposta.writeHead(status).end('{}');
  });
  await new Promise<void>((pronto) => servidor.listen(0, '127.0.0.1', () => pronto()));
  porta = (servidor.address() as AddressInfo).port;
});
beforeEach(() => {
  status = 200;
  caso += 1;
  pasta = mkdtempSync(path.join(raiz, `caso-${caso}-`));
});
afterAll(async () => {
  await new Promise<void>((fim) => servidor.close(() => fim()));
  rmSync(raiz, { recursive: true, force: true });
});

describe('regra da vigia', () => {
  it('só manda derrubar na terceira falha seguida', () => {
    expect(FALHAS_PARA_REINICIAR).toBe(3);
    expect(proximoPasso(false, 0)).toEqual({ falhas: 1, derrubar: false });
    expect(proximoPasso(false, 1)).toEqual({ falhas: 2, derrubar: false });
    expect(proximoPasso(false, 2)).toEqual({ falhas: 3, derrubar: true });
  });

  it('uma resposta boa zera a contagem', () => {
    expect(proximoPasso(true, 2)).toEqual({ falhas: 0, derrubar: false });
  });
});

describe('endereço da conferência', () => {
  it.each([
    ['0.0.0.0', 'http://127.0.0.1:8790/healthz'],
    ['127.0.0.1', 'http://127.0.0.1:8790/healthz'],
    ['::', 'http://[::1]:8790/healthz'],
    ['::1', 'http://[::1]:8790/healthz'],
  ])('servidor ouvindo em %s', (host, esperado) => {
    expect(enderecoDaSaude(host, 8790)).toBe(esperado);
  });
});

describe('conferência de saúde', () => {
  const conferir = (reiniciar: boolean, mortos: number[]) =>
    conferirSaude({ host: '127.0.0.1', porta, reiniciar, pasta, prazoMs: 500, matar: (pid) => mortos.push(pid) });

  it('servidor que responde está saudável, e nada é escrito', async () => {
    const mortos: number[] = [];
    expect(await conferir(true, mortos)).toEqual({ saudavel: true, derrubou: false });
    expect(existsSync(arquivosDaVigia(pasta).falhas)).toBe(false);
    expect(mortos).toEqual([]);
  });

  it('servidor que responde com erro derruba o processo anotado na terceira conferência', async () => {
    const mortos: number[] = [];
    const arquivos = arquivosDaVigia(pasta);
    writeFileSync(arquivos.pid, '4321');
    status = 503;

    expect(await conferir(true, mortos)).toEqual({ saudavel: false, derrubou: false });
    expect(await conferir(true, mortos)).toEqual({ saudavel: false, derrubou: false });
    expect(readFileSync(arquivos.falhas, 'utf8')).toBe('2');
    expect(mortos).toEqual([]);

    expect(await conferir(true, mortos)).toEqual({ saudavel: false, derrubou: true });
    expect(mortos).toEqual([4321]);
    // A contagem recomeça: o servidor que subir no lugar não herda as falhas.
    expect(existsSync(arquivos.falhas)).toBe(false);
  });

  it('uma resposta boa no meio recomeça a contagem', async () => {
    const mortos: number[] = [];
    writeFileSync(arquivosDaVigia(pasta).pid, '4321');
    status = 503;
    await conferir(true, mortos);
    await conferir(true, mortos);
    status = 200;
    await conferir(true, mortos);
    status = 503;
    await conferir(true, mortos);
    await conferir(true, mortos);
    expect(mortos).toEqual([]);
  });

  it('sem a opção de reiniciar, só observa', async () => {
    const mortos: number[] = [];
    const arquivos = arquivosDaVigia(pasta);
    writeFileSync(arquivos.pid, '4321');
    status = 503;
    for (let i = 0; i < 5; i += 1) expect(await conferir(false, mortos)).toEqual({ saudavel: false, derrubou: false });
    expect(mortos).toEqual([]);
    expect(existsSync(arquivos.falhas)).toBe(false);
  });

  it.each([['sem anotação', null], ['com anotação ilegível', 'abc'], ['com o processo 1', '1']])(
    '%s do processo, não derruba nada',
    async (_nome, conteudo) => {
      const mortos: number[] = [];
      if (conteudo !== null) writeFileSync(arquivosDaVigia(pasta).pid, conteudo);
      status = 503;
      for (let i = 0; i < 4; i += 1) await conferir(true, mortos);
      expect(mortos).toEqual([]);
    },
  );

  it('porta sem servidor conta como falha', async () => {
    const semServidor = await conferirSaude({ host: '127.0.0.1', porta: 1, reiniciar: false, pasta, prazoMs: 500 });
    expect(semServidor.saudavel).toBe(false);
  });

  it('o servidor anota o próprio processo e desfaz a anotação na parada', () => {
    const arquivos = arquivosDaVigia(pasta);
    writeFileSync(arquivos.falhas, '2');
    const esquecer = registrarProcesso(pasta);
    expect(readFileSync(arquivos.pid, 'utf8')).toBe(String(process.pid));
    expect(existsSync(arquivos.falhas)).toBe(false);
    esquecer();
    expect(existsSync(arquivos.pid)).toBe(false);
  });
});
