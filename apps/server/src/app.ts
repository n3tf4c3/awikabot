import { createServer, type Server, type ServerResponse } from 'node:http';
import { VERSAO_PROTOCOLO, type Saude } from '@awikabot/core';

function responderJson(
  res: ServerResponse,
  status: number,
  corpo: unknown,
  cabecalhos: Record<string, string> = {},
): void {
  const texto = JSON.stringify(corpo);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(texto),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...cabecalhos,
  });
  res.end(texto);
}

export function criarServidor(opcoes: { versao: string }): Server {
  return createServer((req, res) => {
    const caminho = new URL(req.url ?? '/', 'http://local').pathname;

    if (caminho === '/healthz') {
      if (req.method !== 'GET') {
        responderJson(res, 405, { erro: 'metodo_nao_permitido' }, { allow: 'GET' });
        return;
      }
      const saude: Saude = { status: 'ok', versao: opcoes.versao, protocolo: VERSAO_PROTOCOLO };
      responderJson(res, 200, saude);
      return;
    }

    responderJson(res, 404, { erro: 'nao_encontrado' });
  });
}
