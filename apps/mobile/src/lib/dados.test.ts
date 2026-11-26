import { describe, expect, it, vi } from 'vitest';
import type { Aprovacao, Bot, Evento, Mensagem } from '@awikabot/core';
import { CONVERSA_VAZIA } from './conversa';
import { DADOS_INICIAIS, criarArmazem, criarArmazemDados, redutorDados, type AcaoDados, type EstadoDados } from './dados';

const BOT_A = 'bot0000000000001';
const BOT_B = 'bot0000000000002';

function bot(id: string, extra: Partial<Bot> = {}): Bot {
  return { id, nome: `Bot ${id.slice(-1)}`, instrucoes: '', modelo: null, motor: 'claude-code', esforco: null, criadoEm: 1, atualizadoEm: 1, turnoAtivo: false, ...extra };
}

function msg(botId: string, seq: number, estado: Mensagem['estado'] = 'completa', texto = `texto ${seq}`): Mensagem {
  return {
    id: `m${botId.slice(-1)}${String(seq).padStart(14, '0')}`,
    botId,
    seq,
    papel: seq % 2 === 1 ? 'usuario' : 'bot',
    texto,
    estado,
    criadaEm: seq,
  };
}

function aplicar(estado: EstadoDados, acoes: AcaoDados[]): EstadoDados {
  return acoes.reduce(redutorDados, estado);
}

const evento = (dados: Evento): AcaoDados => ({ tipo: 'evento', evento: dados });

const comBots = aplicar(DADOS_INICIAIS, [{ tipo: 'bots_carregados', bots: [bot(BOT_A), bot(BOT_B)] }]);

/** Bots carregados e a conversa do bot A aberta com as mensagens 1 e 2. */
const comConversa = aplicar(comBots, [
  { tipo: 'conversa_aberta', botId: BOT_A },
  { tipo: 'pagina_recente', botId: BOT_A, pagina: { mensagens: [msg(BOT_A, 1), msg(BOT_A, 2)], temMais: false } },
]);

describe('redutorDados: bots', () => {
  it('começa sem lista', () => {
    expect(DADOS_INICIAIS.bots).toBeNull();
  });

  it('bots_carregados troca a lista inteira', () => {
    const estado = aplicar(comBots, [{ tipo: 'bots_carregados', bots: [bot(BOT_B)] }]);
    expect(estado.bots?.map((item) => item.id)).toEqual([BOT_B]);
    expect(estado.revisaoBots).toBe(comBots.revisaoBots);
  });

  it('bot_gravado troca o bot de mesmo id no lugar', () => {
    const estado = aplicar(comBots, [{ tipo: 'bot_gravado', bot: bot(BOT_A, { nome: 'Novo nome' }) }]);
    expect(estado.bots?.map((item) => item.nome)).toEqual(['Novo nome', 'Bot 2']);
    expect(estado.revisaoBots).toBe(comBots.revisaoBots + 1);
  });

  it('bot_gravado não desliga o "respondendo" de um bot que o fluxo de eventos marcou', () => {
    const respondendo = aplicar(comBots, [evento({ tipo: 'turno_iniciado', botId: BOT_A, mensagemId: msg(BOT_A, 2).id })]);
    // Resposta de um PATCH montada antes do turno começar, entregue depois do evento.
    const estado = aplicar(respondendo, [{ tipo: 'bot_gravado', bot: bot(BOT_A, { nome: 'Novo nome', turnoAtivo: false }) }]);
    expect(estado.bots?.[0]).toMatchObject({ nome: 'Novo nome', turnoAtivo: true });
  });

  it('bot_gravado não liga o "respondendo" de um bot cujo turno já terminou por evento', () => {
    const estado = aplicar(comBots, [{ tipo: 'bot_gravado', bot: bot(BOT_A, { nome: 'Novo nome', turnoAtivo: true }) }]);
    expect(estado.bots?.[0]).toMatchObject({ nome: 'Novo nome', turnoAtivo: false });
  });

  it('bot_gravado de um bot novo entra como veio', () => {
    const novo = bot('bot0000000000003', { turnoAtivo: true });
    const estado = aplicar(comBots, [{ tipo: 'bot_gravado', bot: novo }]);
    expect(estado.bots?.[2]).toEqual(novo);
  });

  it('o evento bot_salvo, esse sim, muda o "respondendo"', () => {
    const estado = aplicar(comBots, [evento({ tipo: 'bot_salvo', bot: bot(BOT_A, { turnoAtivo: true }) })]);
    expect(estado.bots?.[0]?.turnoAtivo).toBe(true);
  });

  it('bot_gravado põe um bot novo no fim', () => {
    const novo = bot('bot0000000000003');
    const estado = aplicar(comBots, [{ tipo: 'bot_gravado', bot: novo }]);
    expect(estado.bots?.map((item) => item.id)).toEqual([BOT_A, BOT_B, novo.id]);
  });

  it('o evento bot_salvo grava do mesmo jeito e sobe a revisão', () => {
    const estado = aplicar(comBots, [evento({ tipo: 'bot_salvo', bot: bot(BOT_B, { modelo: 'modelo-x' }) })]);
    expect(estado.bots?.[1]?.modelo).toBe('modelo-x');
    expect(estado.revisaoBots).toBe(comBots.revisaoBots + 1);
  });

  it('sem lista carregada, um bot salvo não cria lista parcial', () => {
    const estado = aplicar(DADOS_INICIAIS, [evento({ tipo: 'bot_salvo', bot: bot(BOT_A) })]);
    expect(estado.bots).toBeNull();
    expect(estado.revisaoBots).toBe(1);
  });

  it('turno_iniciado e turno_terminado ligam e desligam o "respondendo" do bot certo', () => {
    const iniciado = aplicar(comBots, [evento({ tipo: 'turno_iniciado', botId: BOT_B, mensagemId: msg(BOT_B, 2).id })]);
    expect(iniciado.bots?.map((item) => item.turnoAtivo)).toEqual([false, true]);
    expect(iniciado.bots?.[0]).toBe(comBots.bots?.[0]);

    const terminado = aplicar(iniciado, [evento({ tipo: 'turno_terminado', botId: BOT_B, mensagem: msg(BOT_B, 2) })]);
    expect(terminado.bots?.map((item) => item.turnoAtivo)).toEqual([false, false]);
    expect(terminado.revisaoBots).toBe(comBots.revisaoBots + 2);
  });

  it('texto não mexe nos bots nem na revisão', () => {
    const estado = aplicar(comBots, [evento({ tipo: 'texto', botId: BOT_A, mensagemId: msg(BOT_A, 2).id, posicao: 0, trecho: 'x' })]);
    expect(estado).toBe(comBots);
  });
});

describe('redutorDados: conversas', () => {
  it('conversa_aberta cria a conversa vazia uma vez só', () => {
    const aberta = aplicar(comBots, [{ tipo: 'conversa_aberta', botId: BOT_A }]);
    expect(aberta.conversas[BOT_A]).toBe(CONVERSA_VAZIA);
    expect(aplicar(aberta, [{ tipo: 'conversa_aberta', botId: BOT_A }])).toBe(aberta);
  });

  it('abrir de novo não apaga o que já estava carregado', () => {
    expect(aplicar(comConversa, [{ tipo: 'conversa_aberta', botId: BOT_A }])).toBe(comConversa);
  });

  it('página de conversa que não está aberta é ignorada', () => {
    const pagina = { mensagens: [msg(BOT_B, 1)], temMais: false };
    expect(aplicar(comConversa, [{ tipo: 'pagina_recente', botId: BOT_B, pagina }])).toBe(comConversa);
    expect(aplicar(comConversa, [{ tipo: 'pagina_anterior', botId: BOT_B, antes: 5, pagina }])).toBe(comConversa);
  });

  it('pagina_anterior emenda no começo da conversa aberta', () => {
    const recente = aplicar(comBots, [
      { tipo: 'conversa_aberta', botId: BOT_A },
      { tipo: 'pagina_recente', botId: BOT_A, pagina: { mensagens: [msg(BOT_A, 3), msg(BOT_A, 4)], temMais: true } },
    ]);
    const estado = aplicar(recente, [
      { tipo: 'pagina_anterior', botId: BOT_A, antes: 3, pagina: { mensagens: [msg(BOT_A, 1), msg(BOT_A, 2)], temMais: false } },
    ]);
    expect(estado.conversas[BOT_A]?.mensagens.map((mensagem) => mensagem.seq)).toEqual([1, 2, 3, 4]);
    expect(estado.conversas[BOT_A]?.temMais).toBe(false);
  });

  it('turno_enviado põe as mensagens na conversa e marca o bot como respondendo', () => {
    const resposta = { usuario: msg(BOT_A, 3), bot: msg(BOT_A, 4, 'em_andamento', '') };
    const estado = aplicar(comConversa, [{ tipo: 'turno_enviado', botId: BOT_A, resposta }]);
    expect(estado.conversas[BOT_A]?.mensagens.map((mensagem) => mensagem.seq)).toEqual([1, 2, 3, 4]);
    expect(estado.bots?.map((item) => item.turnoAtivo)).toEqual([true, false]);
    expect(estado.revisaoBots).toBe(comConversa.revisaoBots + 1);
  });

  it('turno_enviado não marca respondendo se o fim do turno já chegou por evento', () => {
    const final = msg(BOT_A, 4, 'completa', 'pronto');
    const estado = aplicar(comConversa, [
      evento({ tipo: 'turno_iniciado', botId: BOT_A, mensagemId: final.id }),
      evento({ tipo: 'turno_terminado', botId: BOT_A, mensagem: final }),
      { tipo: 'turno_enviado', botId: BOT_A, resposta: { usuario: msg(BOT_A, 3), bot: msg(BOT_A, 4, 'em_andamento', '') } },
    ]);
    expect(estado.bots?.[0]?.turnoAtivo).toBe(false);
    expect(estado.conversas[BOT_A]?.mensagens[3]).toEqual(final);
  });

  it('os eventos do turno chegam à conversa aberta e ao bot', () => {
    const resposta = { usuario: msg(BOT_A, 3), bot: msg(BOT_A, 4, 'em_andamento', '') };
    const final = msg(BOT_A, 4, 'parada', 'Olá');
    const emCurso = aplicar(comConversa, [
      { tipo: 'turno_enviado', botId: BOT_A, resposta },
      evento({ tipo: 'turno_iniciado', botId: BOT_A, mensagemId: resposta.bot.id }),
      evento({ tipo: 'texto', botId: BOT_A, mensagemId: resposta.bot.id, posicao: 0, trecho: 'Olá' }),
    ]);
    expect(emCurso.conversas[BOT_A]?.aoVivo[resposta.bot.id]).toEqual({ texto: 'Olá', adiantados: [] });
    expect(emCurso.bots?.[0]?.turnoAtivo).toBe(true);

    const terminado = aplicar(emCurso, [evento({ tipo: 'turno_terminado', botId: BOT_A, mensagem: final })]);
    expect(terminado.conversas[BOT_A]?.mensagens[3]).toEqual(final);
    expect(terminado.conversas[BOT_A]?.aoVivo).toEqual({});
    expect(terminado.bots?.[0]?.turnoAtivo).toBe(false);
  });

  it('eventos de um bot sem conversa aberta só mexem na lista de bots', () => {
    const estado = aplicar(comConversa, [
      evento({ tipo: 'turno_iniciado', botId: BOT_B, mensagemId: msg(BOT_B, 2).id }),
      evento({ tipo: 'texto', botId: BOT_B, mensagemId: msg(BOT_B, 2).id, posicao: 0, trecho: 'x' }),
    ]);
    expect(estado.conversas).toBe(comConversa.conversas);
    expect(estado.bots?.[1]?.turnoAtivo).toBe(true);
  });

  it('ressincronizar marca todas as conversas abertas', () => {
    const duas = aplicar(comConversa, [
      { tipo: 'conversa_aberta', botId: BOT_B },
      { tipo: 'pagina_recente', botId: BOT_B, pagina: { mensagens: [], temMais: false } },
    ]);
    const estado = aplicar(duas, [evento({ tipo: 'ressincronizar' })]);
    expect(Object.values(estado.conversas).map((conversa) => conversa.desatualizada)).toEqual([true, true]);
    expect(estado.bots).toBe(duas.bots);
  });
});

describe('redutorDados: conexão', () => {
  it('guarda a situação do fluxo de eventos', () => {
    const estado = aplicar(comBots, [{ tipo: 'conexao', conexao: 'conectada' }]);
    expect(estado.conexao).toBe('conectada');
    expect(aplicar(estado, [{ tipo: 'conexao', conexao: 'conectada' }])).toBe(estado);
  });
});

describe('criarArmazem', () => {
  it('aplica a ação e avisa os ouvintes só quando o estado muda', () => {
    const armazem = criarArmazemDados();
    const ouvinte = vi.fn();
    armazem.assinar(ouvinte);

    armazem.despachar({ tipo: 'conexao', conexao: 'conectando' });
    expect(ouvinte).not.toHaveBeenCalled();

    armazem.despachar({ tipo: 'bots_carregados', bots: [bot(BOT_A)] });
    expect(ouvinte).toHaveBeenCalledTimes(1);
    expect(armazem.estado().bots).toHaveLength(1);
  });

  it('quem cancela a assinatura para de ser avisado', () => {
    const armazem = criarArmazem((estado: number, acao: number) => estado + acao, 0);
    const ouvinte = vi.fn();
    const cancelar = armazem.assinar(ouvinte);
    armazem.despachar(1);
    cancelar();
    armazem.despachar(1);
    expect(ouvinte).toHaveBeenCalledTimes(1);
    expect(armazem.estado()).toBe(2);
  });

  it('um ouvinte pode cancelar outro durante o aviso', () => {
    const armazem = criarArmazem((estado: number, acao: number) => estado + acao, 0);
    const segundo = vi.fn();
    let cancelarSegundo = () => {};
    armazem.assinar(() => cancelarSegundo());
    cancelarSegundo = armazem.assinar(segundo);
    expect(() => armazem.despachar(1)).not.toThrow();
  });
});

describe('redutorDados: aprovações', () => {
  function apr(n: number, estado: Aprovacao['estado'] = 'pendente', botId = BOT_A): Aprovacao {
    return {
      id: `apr${String(n).padStart(13, '0')}`,
      botId,
      mensagemId: msg(botId, 2).id,
      ferramenta: 'Bash',
      resumo: `comando ${n}`,
      estado,
      criadaEm: n,
      resolvidaEm: estado === 'pendente' ? null : n + 100,
    };
  }
  const estadosDe = (estado: EstadoDados): Record<string, string> =>
    Object.fromEntries(Object.values(estado.aprovacoes.porId).map((dados) => [dados.resumo, dados.estado]));

  it('começa sem aprovações', () => {
    expect(DADOS_INICIAIS.aprovacoes).toEqual({ porId: {}, revisao: 0 });
  });

  it('os eventos de aprovação entram no armazém e não mexem em bots nem em conversas', () => {
    const pedida = aplicar(comConversa, [evento({ tipo: 'aprovacao_pedida', aprovacao: apr(1) })]);
    expect(estadosDe(pedida)).toEqual({ 'comando 1': 'pendente' });
    expect(pedida.bots).toBe(comConversa.bots);
    expect(pedida.conversas).toBe(comConversa.conversas);
    expect(pedida.revisaoBots).toBe(comConversa.revisaoBots);

    const resolvida = aplicar(pedida, [evento({ tipo: 'aprovacao_resolvida', aprovacao: apr(1, 'negada') })]);
    expect(estadosDe(resolvida)).toEqual({ 'comando 1': 'negada' });
    expect(resolvida.aprovacoes.revisao).toBe(2);
  });

  it('aprovacao_resolvida de um pedido desconhecido não quebra nada', () => {
    const estado = aplicar(comBots, [evento({ tipo: 'aprovacao_resolvida', aprovacao: apr(5, 'expirada', BOT_B) })]);
    expect(estadosDe(estado)).toEqual({ 'comando 5': 'expirada' });
  });

  it('aprovacoes_carregadas em dia troca os pendentes pelos da lista', () => {
    const antes = aplicar(comBots, [
      evento({ tipo: 'aprovacao_pedida', aprovacao: apr(1) }),
      evento({ tipo: 'aprovacao_pedida', aprovacao: apr(2) }),
    ]);
    const estado = aplicar(antes, [{ tipo: 'aprovacoes_carregadas', pendentes: [apr(2), apr(3)], revisao: antes.aprovacoes.revisao }]);
    expect(estadosDe(estado)).toEqual({ 'comando 2': 'pendente', 'comando 3': 'pendente' });
  });

  it('aprovacoes_carregadas com revisão antiga não tira o que chegou por evento', () => {
    const antes = aplicar(comBots, [evento({ tipo: 'aprovacao_pedida', aprovacao: apr(1) })]);
    const estado = aplicar(antes, [{ tipo: 'aprovacoes_carregadas', pendentes: [], revisao: 0 }]);
    expect(estado).toBe(antes);
  });

  it('aprovacao_decidida guarda a resposta do servidor', () => {
    const antes = aplicar(comBots, [evento({ tipo: 'aprovacao_pedida', aprovacao: apr(1) })]);
    const estado = aplicar(antes, [{ tipo: 'aprovacao_decidida', aprovacao: apr(1, 'aprovada') }]);
    expect(estadosDe(estado)).toEqual({ 'comando 1': 'aprovada' });
    expect(aplicar(estado, [{ tipo: 'aprovacao_decidida', aprovacao: apr(1, 'aprovada') }])).toBe(estado);
  });

  it('ressincronizar não apaga as aprovações: quem busca a lista é a operação', () => {
    const antes = aplicar(comConversa, [evento({ tipo: 'aprovacao_pedida', aprovacao: apr(1) })]);
    const estado = aplicar(antes, [evento({ tipo: 'ressincronizar' })]);
    expect(estado.aprovacoes).toBe(antes.aprovacoes);
  });

  it('a página da conversa traz os pedidos já resolvidos, que o app não tinha', () => {
    const pagina = { mensagens: [msg(BOT_A, 1), msg(BOT_A, 2)], temMais: false, aprovacoes: [apr(1, 'aprovada'), apr(2, 'negada')] };
    const estado = aplicar(comBots, [
      { tipo: 'conversa_aberta', botId: BOT_A },
      { tipo: 'pagina_recente', botId: BOT_A, pagina },
    ]);
    expect(estadosDe(estado)).toEqual({ 'comando 1': 'aprovada', 'comando 2': 'negada' });
    expect(estado.aprovacoes.revisao).toBe(0);
    expect(estado.conversas[BOT_A]?.mensagens.map((mensagem) => mensagem.seq)).toEqual([1, 2]);
  });

  it('a página anterior também traz os resolvidos das mensagens antigas', () => {
    const recente = aplicar(comBots, [
      { tipo: 'conversa_aberta', botId: BOT_A },
      { tipo: 'pagina_recente', botId: BOT_A, pagina: { mensagens: [msg(BOT_A, 3), msg(BOT_A, 4)], temMais: true } },
    ]);
    const pagina = { mensagens: [msg(BOT_A, 1), msg(BOT_A, 2)], temMais: false, aprovacoes: [apr(1, 'expirada')] };
    const estado = aplicar(recente, [{ tipo: 'pagina_anterior', botId: BOT_A, antes: 3, pagina }]);
    expect(estadosDe(estado)).toEqual({ 'comando 1': 'expirada' });
  });

  it('página de servidor antigo, sem o campo, não mexe nas aprovações', () => {
    const antes = aplicar(comBots, [{ tipo: 'conversa_aberta', botId: BOT_A }, evento({ tipo: 'aprovacao_pedida', aprovacao: apr(1) })]);
    const estado = aplicar(antes, [{ tipo: 'pagina_recente', botId: BOT_A, pagina: { mensagens: [msg(BOT_A, 1)], temMais: false } }]);
    expect(estado.aprovacoes).toBe(antes.aprovacoes);
  });

  it('o resolvido da página não desfaz o que o app decidiu, e o pendente da página não entra', () => {
    const antes = aplicar(comConversa, [
      evento({ tipo: 'aprovacao_pedida', aprovacao: apr(1) }),
      { tipo: 'aprovacao_decidida', aprovacao: apr(1, 'negada') },
    ]);
    const pagina = { mensagens: [msg(BOT_A, 1), msg(BOT_A, 2)], temMais: false, aprovacoes: [apr(1, 'aprovada'), apr(2)] };
    const estado = aplicar(antes, [{ tipo: 'pagina_recente', botId: BOT_A, pagina }]);
    expect(estadosDe(estado)).toEqual({ 'comando 1': 'negada' });
  });

  it('os eventos de aprovação não mexem na conversa aberta do bot', () => {
    const estado = aplicar(comConversa, [
      evento({ tipo: 'aprovacao_pedida', aprovacao: apr(1) }),
      evento({ tipo: 'aprovacao_resolvida', aprovacao: apr(1, 'aprovada') }),
    ]);
    expect(estado.conversas[BOT_A]).toBe(comConversa.conversas[BOT_A]);
  });
});
