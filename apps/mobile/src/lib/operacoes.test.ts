import { describe, expect, it, vi } from 'vitest';
import type { Aprovacao, Bot, ListaAprovacoes, ListaBots, ListaMensagens, Mensagem } from '@awikabot/core';
import type { Api } from './api';
import { criarArmazemDados } from './dados';
import { ErroApi } from './erros';
import { criarOperacoes } from './operacoes';

const BOT = 'bot0000000000001';

function bot(extra: Partial<Bot> = {}): Bot {
  return { id: BOT, nome: 'Ajudante', instrucoes: '', modelo: null, criadoEm: 1, atualizadoEm: 1, turnoAtivo: false, ...extra };
}

function msg(seq: number, estado: Mensagem['estado'] = 'completa'): Mensagem {
  return {
    id: `msg${String(seq).padStart(13, '0')}`,
    botId: BOT,
    seq,
    papel: seq % 2 === 1 ? 'usuario' : 'bot',
    texto: `texto ${seq}`,
    estado,
    criadaEm: seq,
  };
}

/** Pedido de aprovação `n` do bot, pendente por padrão. */
function apr(n: number, estado: Aprovacao['estado'] = 'pendente'): Aprovacao {
  return {
    id: `apr${String(n).padStart(13, '0')}`,
    botId: BOT,
    mensagemId: msg(2).id,
    ferramenta: 'Bash',
    resumo: `comando ${n}`,
    estado,
    criadaEm: n,
    resolvidaEm: estado === 'pendente' ? null : n + 100,
  };
}

/** O estado de cada aprovação no armazém, pelo resumo dela. */
function estadosDe(armazem: ReturnType<typeof criarArmazemDados>): Record<string, string> {
  return Object.fromEntries(Object.values(armazem.estado().aprovacoes.porId).map((dados) => [dados.resumo, dados.estado]));
}

function faixa(de: number, ate: number): Mensagem[] {
  return Array.from({ length: ate - de + 1 }, (_, indice) => msg(de + indice));
}

/** Promessa que o teste resolve quando quiser, para simular um pedido em curso. */
function adiada<T>() {
  let resolver: (valor: T) => void = () => {};
  let rejeitar: (erro: unknown) => void = () => {};
  const promessa = new Promise<T>((ok, falha) => {
    resolver = ok;
    rejeitar = falha;
  });
  return { promessa, resolver, rejeitar };
}

function montar(parcial: Partial<Api> = {}) {
  const naoUsada = (nome: string) => () => Promise.reject(new Error(`chamada inesperada: ${nome}`));
  const api: Api = {
    parear: naoUsada('parear'),
    listarBots: naoUsada('listarBots'),
    criarBot: naoUsada('criarBot'),
    editarBot: naoUsada('editarBot'),
    listarMensagens: naoUsada('listarMensagens'),
    enviarTurno: naoUsada('enviarTurno'),
    pararTurno: naoUsada('pararTurno'),
    listarAprovacoes: naoUsada('listarAprovacoes'),
    decidirAprovacao: naoUsada('decidirAprovacao'),
    revogarDispositivo: naoUsada('revogarDispositivo'),
    ...parcial,
  };
  const armazem = criarArmazemDados();
  return { api, armazem, operacoes: criarOperacoes(api, armazem) };
}

/** Cada chamada recebe o próximo pedido da lista, na ordem. */
function emOrdem<T>(pedidos: { promessa: Promise<T> }[]): () => Promise<T> {
  let proximo = 0;
  return () => {
    const pedido = pedidos[proximo];
    proximo += 1;
    return pedido ? pedido.promessa : Promise.reject(new Error('pedido além do previsto'));
  };
}

const seqsDe = (armazem: ReturnType<typeof criarArmazemDados>): number[] =>
  (armazem.estado().conversas[BOT]?.mensagens ?? []).map((mensagem) => mensagem.seq);

describe('carregarBots', () => {
  it('põe a lista no armazém', async () => {
    const { armazem, operacoes } = montar({ listarBots: async () => ({ bots: [bot()] }) });
    await operacoes.carregarBots();
    expect(armazem.estado().bots).toEqual([bot()]);
  });

  it('deixa o armazém como estava quando o pedido falha', async () => {
    const { armazem, operacoes } = montar({ listarBots: () => Promise.reject(new ErroApi('rede', null)) });
    await expect(operacoes.carregarBots()).rejects.toMatchObject({ codigo: 'rede' });
    expect(armazem.estado().bots).toBeNull();
  });

  it('busca de novo se a lista mudou por evento durante o pedido', async () => {
    const pedidos = [adiada<ListaBots>(), adiada<ListaBots>()];
    const listarBots = vi.fn(emOrdem(pedidos));
    const { armazem, operacoes } = montar({ listarBots });
    armazem.despachar({ tipo: 'bots_carregados', bots: [bot({ turnoAtivo: true })] });

    const carga = operacoes.carregarBots();
    // O turno termina depois que o servidor montou a resposta, e o evento chega antes dela.
    armazem.despachar({ tipo: 'evento', evento: { tipo: 'turno_terminado', botId: BOT, mensagem: msg(2) } });
    pedidos[0]?.resolver({ bots: [bot({ turnoAtivo: true })] });
    await vi.waitFor(() => expect(listarBots).toHaveBeenCalledTimes(2));
    expect(armazem.estado().bots?.[0]?.turnoAtivo).toBe(false);

    pedidos[1]?.resolver({ bots: [bot({ turnoAtivo: false, nome: 'Atual' })] });
    await carga;
    expect(armazem.estado().bots).toEqual([bot({ nome: 'Atual' })]);
  });

  it('aceita a primeira lista mesmo com mudança no meio, e para depois de três rodadas', async () => {
    const armazem = criarArmazemDados();
    let rodada = 0;
    const listarBots = vi.fn(async (): Promise<ListaBots> => {
      rodada += 1;
      // Toda rodada é atropelada por um evento que muda a lista.
      armazem.despachar({ tipo: 'evento', evento: { tipo: 'bot_salvo', bot: bot() } });
      return { bots: [bot({ nome: `rodada ${rodada}` })] };
    });
    const operacoes = criarOperacoes({ ...montar().api, listarBots }, armazem);

    await operacoes.carregarBots();

    expect(listarBots).toHaveBeenCalledTimes(3);
    expect(armazem.estado().bots?.[0]?.nome).toBe('rodada 3');
  });

  it('chamadas simultâneas dividem a carga e pedem mais uma rodada', async () => {
    const pedidos = [adiada<ListaBots>(), adiada<ListaBots>()];
    const listarBots = vi.fn(emOrdem(pedidos));
    const { armazem, operacoes } = montar({ listarBots });

    const primeira = operacoes.carregarBots();
    const segunda = operacoes.carregarBots();
    expect(segunda).toBe(primeira);
    expect(listarBots).toHaveBeenCalledTimes(1);

    pedidos[0]?.resolver({ bots: [] });
    await vi.waitFor(() => expect(listarBots).toHaveBeenCalledTimes(2));
    pedidos[1]?.resolver({ bots: [bot()] });
    await primeira;
    expect(armazem.estado().bots).toEqual([bot()]);

    // Terminada a carga, a próxima chamada começa outra.
    pedidos.push(adiada<ListaBots>());
    const terceira = operacoes.carregarBots();
    expect(terceira).not.toBe(primeira);
    pedidos[2]?.resolver({ bots: [] });
    await terceira;
  });

  it('uma carga que falhou não trava a seguinte', async () => {
    const listarBots = vi
      .fn<() => Promise<ListaBots>>()
      .mockRejectedValueOnce(new ErroApi('rede', null))
      .mockResolvedValueOnce({ bots: [bot()] });
    const { armazem, operacoes } = montar({ listarBots });
    await expect(operacoes.carregarBots()).rejects.toBeInstanceOf(ErroApi);
    await operacoes.carregarBots();
    expect(armazem.estado().bots).toEqual([bot()]);
  });
});

describe('criarBot e editarBot', () => {
  it('criarBot devolve o bot e o põe na lista', async () => {
    const criarBot = vi.fn(async () => bot());
    const { armazem, operacoes } = montar({ criarBot });
    armazem.despachar({ tipo: 'bots_carregados', bots: [] });

    await expect(operacoes.criarBot({ nome: 'Ajudante', instrucoes: '', modelo: null })).resolves.toEqual(bot());

    expect(criarBot).toHaveBeenCalledWith({ nome: 'Ajudante', instrucoes: '', modelo: null });
    expect(armazem.estado().bots).toEqual([bot()]);
  });

  it('editarBot troca o bot na lista', async () => {
    const editarBot = vi.fn(async () => bot({ nome: 'Novo' }));
    const { armazem, operacoes } = montar({ editarBot });
    armazem.despachar({ tipo: 'bots_carregados', bots: [bot()] });

    await operacoes.editarBot(BOT, { nome: 'Novo' });

    expect(editarBot).toHaveBeenCalledWith(BOT, { nome: 'Novo' });
    expect(armazem.estado().bots?.[0]?.nome).toBe('Novo');
  });

  it('erro do servidor passa adiante sem mexer na lista', async () => {
    const { armazem, operacoes } = montar({ editarBot: () => Promise.reject(new ErroApi('nao_encontrado', 404)) });
    armazem.despachar({ tipo: 'bots_carregados', bots: [bot()] });
    await expect(operacoes.editarBot(BOT, { nome: 'Novo' })).rejects.toMatchObject({ codigo: 'nao_encontrado' });
    expect(armazem.estado().bots).toEqual([bot()]);
  });
});

describe('carregarConversa', () => {
  it('abre a conversa e busca a página mais recente com o limite do contrato', async () => {
    const listarMensagens = vi.fn(async () => ({ mensagens: faixa(1, 2), temMais: false }));
    const { armazem, operacoes } = montar({ listarMensagens });

    const carga = operacoes.carregarConversa(BOT);
    expect(armazem.estado().conversas[BOT]?.carregada).toBe(false);
    await carga;

    expect(listarMensagens).toHaveBeenCalledWith(BOT, { limite: 50 });
    expect(seqsDe(armazem)).toEqual([1, 2]);
    expect(armazem.estado().conversas[BOT]?.carregada).toBe(true);
  });

  it('pedido de recarga durante uma carga vira mais uma rodada', async () => {
    const pedidos = [adiada<ListaMensagens>(), adiada<ListaMensagens>()];
    const listarMensagens = vi.fn(emOrdem(pedidos));
    const { armazem, operacoes } = montar({ listarMensagens });

    const carga = operacoes.carregarConversa(BOT);
    // O aviso de ressincronizar chega com a primeira busca ainda em curso.
    armazem.despachar({ tipo: 'evento', evento: { tipo: 'ressincronizar' } });
    expect(operacoes.carregarConversa(BOT)).toBe(carga);
    pedidos[0]?.resolver({ mensagens: faixa(1, 2), temMais: false });
    await vi.waitFor(() => expect(listarMensagens).toHaveBeenCalledTimes(2));
    pedidos[1]?.resolver({ mensagens: faixa(1, 4), temMais: false });
    await carga;

    expect(seqsDe(armazem)).toEqual([1, 2, 3, 4]);
    expect(armazem.estado().conversas[BOT]?.desatualizada).toBe(false);
  });

  it('ressincronizar durante a busca faz buscar de novo, mesmo sem outra chamada', async () => {
    const pedidos = [adiada<ListaMensagens>(), adiada<ListaMensagens>()];
    const listarMensagens = vi.fn(emOrdem(pedidos));
    const { armazem, operacoes } = montar({ listarMensagens });

    const carga = operacoes.carregarConversa(BOT);
    armazem.despachar({ tipo: 'evento', evento: { tipo: 'ressincronizar' } });
    // Página montada antes da perda: sozinha, ela apagaria a marca e a conversa ficaria velha.
    pedidos[0]?.resolver({ mensagens: faixa(1, 2), temMais: false });
    await vi.waitFor(() => expect(listarMensagens).toHaveBeenCalledTimes(2));
    pedidos[1]?.resolver({ mensagens: faixa(1, 4), temMais: false });
    await carga;

    expect(seqsDe(armazem)).toEqual([1, 2, 3, 4]);
    expect(listarMensagens).toHaveBeenCalledTimes(2);
  });

  it('para de buscar sozinha depois de três rodadas atropeladas', async () => {
    const armazem = criarArmazemDados();
    const listarMensagens = vi.fn(async (): Promise<ListaMensagens> => {
      armazem.despachar({ tipo: 'evento', evento: { tipo: 'ressincronizar' } });
      return { mensagens: faixa(1, 2), temMais: false };
    });
    const operacoes = criarOperacoes({ ...montar().api, listarMensagens }, armazem);

    await operacoes.carregarConversa(BOT);

    expect(listarMensagens).toHaveBeenCalledTimes(3);
    expect(armazem.estado().conversas[BOT]?.carregada).toBe(true);
  });

  it('falha de rede deixa a conversa aberta e sem carregar', async () => {
    const { armazem, operacoes } = montar({ listarMensagens: () => Promise.reject(new ErroApi('rede', null)) });
    await expect(operacoes.carregarConversa(BOT)).rejects.toMatchObject({ codigo: 'rede' });
    expect(armazem.estado().conversas[BOT]?.carregada).toBe(false);
  });
});

describe('carregarAnteriores', () => {
  function comRecente(listarMensagens: Api['listarMensagens']) {
    const montado = montar({ listarMensagens });
    montado.armazem.despachar({ tipo: 'conversa_aberta', botId: BOT });
    montado.armazem.despachar({ tipo: 'pagina_recente', botId: BOT, pagina: { mensagens: faixa(51, 100), temMais: true } });
    return montado;
  }

  it('pede as mensagens anteriores à mais antiga e as põe no começo', async () => {
    const listarMensagens = vi.fn(async () => ({ mensagens: faixa(1, 50), temMais: false }));
    const { armazem, operacoes } = comRecente(listarMensagens);

    await operacoes.carregarAnteriores(BOT);

    expect(listarMensagens).toHaveBeenCalledWith(BOT, { antes: 51, limite: 50 });
    expect(seqsDe(armazem)).toEqual(faixa(1, 100).map((mensagem) => mensagem.seq));
    expect(armazem.estado().conversas[BOT]?.temMais).toBe(false);
  });

  it('não pede nada quando não há mais mensagens antigas', async () => {
    const listarMensagens = vi.fn(async () => ({ mensagens: faixa(1, 50), temMais: false }));
    const { operacoes } = comRecente(listarMensagens);
    await operacoes.carregarAnteriores(BOT);
    await operacoes.carregarAnteriores(BOT);
    expect(listarMensagens).toHaveBeenCalledTimes(1);
  });

  it('não pede nada para conversa que não está aberta', async () => {
    const listarMensagens = vi.fn();
    const { operacoes } = montar({ listarMensagens });
    await operacoes.carregarAnteriores(BOT);
    expect(listarMensagens).not.toHaveBeenCalled();
  });

  it('chamadas repetidas enquanto a página não chega fazem um pedido só', async () => {
    const pedido = adiada<ListaMensagens>();
    const listarMensagens = vi.fn(() => pedido.promessa);
    const { armazem, operacoes } = comRecente(listarMensagens);

    const primeira = operacoes.carregarAnteriores(BOT);
    const segunda = operacoes.carregarAnteriores(BOT);
    pedido.resolver({ mensagens: faixa(1, 50), temMais: false });
    await Promise.all([primeira, segunda]);

    expect(listarMensagens).toHaveBeenCalledTimes(1);
    expect(seqsDe(armazem)).toHaveLength(100);
  });

  it('depois de uma falha, a próxima chamada tenta de novo', async () => {
    const listarMensagens = vi
      .fn<Api['listarMensagens']>()
      .mockRejectedValueOnce(new ErroApi('rede', null))
      .mockResolvedValueOnce({ mensagens: faixa(1, 50), temMais: false });
    const { armazem, operacoes } = comRecente(listarMensagens);
    await expect(operacoes.carregarAnteriores(BOT)).rejects.toBeInstanceOf(ErroApi);
    await operacoes.carregarAnteriores(BOT);
    expect(seqsDe(armazem)).toHaveLength(100);
  });
});

describe('enviar', () => {
  const resposta = { usuario: msg(3), bot: msg(4, 'em_andamento') };

  function comConversa(parcial: Partial<Api>) {
    const montado = montar(parcial);
    montado.armazem.despachar({ tipo: 'bots_carregados', bots: [bot()] });
    montado.armazem.despachar({ tipo: 'conversa_aberta', botId: BOT });
    montado.armazem.despachar({ tipo: 'pagina_recente', botId: BOT, pagina: { mensagens: faixa(1, 2), temMais: false } });
    return montado;
  }

  it('manda o texto sem espaços nas pontas e põe as duas mensagens na conversa', async () => {
    const enviarTurno = vi.fn(async () => resposta);
    const { armazem, operacoes } = comConversa({ enviarTurno });

    await operacoes.enviar(BOT, '  oi  ');

    expect(enviarTurno).toHaveBeenCalledWith(BOT, { texto: 'oi' });
    expect(seqsDe(armazem)).toEqual([1, 2, 3, 4]);
    expect(armazem.estado().bots?.[0]?.turnoAtivo).toBe(true);
  });

  it('não chama o servidor com texto vazio', async () => {
    const enviarTurno = vi.fn(async () => resposta);
    const { operacoes } = comConversa({ enviarTurno });
    await expect(operacoes.enviar(BOT, '   ')).rejects.toMatchObject({ codigo: 'dados_invalidos' });
    expect(enviarTurno).not.toHaveBeenCalled();
  });

  it('com turno_em_andamento, repassa o erro e busca a lista de bots', async () => {
    const listarBots = vi.fn(async () => ({ bots: [bot({ turnoAtivo: true })] }));
    const { armazem, operacoes } = comConversa({
      enviarTurno: () => Promise.reject(new ErroApi('turno_em_andamento', 409)),
      listarBots,
    });

    await expect(operacoes.enviar(BOT, 'oi')).rejects.toMatchObject({ codigo: 'turno_em_andamento' });
    await vi.waitFor(() => expect(armazem.estado().bots?.[0]?.turnoAtivo).toBe(true));
    expect(seqsDe(armazem)).toEqual([1, 2]);
  });

  it.each([
    ['limite_de_turnos', 429],
    ['rede', null],
    ['erro_interno', 500],
  ] as const)('o erro %s passa adiante sem buscar nada', async (codigo, status) => {
    const listarBots = vi.fn(async () => ({ bots: [] }));
    const listarMensagens = vi.fn(async () => ({ mensagens: faixa(1, 2), temMais: false }));
    const { operacoes } = comConversa({
      enviarTurno: () => Promise.reject(new ErroApi(codigo, status)),
      listarBots,
      listarMensagens,
    });
    await expect(operacoes.enviar(BOT, 'oi')).rejects.toMatchObject({ codigo });
    expect(listarBots).not.toHaveBeenCalled();
    expect(listarMensagens).not.toHaveBeenCalled();
  });

  describe('quando o POST demora demais', () => {
    const demorou = (): Promise<never> => Promise.reject(new ErroApi('tempo_esgotado', null));
    const usuario: Mensagem = { ...msg(3), texto: 'oi' };

    it('busca a conversa; se o servidor criou o turno, ele aparece e o envio conta como feito', async () => {
      const listarMensagens = vi.fn(async () => ({
        mensagens: [...faixa(1, 2), usuario, msg(4, 'em_andamento')],
        temMais: false,
      }));
      const { armazem, operacoes } = comConversa({ enviarTurno: demorou, listarMensagens });

      await expect(operacoes.enviar(BOT, ' oi ')).resolves.toBeUndefined();

      expect(listarMensagens).toHaveBeenCalledTimes(1);
      expect(seqsDe(armazem)).toEqual([1, 2, 3, 4]);
    });

    it('se o servidor não criou o turno, devolve o erro da demora', async () => {
      const listarMensagens = vi.fn(async () => ({ mensagens: faixa(1, 2), temMais: false }));
      const { armazem, operacoes } = comConversa({ enviarTurno: demorou, listarMensagens });

      await expect(operacoes.enviar(BOT, 'oi')).rejects.toMatchObject({ codigo: 'tempo_esgotado' });

      expect(listarMensagens).toHaveBeenCalledTimes(1);
      expect(seqsDe(armazem)).toEqual([1, 2]);
    });

    it('mensagem igual que já estava na conversa antes do envio não conta como turno criado', async () => {
      const montado = comConversa({ enviarTurno: demorou });
      const antiga = { mensagens: [...faixa(1, 2), usuario, msg(4)], temMais: false };
      montado.armazem.despachar({ tipo: 'pagina_recente', botId: BOT, pagina: antiga });
      const operacoes = criarOperacoes({ ...montado.api, listarMensagens: async () => antiga }, montado.armazem);

      await expect(operacoes.enviar(BOT, 'oi')).rejects.toMatchObject({ codigo: 'tempo_esgotado' });
    });

    it('mensagem nova de texto diferente não conta como o turno enviado', async () => {
      const listarMensagens = vi.fn(async () => ({
        mensagens: [...faixa(1, 2), { ...usuario, texto: 'outra coisa' }, msg(4, 'em_andamento')],
        temMais: false,
      }));
      const { armazem, operacoes } = comConversa({ enviarTurno: demorou, listarMensagens });

      await expect(operacoes.enviar(BOT, 'oi')).rejects.toMatchObject({ codigo: 'tempo_esgotado' });
      // A conversa fica em dia mesmo assim.
      expect(seqsDe(armazem)).toEqual([1, 2, 3, 4]);
    });

    it('se a busca também falha, devolve o erro da demora', async () => {
      const { operacoes } = comConversa({
        enviarTurno: demorou,
        listarMensagens: () => Promise.reject(new ErroApi('rede', null)),
      });
      await expect(operacoes.enviar(BOT, 'oi')).rejects.toMatchObject({ codigo: 'tempo_esgotado' });
    });
  });
});

describe('parar', () => {
  it('pede a parada do turno atual', async () => {
    const pararTurno = vi.fn(async () => {});
    const { operacoes } = montar({ pararTurno });
    await operacoes.parar(BOT);
    expect(pararTurno).toHaveBeenCalledWith(BOT);
  });

  it('com sem_turno_ativo não falha e atualiza bots e conversa', async () => {
    const listarBots = vi.fn(async () => ({ bots: [bot({ turnoAtivo: false })] }));
    const listarMensagens = vi.fn(async () => ({ mensagens: faixa(1, 4), temMais: false }));
    const { armazem, operacoes } = montar({
      pararTurno: () => Promise.reject(new ErroApi('sem_turno_ativo', 409)),
      listarBots,
      listarMensagens,
    });
    armazem.despachar({ tipo: 'bots_carregados', bots: [bot({ turnoAtivo: true })] });

    await expect(operacoes.parar(BOT)).resolves.toBeUndefined();

    expect(armazem.estado().bots?.[0]?.turnoAtivo).toBe(false);
    expect(seqsDe(armazem)).toEqual([1, 2, 3, 4]);
  });

  it('outros erros passam adiante', async () => {
    const { operacoes } = montar({ pararTurno: () => Promise.reject(new ErroApi('rede', null)) });
    await expect(operacoes.parar(BOT)).rejects.toMatchObject({ codigo: 'rede' });
  });
});

describe('carregarAprovacoes', () => {
  it('põe os pedidos pendentes no armazém', async () => {
    const { armazem, operacoes } = montar({ listarAprovacoes: async () => ({ aprovacoes: [apr(1), apr(2)] }) });
    await operacoes.carregarAprovacoes();
    expect(estadosDe(armazem)).toEqual({ 'comando 1': 'pendente', 'comando 2': 'pendente' });
  });

  it('lista nova sem um pendente conhecido tira esse pedido', async () => {
    const { armazem, operacoes } = montar({ listarAprovacoes: async () => ({ aprovacoes: [apr(2)] }) });
    armazem.despachar({ tipo: 'aprovacoes_carregadas', pendentes: [apr(1), apr(2)], revisao: 0 });

    await operacoes.carregarAprovacoes();

    expect(estadosDe(armazem)).toEqual({ 'comando 2': 'pendente' });
  });

  it('lista atrasada não desfaz o evento que chegou durante a busca, e a busca se repete', async () => {
    const pedidos = [adiada<ListaAprovacoes>(), adiada<ListaAprovacoes>()];
    const listarAprovacoes = vi.fn(emOrdem(pedidos));
    const { armazem, operacoes } = montar({ listarAprovacoes });
    armazem.despachar({ tipo: 'aprovacoes_carregadas', pendentes: [apr(1)], revisao: 0 });

    const carga = operacoes.carregarAprovacoes();
    // O servidor montou a lista só com o pedido 1; depois o 1 foi aprovado e nasceu o 2.
    armazem.despachar({ tipo: 'evento', evento: { tipo: 'aprovacao_resolvida', aprovacao: apr(1, 'aprovada') } });
    armazem.despachar({ tipo: 'evento', evento: { tipo: 'aprovacao_pedida', aprovacao: apr(2) } });
    pedidos[0]?.resolver({ aprovacoes: [apr(1)] });
    await vi.waitFor(() => expect(listarAprovacoes).toHaveBeenCalledTimes(2));
    expect(estadosDe(armazem)).toEqual({ 'comando 1': 'aprovada', 'comando 2': 'pendente' });

    pedidos[1]?.resolver({ aprovacoes: [apr(2)] });
    await carga;
    expect(estadosDe(armazem)).toEqual({ 'comando 1': 'aprovada', 'comando 2': 'pendente' });
    expect(listarAprovacoes).toHaveBeenCalledTimes(2);
  });

  it('falha de rede deixa os pedidos como estavam', async () => {
    const { armazem, operacoes } = montar({ listarAprovacoes: () => Promise.reject(new ErroApi('rede', null)) });
    armazem.despachar({ tipo: 'aprovacoes_carregadas', pendentes: [apr(1)], revisao: 0 });
    await expect(operacoes.carregarAprovacoes()).rejects.toMatchObject({ codigo: 'rede' });
    expect(estadosDe(armazem)).toEqual({ 'comando 1': 'pendente' });
  });
});

describe('decidirAprovacao', () => {
  function comPendente(parcial: Partial<Api>) {
    const montado = montar(parcial);
    montado.armazem.despachar({ tipo: 'aprovacoes_carregadas', pendentes: [apr(1), apr(2)], revisao: 0 });
    return montado;
  }

  it.each([
    ['aprovar', 'aprovada'],
    ['negar', 'negada'],
  ] as const)('manda "%s" e guarda a aprovação %s que o servidor devolveu', async (decisao, desfecho) => {
    const decidirAprovacao = vi.fn(async () => apr(1, desfecho));
    const { armazem, operacoes } = comPendente({ decidirAprovacao });

    await expect(operacoes.decidirAprovacao(apr(1).id, decisao)).resolves.toBe('decidida');

    expect(decidirAprovacao).toHaveBeenCalledWith(apr(1).id, { decisao });
    expect(estadosDe(armazem)).toEqual({ 'comando 1': desfecho, 'comando 2': 'pendente' });
  });

  it('enquanto o servidor não responde, o pedido continua pendente no app', async () => {
    const pedido = adiada<Aprovacao>();
    const { armazem, operacoes } = comPendente({ decidirAprovacao: () => pedido.promessa });
    const antes = armazem.estado();

    const decisao = operacoes.decidirAprovacao(apr(1).id, 'aprovar');
    await Promise.resolve();
    expect(armazem.estado()).toBe(antes);

    pedido.resolver(apr(1, 'aprovada'));
    await decisao;
    expect(estadosDe(armazem)['comando 1']).toBe('aprovada');
  });

  it('vale o que o servidor gravou, não o que a pessoa pediu', async () => {
    // A pessoa tocou em Aprovar, mas o prazo venceu no mesmo instante e o servidor devolve expirada.
    const { armazem, operacoes } = comPendente({ decidirAprovacao: async () => apr(1, 'expirada') });
    await operacoes.decidirAprovacao(apr(1).id, 'aprovar');
    expect(estadosDe(armazem)['comando 1']).toBe('expirada');
  });

  it.each([
    ['ja_resolvida', 409],
    ['nao_encontrado', 404],
  ] as const)('com %s, busca a lista de pendentes e diz que o pedido já estava resolvido', async (codigo, status) => {
    const listarAprovacoes = vi.fn(async () => ({ aprovacoes: [apr(2)] }));
    const { armazem, operacoes } = comPendente({
      decidirAprovacao: () => Promise.reject(new ErroApi(codigo, status)),
      listarAprovacoes,
    });

    await expect(operacoes.decidirAprovacao(apr(1).id, 'aprovar')).resolves.toBe('ja_resolvida');

    expect(listarAprovacoes).toHaveBeenCalledTimes(1);
    // O cartão do pedido 1 some: ele não está mais entre os pendentes do servidor.
    expect(estadosDe(armazem)).toEqual({ 'comando 2': 'pendente' });
  });

  it('com ja_resolvida, se a busca da lista falha, ainda avisa e o cartão fica até a próxima busca', async () => {
    const { armazem, operacoes } = comPendente({
      decidirAprovacao: () => Promise.reject(new ErroApi('ja_resolvida', 409)),
      listarAprovacoes: () => Promise.reject(new ErroApi('rede', null)),
    });
    await expect(operacoes.decidirAprovacao(apr(1).id, 'negar')).resolves.toBe('ja_resolvida');
    expect(estadosDe(armazem)).toEqual({ 'comando 1': 'pendente', 'comando 2': 'pendente' });
  });

  it.each([
    ['rede', null],
    ['tempo_esgotado', null],
    ['erro_interno', 500],
    ['dados_invalidos', 400],
  ] as const)('com %s, repassa o erro, mantém o cartão e não busca nada', async (codigo, status) => {
    const listarAprovacoes = vi.fn(async () => ({ aprovacoes: [] }));
    const { armazem, operacoes } = comPendente({
      decidirAprovacao: () => Promise.reject(new ErroApi(codigo, status)),
      listarAprovacoes,
    });
    const antes = armazem.estado();

    await expect(operacoes.decidirAprovacao(apr(1).id, 'aprovar')).rejects.toMatchObject({ codigo });

    expect(armazem.estado()).toBe(antes);
    expect(listarAprovacoes).not.toHaveBeenCalled();
  });
});
