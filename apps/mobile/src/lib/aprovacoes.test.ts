import { describe, expect, it } from 'vitest';
import type { Aprovacao, Mensagem } from '@awikabot/core';
import {
  APROVACOES_VAZIAS,
  aplicarDecisao,
  aplicarEventoDeAprovacao,
  aplicarPendentes,
  aprovacoesDoBot,
  chaveDoItem,
  ehAprovacao,
  intercalarAprovacoes,
  rotuloDaSituacao,
  rotuloDoDesfecho,
  situacaoDoBot,
  type EstadoAprovacoes,
} from './aprovacoes';

const BOT_A = 'bot0000000000001';
const BOT_B = 'bot0000000000002';

const idMensagem = (seq: number): string => `msg${String(seq).padStart(13, '0')}`;

/** Aprovação `n`, pendente por padrão, criada no instante `n`. */
function aprovacao(n: number, extra: Partial<Aprovacao> = {}): Aprovacao {
  return {
    id: `apr${String(n).padStart(13, '0')}`,
    botId: BOT_A,
    mensagemId: idMensagem(2),
    ferramenta: 'Bash',
    resumo: `comando ${n}`,
    estado: 'pendente',
    criadaEm: n,
    resolvidaEm: null,
    ...extra,
  };
}

function resolvida(n: number, estado: Exclude<Aprovacao['estado'], 'pendente'>, extra: Partial<Aprovacao> = {}): Aprovacao {
  return aprovacao(n, { estado, resolvidaEm: n + 100, ...extra });
}

function mensagem(seq: number, estado: Mensagem['estado'] = 'completa'): Mensagem {
  return {
    id: idMensagem(seq),
    botId: BOT_A,
    seq,
    papel: seq % 2 === 1 ? 'usuario' : 'bot',
    texto: `texto ${seq}`,
    estado,
    criadaEm: seq,
  };
}

const pedida = (dados: Aprovacao) => ({ tipo: 'aprovacao_pedida', aprovacao: dados }) as const;
const resolvidaPorEvento = (dados: Aprovacao) => ({ tipo: 'aprovacao_resolvida', aprovacao: dados }) as const;

function com(...aprovacoes: Aprovacao[]): EstadoAprovacoes {
  return aprovacoes.reduce((estado, dados) => aplicarEventoDeAprovacao(estado, pedida(dados)), APROVACOES_VAZIAS);
}

const estados = (estado: EstadoAprovacoes): Record<string, string> =>
  Object.fromEntries(Object.values(estado.porId).map((dados) => [dados.resumo, dados.estado]));

describe('aplicarEventoDeAprovacao', () => {
  it('aprovacao_pedida guarda o pedido pendente e sobe a revisão', () => {
    const estado = aplicarEventoDeAprovacao(APROVACOES_VAZIAS, pedida(aprovacao(1)));
    expect(estado.porId[aprovacao(1).id]).toEqual(aprovacao(1));
    expect(estado.revisao).toBe(1);
  });

  it.each(['aprovada', 'negada', 'expirada'] as const)('aprovacao_resolvida troca o pendente pelo desfecho %s', (desfecho) => {
    const estado = aplicarEventoDeAprovacao(com(aprovacao(1)), resolvidaPorEvento(resolvida(1, desfecho)));
    expect(estado.porId[aprovacao(1).id]).toEqual(resolvida(1, desfecho));
    expect(estado.revisao).toBe(2);
  });

  it('aprovacao_resolvida de um pedido desconhecido entra do mesmo jeito', () => {
    const estado = aplicarEventoDeAprovacao(APROVACOES_VAZIAS, resolvidaPorEvento(resolvida(7, 'expirada')));
    expect(estados(estado)).toEqual({ 'comando 7': 'expirada' });
    expect(estado.revisao).toBe(1);
  });

  it('pedido resolvido não volta a pendente com um aprovacao_pedida atrasado', () => {
    const resolvido = aplicarEventoDeAprovacao(com(aprovacao(1)), resolvidaPorEvento(resolvida(1, 'negada')));
    const estado = aplicarEventoDeAprovacao(resolvido, pedida(aprovacao(1)));
    expect(estados(estado)).toEqual({ 'comando 1': 'negada' });
    expect(estado.revisao).toBe(resolvido.revisao + 1);
  });

  it('não muda o estado recebido', () => {
    const antes = com(aprovacao(1));
    const congelado = Object.freeze({ ...antes, porId: Object.freeze({ ...antes.porId }) });
    expect(() => aplicarEventoDeAprovacao(congelado, resolvidaPorEvento(resolvida(1, 'aprovada')))).not.toThrow();
    expect(estados(congelado)).toEqual({ 'comando 1': 'pendente' });
  });
});

describe('aplicarDecisao', () => {
  it('guarda a aprovação resolvida que o servidor devolveu, sem mexer na revisão', () => {
    const antes = com(aprovacao(1));
    const estado = aplicarDecisao(antes, resolvida(1, 'aprovada'));
    expect(estados(estado)).toEqual({ 'comando 1': 'aprovada' });
    expect(estado.revisao).toBe(antes.revisao);
  });

  it('não desfaz o desfecho que já chegou por evento', () => {
    const expirada = aplicarEventoDeAprovacao(com(aprovacao(1)), resolvidaPorEvento(resolvida(1, 'expirada')));
    expect(aplicarDecisao(expirada, resolvida(1, 'aprovada'))).toBe(expirada);
  });
});

describe('aplicarPendentes', () => {
  it('a primeira lista põe os pendentes no estado', () => {
    const estado = aplicarPendentes(APROVACOES_VAZIAS, [aprovacao(1), aprovacao(2, { botId: BOT_B })], 0);
    expect(estados(estado)).toEqual({ 'comando 1': 'pendente', 'comando 2': 'pendente' });
    expect(estado.revisao).toBe(0);
  });

  it('lista em dia tira o pendente que não veio nela: ele deixou de ser pendente no servidor', () => {
    const antes = com(aprovacao(1), aprovacao(2));
    const estado = aplicarPendentes(antes, [aprovacao(2)], antes.revisao);
    expect(estados(estado)).toEqual({ 'comando 2': 'pendente' });
  });

  it('lista em dia e vazia tira todos os pendentes e deixa os resolvidos', () => {
    const antes = aplicarEventoDeAprovacao(com(aprovacao(1), aprovacao(2)), resolvidaPorEvento(resolvida(1, 'aprovada')));
    const estado = aplicarPendentes(antes, [], antes.revisao);
    expect(estados(estado)).toEqual({ 'comando 1': 'aprovada' });
  });

  it('lista igual ao que o app já tem devolve o mesmo estado', () => {
    const antes = com(aprovacao(1), aprovacao(2));
    expect(aplicarPendentes(antes, [aprovacao(1), aprovacao(2)], antes.revisao)).toBe(antes);
  });

  it('pendente da lista não desfaz o desfecho que o app já conhece', () => {
    const antes = aplicarEventoDeAprovacao(com(aprovacao(1)), resolvidaPorEvento(resolvida(1, 'negada')));
    const estado = aplicarPendentes(antes, [aprovacao(1)], antes.revisao);
    expect(estados(estado)).toEqual({ 'comando 1': 'negada' });
  });

  describe('lista que pode ser mais velha que um evento', () => {
    it('não tira o pedido que chegou por evento durante a busca', () => {
      const antes = com(aprovacao(1));
      // A lista foi montada só com o pedido 1; o 2 nasceu depois e chegou por evento antes dela.
      const comEvento = aplicarEventoDeAprovacao(antes, pedida(aprovacao(2)));
      const estado = aplicarPendentes(comEvento, [aprovacao(1)], antes.revisao);
      expect(estados(estado)).toEqual({ 'comando 1': 'pendente', 'comando 2': 'pendente' });
    });

    it('não devolve a pendente o pedido resolvido por evento durante a busca', () => {
      const antes = com(aprovacao(1));
      const comEvento = aplicarEventoDeAprovacao(antes, resolvidaPorEvento(resolvida(1, 'aprovada')));
      const estado = aplicarPendentes(comEvento, [aprovacao(1)], antes.revisao);
      expect(estados(estado)).toEqual({ 'comando 1': 'aprovada' });
    });

    it('não tira nenhum pendente, nem o que de fato já foi resolvido: isso fica para a busca seguinte', () => {
      const antes = com(aprovacao(1), aprovacao(2));
      const comEvento = aplicarEventoDeAprovacao(antes, pedida(aprovacao(3)));
      const estado = aplicarPendentes(comEvento, [aprovacao(2)], antes.revisao);
      expect(estados(estado)).toEqual({ 'comando 1': 'pendente', 'comando 2': 'pendente', 'comando 3': 'pendente' });
    });

    it('ainda acrescenta o pedido que o app não conhecia', () => {
      const antes = com(aprovacao(1));
      const comEvento = aplicarEventoDeAprovacao(antes, pedida(aprovacao(2)));
      const estado = aplicarPendentes(comEvento, [aprovacao(1), aprovacao(9)], antes.revisao);
      expect(Object.keys(estados(estado)).sort()).toEqual(['comando 1', 'comando 2', 'comando 9']);
    });

    it('a busca seguinte, em dia, faz a limpeza', () => {
      const antes = com(aprovacao(1), aprovacao(2));
      const comEvento = aplicarEventoDeAprovacao(antes, pedida(aprovacao(3)));
      const velha = aplicarPendentes(comEvento, [aprovacao(2)], antes.revisao);
      const estado = aplicarPendentes(velha, [aprovacao(2), aprovacao(3)], velha.revisao);
      expect(estados(estado)).toEqual({ 'comando 2': 'pendente', 'comando 3': 'pendente' });
    });
  });
});

describe('aprovacoesDoBot', () => {
  it('devolve só as do bot, da mais antiga para a mais nova', () => {
    const estado = com(aprovacao(3), aprovacao(1), aprovacao(2, { botId: BOT_B }), resolvida(4, 'negada'));
    expect(aprovacoesDoBot(estado, BOT_A).map((dados) => dados.criadaEm)).toEqual([1, 3, 4]);
    expect(aprovacoesDoBot(estado, BOT_B).map((dados) => dados.criadaEm)).toEqual([2]);
    expect(aprovacoesDoBot(estado, 'bot0000000000009')).toEqual([]);
  });

  it('desempata pelo id quando duas nasceram no mesmo instante', () => {
    const estado = com(aprovacao(2, { criadaEm: 5 }), aprovacao(1, { criadaEm: 5 }));
    expect(aprovacoesDoBot(estado, BOT_A).map((dados) => dados.resumo)).toEqual(['comando 1', 'comando 2']);
  });
});

describe('situacaoDoBot', () => {
  const parado = { id: BOT_A, turnoAtivo: false };
  const respondendo = { id: BOT_A, turnoAtivo: true };

  it('bot parado e sem pedido não tem situação', () => {
    expect(situacaoDoBot(parado, APROVACOES_VAZIAS)).toBeNull();
  });

  it('bot com turno ativo está respondendo', () => {
    expect(situacaoDoBot(respondendo, APROVACOES_VAZIAS)).toBe('respondendo');
  });

  it('pedido pendente vem antes de respondendo', () => {
    expect(situacaoDoBot(respondendo, com(aprovacao(1)))).toBe('aguardando_aprovacao');
  });

  it('pedido pendente aparece mesmo se o app ainda não sabe do turno', () => {
    expect(situacaoDoBot(parado, com(aprovacao(1)))).toBe('aguardando_aprovacao');
  });

  it('pedido de outro bot ou já resolvido não conta', () => {
    expect(situacaoDoBot(respondendo, com(aprovacao(1, { botId: BOT_B })))).toBe('respondendo');
    expect(situacaoDoBot(respondendo, com(resolvida(1, 'aprovada')))).toBe('respondendo');
    expect(situacaoDoBot(parado, com(resolvida(1, 'expirada')))).toBeNull();
  });

  it('os rótulos são os da lista de bots', () => {
    expect(rotuloDaSituacao('aguardando_aprovacao')).toBe('aguardando aprovação');
    expect(rotuloDaSituacao('respondendo')).toBe('respondendo…');
  });
});

describe('rotuloDoDesfecho', () => {
  it('nomeia cada desfecho e não rotula o pendente', () => {
    expect(rotuloDoDesfecho('aprovada')).toBe('Aprovada');
    expect(rotuloDoDesfecho('negada')).toBe('Negada');
    expect(rotuloDoDesfecho('expirada')).toBe('Expirada');
    expect(rotuloDoDesfecho('pendente')).toBeNull();
  });
});

describe('intercalarAprovacoes', () => {
  /** Mensagens 1 a 4, da mais nova para a mais antiga, como a tela usa. */
  const mensagens = [mensagem(4, 'em_andamento'), mensagem(3), mensagem(2), mensagem(1)];
  const chaves = (itens: ReturnType<typeof intercalarAprovacoes>): string[] =>
    itens.map((item) => (ehAprovacao(item) ? `a${item.criadaEm}` : `m${item.seq}`));

  it('sem aprovações, devolve as mensagens como vieram', () => {
    expect(intercalarAprovacoes(mensagens, [])).toEqual(mensagens);
  });

  it('põe o pedido pendente depois da resposta em andamento, no fim da conversa', () => {
    const itens = intercalarAprovacoes(mensagens, [aprovacao(1, { mensagemId: idMensagem(4) })]);
    expect(chaves(itens)).toEqual(['a1', 'm4', 'm3', 'm2', 'm1']);
  });

  it('põe cada pedido logo depois da resposta em que surgiu, do mais antigo para o mais novo', () => {
    const itens = intercalarAprovacoes(mensagens, [
      aprovacao(3, { mensagemId: idMensagem(4) }),
      resolvida(1, 'aprovada', { mensagemId: idMensagem(2) }),
      resolvida(2, 'negada', { mensagemId: idMensagem(2) }),
    ]);
    // Lista invertida: lida de trás para a frente, dá m1, m2, a1, a2, m3, m4, a3.
    expect(chaves(itens)).toEqual(['a3', 'm4', 'm3', 'a2', 'a1', 'm2', 'm1']);
  });

  it('pedido pendente de mensagem que o app ainda não tem fica no fim da conversa, à vista', () => {
    const itens = intercalarAprovacoes(mensagens, [aprovacao(1, { mensagemId: idMensagem(6) })]);
    expect(chaves(itens)).toEqual(['a1', 'm4', 'm3', 'm2', 'm1']);
    expect(chaves(intercalarAprovacoes([], [aprovacao(1), aprovacao(2)]))).toEqual(['a2', 'a1']);
  });

  it('pedido resolvido de mensagem que o app não tem não aparece', () => {
    const itens = intercalarAprovacoes(mensagens, [resolvida(1, 'expirada', { mensagemId: idMensagem(6) })]);
    expect(chaves(itens)).toEqual(['m4', 'm3', 'm2', 'm1']);
  });

  it('reaproveita os objetos de mensagem e de aprovação', () => {
    const pendente = aprovacao(1, { mensagemId: idMensagem(4) });
    const itens = intercalarAprovacoes(mensagens, [pendente]);
    expect(itens[0]).toBe(pendente);
    expect(itens[1]).toBe(mensagens[0]);
  });

  it('a chave separa mensagem de aprovação', () => {
    const pendente = aprovacao(1);
    expect(chaveDoItem(pendente)).toBe(`aprovacao:${pendente.id}`);
    expect(chaveDoItem(mensagem(1))).toBe(`mensagem:${idMensagem(1)}`);
    expect(ehAprovacao(pendente)).toBe(true);
    expect(ehAprovacao(mensagem(1))).toBe(false);
  });
});
