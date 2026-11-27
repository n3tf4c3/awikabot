import os from 'node:os';
import path from 'node:path';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { normalizarCodigoPareamento } from '@awikabot/core';
import { BackupRecusado, fazerBackup } from './backup';
import { abrirBanco } from './banco';
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
    expect(resumo).toMatchObject({ arquivo: destino, versaoDoEsquema: 3, bots: 1, mensagens: 2, aparelhosAtivos: 1 });
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
    const destino = path.join(pasta, 'falha.db');
    origem.banco.close();
    expect(() => fazerBackup(origem.banco, destino)).toThrow();
    expect(existsSync(destino)).toBe(false);
  });
});
