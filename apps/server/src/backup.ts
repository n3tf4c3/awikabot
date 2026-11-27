import { createHash } from 'node:crypto';
import { closeSync, constants, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Banco } from './banco';

export interface ResumoDoBanco {
  versaoDoEsquema: number;
  bots: number;
  mensagens: number;
  aparelhosAtivos: number;
}

export interface ResumoDoBackup extends ResumoDoBanco {
  arquivo: string;
  bytes: number;
  sha256: string;
}

/** O destino já existe, ou a cópia não passou na conferência. A mensagem não leva dado do banco. */
export class BackupRecusado extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'BackupRecusado';
  }
}

const DESTINO_JA_EXISTE = 'O arquivo de destino já existe; escolha um nome novo.';

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
 * Abre um arquivo de banco só para leitura e o confere inteiro. Serve à cópia que o backup acabou
 * de fazer e ao banco que a restauração extraiu, antes de ele ir para o lugar do banco do servidor.
 * Não aplica migração nem grava nada no arquivo.
 */
export function conferirBanco(arquivo: string): ResumoDoBanco {
  if (!existsSync(arquivo)) throw new BackupRecusado('O arquivo do banco não existe.');
  let copia: DatabaseSync | null = null;
  try {
    copia = new DatabaseSync(arquivo, { readOnly: true });
    const { integrity_check: integridade } = copia.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    if (integridade !== 'ok') throw new BackupRecusado('O banco não passou na conferência de integridade.');
    const { user_version: versaoDoEsquema } = copia.prepare('PRAGMA user_version').get() as { user_version: number };
    return {
      versaoDoEsquema,
      bots: contar(copia, 'SELECT COUNT(*) AS total FROM bots'),
      mensagens: contar(copia, 'SELECT COUNT(*) AS total FROM mensagens'),
      aparelhosAtivos: contar(copia, 'SELECT COUNT(*) AS total FROM dispositivos WHERE revogado_em IS NULL'),
    };
  } finally {
    if (copia?.isOpen) copia.close();
  }
}

/** Dá ao arquivo conferido o nome final, sem nunca trocar o que já estiver lá. */
function publicar(origem: string, destino: string): void {
  const ocupado = (erro: unknown): boolean => (erro as NodeJS.ErrnoException).code === 'EEXIST';
  try {
    // O link nasce inteiro ou não nasce, e falha se o destino existe.
    linkSync(origem, destino);
  } catch (erro) {
    if (ocupado(erro)) throw new BackupRecusado(DESTINO_JA_EXISTE);
    // Sistema de arquivos sem link: uma cópia que também recusa o destino que já existe.
    try {
      copyFileSync(origem, destino, constants.COPYFILE_EXCL);
    } catch (falha) {
      if (ocupado(falha)) throw new BackupRecusado(DESTINO_JA_EXISTE);
      // Só chega aqui o arquivo que esta cópia criou: se ele já existisse, o erro seria o de cima.
      rmSync(destino, { force: true });
      throw falha;
    }
  }
}

/**
 * Copia o banco para um arquivo novo, inteiro e coerente, com o servidor no ar. Nunca escreve
 * por cima de um arquivo que já existe. A cópia é feita e conferida numa pasta só desta execução,
 * ao lado do destino, e só então ganha o nome final: duas execuções com o mesmo destino não mexem
 * uma na cópia da outra, e a que perde é recusada sem apagar nada.
 *
 * O arquivo leva as conversas e o hash dos tokens dos aparelhos. O login do motor não está no
 * banco e não entra aqui.
 */
export function fazerBackup(banco: Banco, destino: string): ResumoDoBackup {
  const arquivo = path.resolve(destino);
  if (existsSync(arquivo)) throw new BackupRecusado(DESTINO_JA_EXISTE);
  mkdirSync(path.dirname(arquivo), { recursive: true });

  const area = mkdtempSync(path.join(path.dirname(arquivo), '.awikabot-backup-'));
  const copia = path.join(area, 'copia.db');
  try {
    banco.prepare('VACUUM INTO ?').run(copia);
    const resumo = conferirBanco(copia);
    const medidas = { bytes: statSync(copia).size, sha256: sha256DoArquivo(copia) };
    publicar(copia, arquivo);
    return { arquivo, ...medidas, ...resumo };
  } finally {
    // Só a pasta que esta execução criou.
    rmSync(area, { recursive: true, force: true });
  }
}
