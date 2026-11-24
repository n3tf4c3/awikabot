import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Conferências seguidas sem resposta até a vigia derrubar o servidor travado. */
export const FALHAS_PARA_REINICIAR = 3;

const PRAZO_MS = 5000;

/**
 * Onde o servidor anota o próprio processo e a vigia conta as falhas: a pasta de dados, que é
 * de um servidor só. A anotação antiga não engana: cada partida escreve a sua antes de atender.
 */
export function arquivosDaVigia(pasta: string): { pid: string; falhas: string } {
  return { pid: path.join(pasta, 'vigia.pid'), falhas: path.join(pasta, 'vigia.falhas') };
}

/** Chamado na partida do servidor. Devolve a função que desfaz a anotação numa parada normal. */
export function registrarProcesso(pasta: string): () => void {
  const arquivos = arquivosDaVigia(pasta);
  writeFileSync(arquivos.pid, String(process.pid));
  rmSync(arquivos.falhas, { force: true });
  return () => {
    rmSync(arquivos.pid, { force: true });
    rmSync(arquivos.falhas, { force: true });
  };
}

/** O endereço em que o próprio host alcança o servidor. */
export function enderecoDaSaude(host: string, porta: number): string {
  const local = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  return `http://${local.includes(':') ? `[${local}]` : local}:${porta}/healthz`;
}

export async function servidorResponde(url: string, prazoMs = PRAZO_MS): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(prazoMs) })).ok;
  } catch {
    return false;
  }
}

/** A regra da vigia, sem efeito nenhum: uma resposta boa zera a contagem. */
export function proximoPasso(saudavel: boolean, falhasAnteriores: number): { falhas: number; derrubar: boolean } {
  if (saudavel) return { falhas: 0, derrubar: false };
  const falhas = falhasAnteriores + 1;
  return { falhas, derrubar: falhas >= FALHAS_PARA_REINICIAR };
}

function lerInteiro(arquivo: string): number | null {
  try {
    const texto = readFileSync(arquivo, 'utf8').trim();
    return /^\d{1,10}$/.test(texto) ? Number(texto) : null;
  } catch {
    return null;
  }
}

export interface OpcoesDaSaude {
  host: string;
  porta: number;
  /**
   * Com `true`, depois de `FALHAS_PARA_REINICIAR` conferências seguidas sem resposta, mata o
   * processo anotado pelo servidor. Só o health check da imagem liga isto: quem levanta o
   * servidor de novo é a política de reinício do contêiner.
   */
  reiniciar: boolean;
  /** A pasta de dados do servidor conferido. */
  pasta: string;
  prazoMs?: number;
  matar?: (pid: number) => void;
}

/** Uma conferência de saúde. Sem `reiniciar`, só observa. */
export async function conferirSaude(opcoes: OpcoesDaSaude): Promise<{ saudavel: boolean; derrubou: boolean }> {
  const saudavel = await servidorResponde(enderecoDaSaude(opcoes.host, opcoes.porta), opcoes.prazoMs);
  if (!opcoes.reiniciar) return { saudavel, derrubou: false };

  const arquivos = arquivosDaVigia(opcoes.pasta);
  const passo = proximoPasso(saudavel, lerInteiro(arquivos.falhas) ?? 0);
  if (!passo.derrubar) {
    try {
      if (passo.falhas === 0) rmSync(arquivos.falhas, { force: true });
      else writeFileSync(arquivos.falhas, String(passo.falhas));
    } catch {
      // Sem conseguir anotar, a contagem não avança e nada é derrubado: a conferência só observa.
    }
    return { saudavel, derrubou: false };
  }

  // Um servidor travado não atende ao sinal de parada: só o de matar resolve.
  const pid = lerInteiro(arquivos.pid);
  if (pid === null || pid <= 1) return { saudavel, derrubou: false };
  try {
    rmSync(arquivos.falhas, { force: true });
    (opcoes.matar ?? ((alvo) => process.kill(alvo, 'SIGKILL')))(pid);
  } catch {
    return { saudavel, derrubou: false };
  }
  return { saudavel, derrubou: true };
}
