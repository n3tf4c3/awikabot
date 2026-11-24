import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Banco } from './banco';

export interface ResumoDoBackup {
  arquivo: string;
  bytes: number;
  sha256: string;
  versaoDoEsquema: number;
  bots: number;
  mensagens: number;
  aparelhosAtivos: number;
}

/** O destino já existe, ou a cópia não passou na conferência. A mensagem não leva dado do banco. */
export class BackupRecusado extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'BackupRecusado';
  }
}

function sha256DoArquivo(arquivo: string): string {
  const resumo = createHash('sha256');
  const pedaco = Buffer.alloc(1024 * 1024);
  const descritor = openSync(arquivo, 'r');
  try {
    for (let lidos = readSync(descritor, pedaco); lidos > 0; lidos = readSync(descritor, pedaco)) {
      resumo.update(pedaco.subarray(0, lidos));
    }
  } finally {
    closeSync(descritor);
  }
  return resumo.digest('hex');
}

const contar = (banco: Banco, sql: string): number => Number((banco.prepare(sql).get() as { total: number }).total);

/**
 * Copia o banco para um arquivo novo, inteiro e coerente, com o servidor no ar. Nunca escreve
 * por cima de um arquivo que já existe. A cópia é aberta e conferida antes de ser dada como boa.
 *
 * O arquivo leva as conversas e o hash dos tokens dos aparelhos. O login do motor não está no
 * banco e não entra aqui.
 */
export function fazerBackup(banco: Banco, destino: string): ResumoDoBackup {
  const arquivo = path.resolve(destino);
  if (existsSync(arquivo)) throw new BackupRecusado('O arquivo de destino já existe; escolha um nome novo.');
  mkdirSync(path.dirname(arquivo), { recursive: true });

  let copia: DatabaseSync | null = null;
  try {
    banco.prepare('VACUUM INTO ?').run(arquivo);

    copia = new DatabaseSync(arquivo, { readOnly: true });
    const { integrity_check: integridade } = copia.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    if (integridade !== 'ok') throw new BackupRecusado('A cópia não passou na conferência de integridade.');
    const { user_version: versaoDoEsquema } = copia.prepare('PRAGMA user_version').get() as { user_version: number };
    const resumo = {
      versaoDoEsquema,
      bots: contar(copia, 'SELECT COUNT(*) AS total FROM bots'),
      mensagens: contar(copia, 'SELECT COUNT(*) AS total FROM mensagens'),
      aparelhosAtivos: contar(copia, 'SELECT COUNT(*) AS total FROM dispositivos WHERE revogado_em IS NULL'),
    };
    copia.close();
    return { arquivo, bytes: statSync(arquivo).size, sha256: sha256DoArquivo(arquivo), ...resumo };
  } catch (erro) {
    if (copia?.isOpen) copia.close();
    // Só o arquivo que esta chamada criou: se ele já existisse, a recusa teria sido lá em cima.
    rmSync(arquivo, { force: true });
    throw erro;
  }
}
