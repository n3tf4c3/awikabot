import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { GestorDeAprovacoes } from './aprovacoes';
import { abrirBanco, emTransacao, VERSAO_DO_ESQUEMA } from './banco';
import { criarBot } from './bots';
import { inserirMensagem } from './conversa';
import { Barramento } from './eventos';

const pasta = mkdtempSync(path.join(os.tmpdir(), 'awikabot-banco-'));
afterAll(() => {
  rmSync(pasta, { recursive: true, force: true });
});

/** O passo do plano do SQLite que toca a tabela de aprovações. */
function planoDasResolvidas(banco: ReturnType<typeof abrirBanco>, mensagemIds: string[]): string[] {
  const marcas = mensagemIds.map(() => '?').join(', ');
  const passos = banco
    .prepare(`EXPLAIN QUERY PLAN SELECT id FROM aprovacoes WHERE mensagem_id IN (${marcas}) AND estado <> 'pendente' ORDER BY criada_em, id`)
    .all(...mensagemIds) as { detail: string }[];
  return passos.map((passo) => passo.detail);
}

describe('aprovações resolvidas de uma página do histórico', () => {
  it('a consulta vai direto às mensagens da página, sem percorrer as aprovações das outras conversas', () => {
    const banco = abrirBanco(':memory:');
    try {
      const plano = planoDasResolvidas(banco, ['a', 'b', 'c']);
      expect(plano.some((passo) => /^SEARCH aprovacoes USING INDEX aprovacoes_por_mensagem \(mensagem_id=\?\)$/.test(passo))).toBe(true);
      expect(plano.some((passo) => passo.startsWith('SCAN aprovacoes'))).toBe(false);
    } finally {
      banco.close();
    }
  });

  it('o banco da versão anterior ganha o índice ao abrir, sem perder nada, e a consulta devolve o mesmo', () => {
    const arquivo = path.join(pasta, 'sem-indice.db');
    const VERSAO_SEM_O_INDICE = 3;
    const antigo = abrirBanco(arquivo, VERSAO_SEM_O_INDICE);
    const bot = criarBot(antigo, { nome: 'Scout', instrucoes: '', modelo: null });
    const outro = criarBot(antigo, { nome: 'Outro', instrucoes: '', modelo: null });
    const resposta = inserirMensagem(antigo, { botId: bot.id, papel: 'bot', texto: 'a', estado: 'completa' });
    const deOutro = inserirMensagem(antigo, { botId: outro.id, papel: 'bot', texto: 'b', estado: 'completa' });
    const gravar = antigo.prepare(
      "INSERT INTO aprovacoes (id, bot_id, mensagem_id, ferramenta, resumo, estado, criada_em, resolvida_em) VALUES (?, ?, ?, 'Bash', ?, ?, ?, ?)",
    );
    gravar.run('aprovacao0000001', bot.id, resposta.id, 'echo um', 'aprovada', 10, 11);
    gravar.run('aprovacao0000002', bot.id, resposta.id, 'echo dois', 'negada', 20, 21);
    gravar.run('aprovacao0000003', outro.id, deOutro.id, 'echo de outro', 'aprovada', 30, 31);
    expect(planoDasResolvidas(antigo, [resposta.id]).some((passo) => passo.startsWith('SCAN aprovacoes'))).toBe(true);
    antigo.close();

    const banco = abrirBanco(arquivo);
    try {
      expect((banco.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(VERSAO_DO_ESQUEMA);
      expect(VERSAO_DO_ESQUEMA).toBeGreaterThan(VERSAO_SEM_O_INDICE);
      expect(planoDasResolvidas(banco, [resposta.id]).some((passo) => passo.startsWith('SCAN aprovacoes'))).toBe(false);
      const aprovacoes = new GestorDeAprovacoes({ banco, barramento: new Barramento() });
      expect(aprovacoes.resolvidasDasMensagens([resposta.id]).map((a) => [a.id, a.estado, a.resumo])).toEqual([
        ['aprovacao0000001', 'aprovada', 'echo um'],
        ['aprovacao0000002', 'negada', 'echo dois'],
      ]);
    } finally {
      banco.close();
    }
  });
});

describe('emTransacao', () => {
  it('grava tudo ou nada, e deixa o banco pronto para a transação seguinte', () => {
    const banco = abrirBanco(':memory:');
    try {
      const bot = criarBot(banco, { nome: 'Scout', instrucoes: '', modelo: null });
      const contar = (): number => Number((banco.prepare('SELECT COUNT(*) AS total FROM mensagens').get() as { total: number }).total);
      expect(() =>
        emTransacao(banco, () => {
          inserirMensagem(banco, { botId: bot.id, papel: 'usuario', texto: 'a', estado: 'completa' });
          throw new Error('falha no meio');
        }),
      ).toThrow('falha no meio');
      expect(contar()).toBe(0);
      expect(banco.isTransaction).toBe(false);

      expect(emTransacao(banco, () => inserirMensagem(banco, { botId: bot.id, papel: 'usuario', texto: 'b', estado: 'completa' }).seq)).toBe(1);
      expect(contar()).toBe(1);
    } finally {
      banco.close();
    }
  });
});
