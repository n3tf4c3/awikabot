import os from 'node:os';
import path from 'node:path';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { normalizarCodigoPareamento } from '@awikabot/core';
import { BackupRecusado, conferirBanco, fazerBackup } from './backup';
import { abrirBanco, EsquemaMaisNovo, VERSAO_DO_ESQUEMA } from './banco';
import { criarBot, listarBots } from './bots';
import { inserirMensagem, listarMensagens } from './conversa';
import { autenticar, criarCodigo, listarDispositivos, parear, revogar, revogarTodos } from './dispositivos';

const pasta = mkdtempSync(path.join(os.tmpdir(), 'awikabot-backup-'));
afterAll(() => {
  rmSync(pasta, { recursive: true, force: true });
});

function bancoComDados(nome: string) {
  const banco = abrirBanco(path.join(pasta, nome, 'awikabot.db'));
  const novoAparelho = (nome: string) => parear(banco, normalizarCodigoPareamento(criarCodigo(banco)), nome)!;
  const ativo = novoAparelho('Celular');
  const revogado = novoAparelho('Antigo');
  revogar(banco, revogado.dispositivo.id);
  const bot = criarBot(banco, { nome: 'Scout', instrucoes: 'Seja breve.', modelo: null });
  inserirMensagem(banco, { botId: bot.id, papel: 'usuario', texto: 'olá', estado: 'completa' });
  inserirMensagem(banco, { botId: bot.id, papel: 'bot', texto: 'Você disse: olá', estado: 'completa' });
  return { banco, bot, token: ativo.token, tokenRevogado: revogado.token };
}

describe('backup do banco', () => {
  it('a cópia abre num servidor novo com os bots, as conversas e os aparelhos', () => {
    const origem = bancoComDados('origem');
    const destino = path.join(pasta, 'copias', 'a.db');

    const resumo = fazerBackup(origem.banco, destino);
    expect(resumo).toMatchObject({ arquivo: destino, versaoDoEsquema: VERSAO_DO_ESQUEMA, bots: 1, mensagens: 2, aparelhosAtivos: 1 });
    expect(resumo.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(resumo.bytes).toBe(readFileSync(destino).length);

    // O que entra no banco depois do backup não está na cópia.
    inserirMensagem(origem.banco, { botId: origem.bot.id, papel: 'usuario', texto: 'depois', estado: 'completa' });
    origem.banco.close();

    // Restaurar: a cópia vira o banco de uma pasta de dados vazia.
    const restaurado = path.join(pasta, 'restaurado', 'awikabot.db');
    mkdirSync(path.dirname(restaurado), { recursive: true });
    copyFileSync(destino, restaurado);
    const banco = abrirBanco(restaurado);
    try {
      expect(listarBots(banco)).toMatchObject([{ id: origem.bot.id, nome: 'Scout', instrucoes: 'Seja breve.' }]);
      expect(listarMensagens(banco, origem.bot.id, null, 10).mensagens.map((m) => m.texto)).toEqual(['olá', 'Você disse: olá']);
      expect(autenticar(banco, origem.token)?.nome).toBe('Celular');
      expect(autenticar(banco, origem.tokenRevogado)).toBeNull();
      // O banco restaurado aceita escrita.
      expect(inserirMensagem(banco, { botId: origem.bot.id, papel: 'usuario', texto: 'nova', estado: 'completa' }).seq).toBe(3);
    } finally {
      banco.close();
    }
  });

  // O backup traz os aparelhos como estavam no dia da cópia. Sem a revogação geral, que o
  // `restaurar.sh` roda antes de o servidor subir, um aparelho revogado depois da cópia voltaria a entrar.
  it('o aparelho revogado depois da cópia não entra no servidor restaurado', () => {
    const origem = bancoComDados('revogado-depois');
    const destino = path.join(pasta, 'copias', 'revogado-depois.db');
    fazerBackup(origem.banco, destino);
    // A revogação acontece na origem, depois da cópia: o arquivo ainda traz o aparelho como ativo.
    const perdido = listarDispositivos(origem.banco).find((d) => d.nome === 'Celular')!;
    expect(revogar(origem.banco, perdido.id)).toBe(true);
    origem.banco.close();

    const restaurado = path.join(pasta, 'restaurado-revogado-depois', 'awikabot.db');
    mkdirSync(path.dirname(restaurado), { recursive: true });
    copyFileSync(destino, restaurado);
    const banco = abrirBanco(restaurado);
    try {
      const pendente = criarCodigo(banco);
      expect(revogarTodos(banco)).toBe(1);

      expect(autenticar(banco, origem.token)).toBeNull();
      expect(autenticar(banco, origem.tokenRevogado)).toBeNull();
      expect(listarDispositivos(banco).every((d) => d.revogadoEm !== null)).toBe(true);
      // Um código emitido antes da restauração também não vale mais.
      expect(parear(banco, normalizarCodigoPareamento(pendente), 'Com código antigo')).toBeNull();
      // Os bots e as conversas ficam, e o aparelho legítimo volta com um pareamento novo.
      expect(listarBots(banco)).toHaveLength(1);
      const novo = parear(banco, normalizarCodigoPareamento(criarCodigo(banco)), 'Celular')!;
      expect(autenticar(banco, novo.token)?.nome).toBe('Celular');
      // O comando é para antes de o servidor subir: rodado de novo, revoga também quem pareou depois.
      expect(revogarTodos(banco)).toBe(1);
      expect(revogarTodos(banco)).toBe(0);
    } finally {
      banco.close();
    }
  });

  it('nunca escreve por cima de um arquivo que já existe', () => {
    const origem = bancoComDados('recusa');
    const destino = path.join(pasta, 'ja-existe.db');
    writeFileSync(destino, 'conteúdo de outra pessoa');
    try {
      expect(() => fazerBackup(origem.banco, destino)).toThrow(BackupRecusado);
      expect(readFileSync(destino, 'utf8')).toBe('conteúdo de outra pessoa');
    } finally {
      origem.banco.close();
    }
  });

  it('não deixa arquivo pela metade quando a cópia falha', () => {
    const origem = bancoComDados('falha');
    const destino = path.join(pasta, 'falha-copias', 'falha.db');
    origem.banco.close();
    expect(() => fazerBackup(origem.banco, destino)).toThrow();
    expect(existsSync(destino)).toBe(false);
    expect(readdirSync(path.dirname(destino))).toEqual([]);
  });

  it('a cópia boa não deixa a pasta de trabalho da execução ao lado dela', () => {
    const origem = bancoComDados('limpa');
    const destino = path.join(pasta, 'limpa-copias', 'a.db');
    try {
      fazerBackup(origem.banco, destino);
      expect(readdirSync(path.dirname(destino))).toEqual(['a.db']);
    } finally {
      origem.banco.close();
    }
  });

  // Duas execuções com o mesmo destino: as duas passam pela conferência de que o destino não existe,
  // e a outra termina primeiro. A que perde é recusada e não pode apagar nem trocar a cópia da outra.
  it('a execução que perde a corrida pelo destino não apaga a cópia da que ganhou', () => {
    const origem = bancoComDados('corrida');
    const destino = path.join(pasta, 'corrida-copias', 'a.db');
    const daOutra = 'cópia que a outra execução terminou primeiro';
    // A outra execução grava o destino depois da conferência desta e antes de ela copiar o banco.
    const comRival = new Proxy(origem.banco, {
      get(alvo, nome) {
        if (nome !== 'prepare') return Reflect.get(alvo, nome, alvo) as unknown;
        return (sql: string) => {
          const consulta = alvo.prepare(sql);
          if (!sql.startsWith('VACUUM INTO')) return consulta;
          return {
            run: (arquivo: string) => {
              writeFileSync(destino, daOutra);
              return consulta.run(arquivo);
            },
          };
        };
      },
    });
    try {
      expect(() => fazerBackup(comRival, destino)).toThrow(BackupRecusado);
      expect(readFileSync(destino, 'utf8')).toBe(daOutra);
      expect(readdirSync(path.dirname(destino))).toEqual(['a.db']);
    } finally {
      origem.banco.close();
    }
  });

  it('confere um banco sem gravar nada nele, e recusa o que não é um banco inteiro', () => {
    const origem = bancoComDados('conferencia');
    const copia = path.join(pasta, 'conferencia-copias', 'a.db');
    fazerBackup(origem.banco, copia);
    origem.banco.close();
    const antes = readFileSync(copia);

    expect(conferirBanco(copia)).toEqual({ versaoDoEsquema: VERSAO_DO_ESQUEMA, bots: 1, mensagens: 2, aparelhosAtivos: 1 });
    expect(readFileSync(copia).equals(antes)).toBe(true);
    expect(readdirSync(path.dirname(copia))).toEqual(['a.db']);

    const cortado = path.join(pasta, 'conferencia-copias', 'cortado.db');
    writeFileSync(cortado, antes.subarray(0, antes.length - 8192));
    expect(() => conferirBanco(cortado)).toThrow();
    const lixo = path.join(pasta, 'conferencia-copias', 'lixo.db');
    writeFileSync(lixo, 'isto não é um banco');
    expect(() => conferirBanco(lixo)).toThrow();
    expect(() => conferirBanco(path.join(pasta, 'conferencia-copias', 'nao-existe.db'))).toThrow(BackupRecusado);
    expect(existsSync(path.join(pasta, 'conferencia-copias', 'nao-existe.db'))).toBe(false);
  });

  // Uma imagem antiga do servidor restaurando o backup de uma mais nova: as tabelas podem não ser as que ela conhece.
  it('recusa o banco de um esquema mais novo que este servidor, sem gravar nada nele', () => {
    const origem = bancoComDados('esquema-mais-novo');
    const copia = path.join(pasta, 'esquema-mais-novo-copias', 'a.db');
    fazerBackup(origem.banco, copia);
    origem.banco.close();
    const futuro = new DatabaseSync(copia);
    futuro.exec(`PRAGMA user_version = ${VERSAO_DO_ESQUEMA + 1}`);
    futuro.close();
    const antes = readFileSync(copia);

    expect(() => conferirBanco(copia)).toThrow(EsquemaMaisNovo);
    expect(readFileSync(copia).equals(antes)).toBe(true);
  });

  // A conferência de integridade olha a estrutura do arquivo, não as chaves estrangeiras.
  it('recusa o banco com uma mensagem ou um pedido de um bot que não existe, sem citar dado dele', () => {
    const origem = bancoComDados('orfao');
    const copia = path.join(pasta, 'orfao-copias', 'a.db');
    fazerBackup(origem.banco, copia);
    origem.banco.close();
    const adulterado = new DatabaseSync(copia);
    adulterado.exec('PRAGMA foreign_keys = OFF');
    adulterado.prepare('DELETE FROM bots WHERE id = ?').run(origem.bot.id);
    adulterado.close();

    expect(() => conferirBanco(copia)).toThrow(BackupRecusado);
    expect(() => conferirBanco(copia)).toThrow('O banco tem referências que não apontam para nada, em mensagens.');
  });

  it('o backup de um banco com referência quebrada não é gravado', () => {
    const origem = bancoComDados('orfao-na-origem');
    origem.banco.exec('PRAGMA foreign_keys = OFF');
    origem.banco.prepare('DELETE FROM bots WHERE id = ?').run(origem.bot.id);
    const destino = path.join(pasta, 'orfao-na-origem-copias', 'a.db');
    try {
      expect(() => fazerBackup(origem.banco, destino)).toThrow(BackupRecusado);
      expect(readdirSync(path.dirname(destino))).toEqual([]);
    } finally {
      origem.banco.close();
    }
  });
});
