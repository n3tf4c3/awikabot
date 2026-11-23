import { createHash, randomBytes, randomInt } from 'node:crypto';

const ALFABETO_ID = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ALFABETO_CODIGO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function sortear(alfabeto: string, tamanho: number): string {
  let saida = '';
  for (let i = 0; i < tamanho; i += 1) saida += alfabeto[randomInt(alfabeto.length)];
  return saida;
}

export const novoId = (): string => sortear(ALFABETO_ID, 16);

/** 256 bits, em base64url: 43 caracteres. */
export const novoToken = (): string => randomBytes(32).toString('base64url');

/** 12 caracteres em base32: 60 bits. */
export const novoCodigo = (): string => sortear(ALFABETO_CODIGO, 12);

export const formatarCodigo = (codigo: string): string => codigo.replace(/^(.{4})(.{4})(.{4})$/, '$1-$2-$3');

export const resumo = (texto: string): string => createHash('sha256').update(texto).digest('hex');
