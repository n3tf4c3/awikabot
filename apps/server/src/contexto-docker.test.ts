import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// O contexto do build da imagem é a raiz do repositório, e o Dockerfile copia `apps/server` e
// `packages/core` inteiros. O que entra no contexto pode ficar no cache de um estágio do build.
// Este teste só confere que as regras estão no arquivo; quem prova que o Docker as obedece é o
// ensaio com um arquivo marcador, descrito no runbook.
const regras = readFileSync(fileURLToPath(new URL('../../../.dockerignore', import.meta.url)), 'utf8')
  .split('\n')
  .map((linha) => linha.trim())
  .filter((linha) => linha !== '' && !linha.startsWith('#'));

describe('.dockerignore', () => {
  it.each([
    ['o ambiente do compose e do túnel, em qualquer pasta', '**/.env'],
    ['as variantes do arquivo de ambiente', '**/.env.*'],
    ['chaves e certificados', '**/*.pem'],
    ['chaves privadas', '**/*.key'],
    ['o login do Claude Code', '**/.credentials.json'],
    ['o login do Codex', '**/auth.json'],
    ['o token do registro de pacotes', '**/.npmrc'],
  ])('deixa fora do contexto do build %s', (_caso, regra) => {
    expect(regras).toContain(regra);
  });

  it('nenhuma exceção traz de volta um arquivo de ambiente ou de credencial', () => {
    const excecoes = regras.filter((regra) => regra.startsWith('!'));
    expect(excecoes).toEqual(['!apps/mobile/package.json']);
  });
});
