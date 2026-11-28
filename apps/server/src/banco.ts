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
  `
  CREATE TABLE aprovacoes (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL REFERENCES bots (id),
    mensagem_id TEXT NOT NULL REFERENCES mensagens (id),
    ferramenta TEXT NOT NULL,
    resumo TEXT NOT NULL,
    estado TEXT NOT NULL CHECK (estado IN ('pendente', 'aprovada', 'negada', 'expirada')),
    criada_em INTEGER NOT NULL,
    resolvida_em INTEGER,
    resolvida_por TEXT REFERENCES dispositivos (id)
  ) STRICT;

  CREATE INDEX aprovacoes_pendentes ON aprovacoes (estado, criada_em);
  `,
  // O motor de cada bot, escolhido na criação, e o esforço. Bot de antes é do Claude Code, com o
  // esforço padrão: o mesmo que ele já rodava.
  `
  ALTER TABLE bots ADD COLUMN motor TEXT NOT NULL DEFAULT 'claude-code';
  ALTER TABLE bots ADD COLUMN esforco TEXT;
  `,
  // Cada página do histórico busca os pedidos resolvidos das mensagens dela. Sem este índice, a busca
  // percorre as aprovações de todas as conversas, com o servidor inteiro esperando.
  `
  CREATE INDEX aprovacoes_por_mensagem ON aprovacoes (mensagem_id);
  `,
  // O endereço de aviso push de cada aparelho, que o serviço da Expo entrega ao app. Sem ele,
  // o aparelho não recebe aviso com o app fechado.
  `
  ALTER TABLE dispositivos ADD COLUMN aviso_endereco TEXT;
  `,
];

/** A versão do esquema que este servidor grava: o `user_version` depois de todas as migrações. */
export const VERSAO_DO_ESQUEMA = MIGRACOES.length;

/**
 * O banco foi gravado por uma versão mais nova do servidor, com migrações que esta não conhece.
 * Ler ou gravar nele seria interpretar um esquema que este código nunca viu.
 */
export class EsquemaMaisNovo extends Error {
  readonly versao: number;

  constructor(versao: number) {
    super(
      `O banco é do esquema ${versao}, mais novo que o ${VERSAO_DO_ESQUEMA} que esta versão do servidor conhece: use a versão do servidor que o gravou, ou uma mais nova.`,
    );
    this.name = 'EsquemaMaisNovo';
    this.versao = versao;
  }
}

/** Recusa o esquema que este servidor não conhece. A abertura do banco e a conferência do backup passam por aqui. */
export function exigirEsquemaConhecido(versao: number): void {
  if (versao > VERSAO_DO_ESQUEMA) throw new EsquemaMaisNovo(versao);
}

/** `ate` aplica só as primeiras migrações: serve ao teste que abre um banco de uma versão anterior. */
export function abrirBanco(arquivo: string, ate = MIGRACOES.length): Banco {
  if (arquivo !== ':memory:') mkdirSync(path.dirname(arquivo), { recursive: true });
  const banco = new DatabaseSync(arquivo);
  let versao: number;
  try {
    // A versão é lida antes de qualquer gravação: um banco de esquema mais novo sai daqui como
    // chegou, sem diário, sem chave estrangeira ligada e sem migração.
    banco.exec('PRAGMA busy_timeout = 5000;');
    ({ user_version: versao } = banco.prepare('PRAGMA user_version').get() as { user_version: number });
    exigirEsquemaConhecido(versao);
  } catch (erro) {
    banco.close();
    throw erro;
  }
  banco.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

  for (let i = versao; i < ate; i += 1) {
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

/**
 * Roda as gravações de `passos` como uma só: ou todas ficam no banco, ou nenhuma. A transação já
 * começa com a trava de escrita, para um comando de administração em outro processo não se meter
 * no meio. Não se usa dentro de outra transação.
 */
export function emTransacao<T>(banco: Banco, passos: () => T): T {
  banco.exec('BEGIN IMMEDIATE');
  try {
    const resultado = passos();
    banco.exec('COMMIT');
    return resultado;
  } catch (erro) {
    banco.exec('ROLLBACK');
    throw erro;
  }
}
