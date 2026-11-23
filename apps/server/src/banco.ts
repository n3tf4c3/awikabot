import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Banco = DatabaseSync;

/** Cada item é uma migração; a posição dela, mais um, é o `user_version` depois de aplicada. */
const MIGRACOES: string[] = [
  `
  CREATE TABLE dispositivos (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    criado_em INTEGER NOT NULL,
    visto_em INTEGER,
    revogado_em INTEGER
  ) STRICT;

  CREATE TABLE codigos_pareamento (
    codigo_hash TEXT PRIMARY KEY,
    expira_em INTEGER NOT NULL,
    usado_em INTEGER
  ) STRICT;

  CREATE TABLE bots (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    instrucoes TEXT NOT NULL,
    modelo TEXT,
    sessao_motor TEXT,
    criado_em INTEGER NOT NULL,
    atualizado_em INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE mensagens (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL REFERENCES bots (id),
    seq INTEGER NOT NULL,
    papel TEXT NOT NULL CHECK (papel IN ('usuario', 'bot')),
    texto TEXT NOT NULL,
    estado TEXT NOT NULL CHECK (estado IN ('completa', 'em_andamento', 'parada', 'falhou')),
    criada_em INTEGER NOT NULL,
    UNIQUE (bot_id, seq)
  ) STRICT;
  `,
];

export function abrirBanco(arquivo: string): Banco {
  if (arquivo !== ':memory:') mkdirSync(path.dirname(arquivo), { recursive: true });
  const banco = new DatabaseSync(arquivo);
  banco.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

  const { user_version: versao } = banco.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let i = versao; i < MIGRACOES.length; i += 1) {
    banco.exec('BEGIN');
    try {
      banco.exec(MIGRACOES[i] ?? '');
      banco.exec(`PRAGMA user_version = ${i + 1}`);
      banco.exec('COMMIT');
    } catch (erro) {
      banco.exec('ROLLBACK');
      throw erro;
    }
  }
  return banco;
}
