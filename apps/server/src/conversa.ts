import type { ListaMensagens, Mensagem } from '@awikabot/core';
import type { Banco } from './banco';
import { novoId } from './ids';

interface LinhaMensagem {
  id: string;
  bot_id: string;
  seq: number;
  papel: Mensagem['papel'];
  texto: string;
  estado: Mensagem['estado'];
  criada_em: number;
}

const COLUNAS = 'id, bot_id, seq, papel, texto, estado, criada_em';

function deLinha(linha: LinhaMensagem): Mensagem {
  return {
    id: linha.id,
    botId: linha.bot_id,
    seq: linha.seq,
    papel: linha.papel,
    texto: linha.texto,
    estado: linha.estado,
    criadaEm: linha.criada_em,
  };
}

/** Página de mensagens em ordem crescente. `antes` é o `seq` da mensagem mais antiga já vista. */
export function listarMensagens(banco: Banco, botId: string, antes: number | null, limite: number): ListaMensagens {
  const linhas = (
    antes === null
      ? banco.prepare(`SELECT ${COLUNAS} FROM mensagens WHERE bot_id = ? ORDER BY seq DESC LIMIT ?`).all(botId, limite + 1)
      : banco
          .prepare(`SELECT ${COLUNAS} FROM mensagens WHERE bot_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`)
          .all(botId, antes, limite + 1)
  ) as unknown as LinhaMensagem[];
  return {
    mensagens: linhas.slice(0, limite).reverse().map(deLinha),
    temMais: linhas.length > limite,
  };
}

export function inserirMensagem(
  banco: Banco,
  dados: Pick<Mensagem, 'botId' | 'papel' | 'texto' | 'estado'>,
  agora = Date.now(),
): Mensagem {
  const linha = banco
    .prepare(
      `INSERT INTO mensagens (id, bot_id, seq, papel, texto, estado, criada_em)
       VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM mensagens WHERE bot_id = ?), ?, ?, ?, ?)
       RETURNING ${COLUNAS}`,
    )
    .get(novoId(), dados.botId, dados.botId, dados.papel, dados.texto, dados.estado, agora) as unknown as LinhaMensagem;
  return deLinha(linha);
}

export function concluirMensagem(banco: Banco, id: string, texto: string, estado: Mensagem['estado']): Mensagem {
  const linha = banco
    .prepare(`UPDATE mensagens SET texto = ?, estado = ? WHERE id = ? RETURNING ${COLUNAS}`)
    .get(texto, estado, id) as unknown as LinhaMensagem;
  return deLinha(linha);
}

/** Guarda o que já chegou de uma resposta em andamento, para sobrar algo se o servidor cair. */
export function gravarParcial(banco: Banco, id: string, texto: string): void {
  banco.prepare("UPDATE mensagens SET texto = ? WHERE id = ? AND estado = 'em_andamento'").run(texto, id);
}

/** Na partida do servidor: turno que ficou pela metade numa queda não vai terminar. */
export function marcarInterrompidas(banco: Banco): number {
  const resultado = banco.prepare("UPDATE mensagens SET estado = 'falhou' WHERE estado = 'em_andamento'").run();
  return Number(resultado.changes);
}
