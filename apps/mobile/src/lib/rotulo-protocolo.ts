import { VERSAO_PROTOCOLO } from '@awikabot/core';

/** Linha da tela inicial com a versão do contrato que este app fala. */
export function rotuloProtocolo(versao: number = VERSAO_PROTOCOLO): string {
  return `Protocolo ${versao}`;
}
