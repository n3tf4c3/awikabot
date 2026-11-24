import { describe, expect, it, vi } from 'vitest';
import type { Aprovacao, Bot, Mensagem } from '@awikabot/core';
import { TEMPO_LIMITE_REVOGACAO_MS, criarApi, type Buscar, type PedidoHttp } from './api';
import { ErroApi } from './erros';
import type { Sessao } from './sessao';

const SERVIDOR = 'https://bots.exemplo.com';
const TOKEN_A = 'a'.repeat(43);
const TOKEN_B = 'b'.repeat(43);
const BOT_ID = 'bot0000000000001';

const sessaoA: Sessao = {
  servidor: SERVIDOR,
  token: TOKEN_A,
  dispositivo: { id: 'abcdefgh12345678', nome: 'Meu celular', criadoEm: 1 },
};
const sessaoB: Sessao = { ...sessaoA, token: TOKEN_B };

const bot: Bot = {
  id: BOT_ID,
  nome: 'Ajudante',
  instrucoes: '',
  modelo: null,
  criadoEm: 1,
  atualizadoEm: 2,
  turnoAtivo: false,
};

function mensagem(seq: number, papel: Mensagem['papel'], estado: Mensagem['estado'] = 'completa'): Mensagem {
  return { id: `msg${String(seq).padStart(13, '0')}`, botId: BOT_ID, seq, papel, texto: `texto ${seq}`, estado, criadaEm: seq };
}

interface Chamado {
  url: string;
  pedido: PedidoHttp;
}

/** `fetch` falso: responde com o que o teste mandar e guarda cada chamada. */
function buscarFalso(responder: (chamado: Chamado) => { status: number; corpo?: unknown; texto?: string }) {
  const chamados: Chamado[] = [];
  const buscar: Buscar = async (url, pedido) => {
    const chamado = { url, pedido };
    chamados.push(chamado);
    const { status, corpo, texto } = responder(chamado);
    return { status, text: async () => texto ?? (corpo === undefined ? '' : JSON.stringify(corpo)) };
  };
  return { buscar, chamados };
}

function montar(
  responder: Parameters<typeof buscarFalso>[0],
  sessao: () => Sessao | null = () => sessaoA,
) {
  const falso = buscarFalso(responder);
  const aoNaoAutenticado = vi.fn();
  const api = criarApi({ buscar: falso.buscar, sessaoAtual: sessao, aoNaoAutenticado });
  return { api, chamados: falso.chamados, aoNaoAutenticado };
}

async function erroDe(promessa: Promise<unknown>): Promise<ErroApi> {
  try {
    await promessa;
  } catch (erro) {
    if (erro instanceof ErroApi) return erro;
    throw erro;
  }
  throw new Error('a chamada deveria ter falhado');
}

describe('parear', () => {
  const resposta = {
    token: TOKEN_A,
    dispositivo: sessaoA.dispositivo,
    servidor: { versao: '0.1.0', protocolo: 1 },
  };

  it('manda o pedido sem Authorization e valida a resposta', async () => {
    const { api, chamados } = montar(() => ({ status: 200, corpo: resposta }), () => null);
    await expect(api.parear(SERVIDOR, { codigo: 'ABCDEFGH2345', nome: 'Meu celular' })).resolves.toEqual(resposta);

    expect(chamados).toHaveLength(1);
    expect(chamados[0]?.url).toBe(`${SERVIDOR}/v1/parear`);
    expect(chamados[0]?.pedido.method).toBe('POST');
    expect(chamados[0]?.pedido.headers).toEqual({ accept: 'application/json', 'content-type': 'application/json' });
    expect(JSON.parse(chamados[0]?.pedido.body ?? '')).toEqual({ codigo: 'ABCDEFGH2345', nome: 'Meu celular' });
    expect(chamados[0]?.pedido.credentials).toBe('omit');
    expect(chamados[0]?.pedido.redirect).toBe('error');
  });

  it.each([
    [401, 'codigo_invalido'],
    [429, 'muitas_tentativas'],
    [400, 'dados_invalidos'],
  ])('devolve o código do erro %i', async (status, codigo) => {
    const { api, aoNaoAutenticado } = montar(() => ({ status, corpo: { erro: codigo } }));
    const erro = await erroDe(api.parear(SERVIDOR, { codigo: 'ABCDEFGH2345', nome: 'x' }));
    expect(erro.codigo).toBe(codigo);
    expect(erro.status).toBe(status);
    expect(aoNaoAutenticado).not.toHaveBeenCalled();
  });

  it('recusa resposta 200 fora do contrato', async () => {
    const { api } = montar(() => ({ status: 200, corpo: { ...resposta, token: 'curto' } }));
    expect((await erroDe(api.parear(SERVIDOR, { codigo: 'ABCDEFGH2345', nome: 'x' }))).codigo).toBe('resposta_invalida');
  });

  it('401 que não veio do servidor awikabot tem código próprio, diferente de código inválido', async () => {
    const { api } = montar(() => ({ status: 401, texto: '<html>Login do túnel</html>' }));
    const erro = await erroDe(api.parear(SERVIDOR, { codigo: 'ABCDEFGH2345', nome: 'x' }));
    expect([erro.codigo, erro.status]).toEqual(['recusa_no_caminho', 401]);
  });
});

describe('pedidos autenticados', () => {
  it('listarBots manda o token e valida a lista', async () => {
    const { api, chamados } = montar(() => ({ status: 200, corpo: { bots: [bot] } }));
    await expect(api.listarBots()).resolves.toEqual({ bots: [bot] });
    expect(chamados[0]?.url).toBe(`${SERVIDOR}/v1/bots`);
    expect(chamados[0]?.pedido.method).toBe('GET');
    expect(chamados[0]?.pedido.headers).toEqual({ accept: 'application/json', authorization: `Bearer ${TOKEN_A}` });
    expect(chamados[0]?.pedido.body).toBeUndefined();
  });

  it('criarBot faz POST com a entrada e aceita 201', async () => {
    const { api, chamados } = montar(() => ({ status: 201, corpo: bot }));
    await expect(api.criarBot({ nome: 'Ajudante', instrucoes: '', modelo: null })).resolves.toEqual(bot);
    expect(chamados[0]?.url).toBe(`${SERVIDOR}/v1/bots`);
    expect(chamados[0]?.pedido.method).toBe('POST');
    expect(JSON.parse(chamados[0]?.pedido.body ?? '')).toEqual({ nome: 'Ajudante', instrucoes: '', modelo: null });
  });

  it('editarBot faz PATCH no bot', async () => {
    const { api, chamados } = montar(() => ({ status: 200, corpo: { ...bot, nome: 'Novo' } }));
    await expect(api.editarBot(BOT_ID, { nome: 'Novo' })).resolves.toMatchObject({ nome: 'Novo' });
    expect(chamados[0]?.url).toBe(`${SERVIDOR}/v1/bots/${BOT_ID}`);
    expect(chamados[0]?.pedido.method).toBe('PATCH');
    expect(JSON.parse(chamados[0]?.pedido.body ?? '')).toEqual({ nome: 'Novo' });
  });

  it('listarMensagens pede a página mais recente sem query', async () => {
    const pagina = { mensagens: [mensagem(1, 'usuario'), mensagem(2, 'bot')], temMais: false };
    const { api, chamados } = montar(() => ({ status: 200, corpo: pagina }));
    await expect(api.listarMensagens(BOT_ID)).resolves.toEqual(pagina);
    expect(chamados[0]?.url).toBe(`${SERVIDOR}/v1/bots/${BOT_ID}/mensagens`);
  });

  it('listarMensagens manda antes e limite', async () => {
    const { api, chamados } = montar(() => ({ status: 200, corpo: { mensagens: [], temMais: false } }));
    await api.listarMensagens(BOT_ID, { antes: 51, limite: 50 });
    expect(chamados[0]?.url).toBe(`${SERVIDOR}/v1/bots/${BOT_ID}/mensagens?antes=51&limite=50`);
  });

  it('enviarTurno faz POST com o texto e valida as duas mensagens', async () => {
    const resposta = { usuario: mensagem(1, 'usuario'), bot: mensagem(2, 'bot', 'em_andamento') };
    const { api, chamados } = montar(() => ({ status: 201, corpo: resposta }));
    await expect(api.enviarTurno(BOT_ID, { texto: 'oi' })).resolves.toEqual(resposta);
    expect(chamados[0]?.url).toBe(`${SERVIDOR}/v1/bots/${BOT_ID}/turnos`);
    expect(JSON.parse(chamados[0]?.pedido.body ?? '')).toEqual({ texto: 'oi' });
  });

  it('pararTurno aceita 204 sem corpo e não manda corpo', async () => {
    const { api, chamados } = montar(() => ({ status: 204 }));
    await expect(api.pararTurno(BOT_ID)).resolves.toBeUndefined();
    expect(chamados[0]?.url).toBe(`${SERVIDOR}/v1/bots/${BOT_ID}/turnos/atual/parar`);
    expect(chamados[0]?.pedido.method).toBe('POST');
    expect(chamados[0]?.pedido.body).toBeUndefined();
    expect(chamados[0]?.pedido.headers['content-type']).toBeUndefined();
  });

  it('escapa o id no caminho', async () => {
    const { api, chamados } = montar(() => ({ status: 204 }));
    await api.pararTurno('a/b?c');
    expect(chamados[0]?.url).toBe(`${SERVIDOR}/v1/bots/a%2Fb%3Fc/turnos/atual/parar`);
  });

  it.each([
    [409, 'turno_em_andamento'],
    [429, 'limite_de_turnos'],
    [404, 'nao_encontrado'],
  ])('enviarTurno devolve o código do erro %i', async (status, codigo) => {
    const { api } = montar(() => ({ status, corpo: { erro: codigo } }));
    const erro = await erroDe(api.enviarTurno(BOT_ID, { texto: 'oi' }));
    expect([erro.codigo, erro.status]).toEqual([codigo, status]);
  });

  it('pararTurno devolve sem_turno_ativo', async () => {
    const { api } = montar(() => ({ status: 409, corpo: { erro: 'sem_turno_ativo' } }));
    expect((await erroDe(api.pararTurno(BOT_ID))).codigo).toBe('sem_turno_ativo');
  });

  it('recusa resposta de sucesso fora do contrato', async () => {
    const { api } = montar(() => ({ status: 200, corpo: { bots: [{ ...bot, id: 'curto' }] } }));
    const erro = await erroDe(api.listarBots());
    expect([erro.codigo, erro.status]).toEqual(['resposta_invalida', 200]);
  });

  it('recusa resposta de sucesso que não é JSON', async () => {
    const { api } = montar(() => ({ status: 200, texto: '<html>proxy</html>' }));
    expect((await erroDe(api.listarBots())).codigo).toBe('resposta_invalida');
  });

  it('erro sem corpo no formato do contrato vira erro_http com o status', async () => {
    const { api } = montar(() => ({ status: 502, texto: 'Bad Gateway' }));
    const erro = await erroDe(api.listarBots());
    expect([erro.codigo, erro.status]).toEqual(['erro_http', 502]);
  });

  it('sem sessão, falha sem chamar a rede', async () => {
    const { api, chamados, aoNaoAutenticado } = montar(() => ({ status: 200, corpo: { bots: [] } }), () => null);
    const erro = await erroDe(api.listarBots());
    expect([erro.codigo, erro.status]).toEqual(['nao_autenticado', null]);
    expect(chamados).toHaveLength(0);
    expect(aoNaoAutenticado).not.toHaveBeenCalled();
  });
});

describe('regra do 401', () => {
  it('avisa com a sessão do pedido e devolve nao_autenticado', async () => {
    const { api, aoNaoAutenticado } = montar(() => ({ status: 401, corpo: { erro: 'nao_autenticado' } }));
    const erro = await erroDe(api.listarBots());
    expect([erro.codigo, erro.status]).toEqual(['nao_autenticado', 401]);
    expect(aoNaoAutenticado).toHaveBeenCalledTimes(1);
    expect(aoNaoAutenticado).toHaveBeenCalledWith(sessaoA);
  });

  it('usa a sessão capturada no começo, mesmo que ela troque durante o pedido', async () => {
    let atual: Sessao | null = sessaoA;
    const aoNaoAutenticado = vi.fn();
    const buscar: Buscar = async () => {
      atual = sessaoB;
      return { status: 401, text: async () => JSON.stringify({ erro: 'nao_autenticado' }) };
    };
    const api = criarApi({ buscar, sessaoAtual: () => atual, aoNaoAutenticado });

    await erroDe(api.listarBots());

    expect(aoNaoAutenticado).toHaveBeenCalledWith(sessaoA);
    expect(aoNaoAutenticado).not.toHaveBeenCalledWith(sessaoB);
  });

  it('o pedido seguinte já sai com a sessão nova', async () => {
    let atual = sessaoA;
    const { buscar, chamados } = buscarFalso(() => ({ status: 200, corpo: { bots: [] } }));
    const api = criarApi({ buscar, sessaoAtual: () => atual, aoNaoAutenticado: vi.fn() });
    await api.listarBots();
    atual = sessaoB;
    await api.listarBots();
    expect(chamados.map((chamado) => chamado.pedido.headers.authorization)).toEqual([
      `Bearer ${TOKEN_A}`,
      `Bearer ${TOKEN_B}`,
    ]);
  });

  it('a falha de quem apaga a sessão não esconde o 401', async () => {
    const buscar: Buscar = async () => ({ status: 401, text: async () => JSON.stringify({ erro: 'nao_autenticado' }) });
    const api = criarApi({
      buscar,
      sessaoAtual: () => sessaoA,
      aoNaoAutenticado: async () => {
        throw new Error('cofre quebrou');
      },
    });
    expect((await erroDe(api.listarBots())).codigo).toBe('nao_autenticado');
  });

  it.each([403, 404, 409, 429, 500])('status %i não desconecta', async (status) => {
    const { api, aoNaoAutenticado } = montar(() => ({ status, corpo: { erro: 'qualquer' } }));
    await erroDe(api.listarBots());
    expect(aoNaoAutenticado).not.toHaveBeenCalled();
  });

  it('status que não é 401 não desconecta nem com nao_autenticado no corpo', async () => {
    const { api, aoNaoAutenticado } = montar(() => ({ status: 403, corpo: { erro: 'nao_autenticado' } }));
    await erroDe(api.listarBots());
    expect(aoNaoAutenticado).not.toHaveBeenCalled();
  });

  it.each([
    ['HTML de um proxy', '<html><body>Entre para continuar</body></html>'],
    ['corpo vazio', ''],
    ['JSON fora do contrato', JSON.stringify({ error: 'nao_autenticado' })],
    ['texto solto', 'nao_autenticado'],
  ])('401 com %s não desconecta e falha com código próprio', async (_caso, texto) => {
    const { api, aoNaoAutenticado } = montar(() => ({ status: 401, texto }));
    const erro = await erroDe(api.listarBots());
    expect([erro.codigo, erro.status]).toEqual(['recusa_no_caminho', 401]);
    expect(aoNaoAutenticado).not.toHaveBeenCalled();
  });

  it('401 com outro código do contrato não desconecta e devolve esse código', async () => {
    const { api, aoNaoAutenticado } = montar(() => ({ status: 401, corpo: { erro: 'codigo_invalido' } }));
    const erro = await erroDe(api.listarBots());
    expect([erro.codigo, erro.status]).toEqual(['codigo_invalido', 401]);
    expect(aoNaoAutenticado).not.toHaveBeenCalled();
  });
});

describe('revogarDispositivo', () => {
  it('faz DELETE em /v1/dispositivo com o token dado, sem depender da sessão', async () => {
    const { api, chamados, aoNaoAutenticado } = montar(() => ({ status: 204 }), () => null);
    await expect(api.revogarDispositivo({ servidor: 'https://outro.exemplo.com', token: TOKEN_B })).resolves.toBeUndefined();

    expect(chamados).toHaveLength(1);
    expect(chamados[0]?.url).toBe('https://outro.exemplo.com/v1/dispositivo');
    expect(chamados[0]?.pedido.method).toBe('DELETE');
    expect(chamados[0]?.pedido.headers).toEqual({ accept: 'application/json', authorization: `Bearer ${TOKEN_B}` });
    expect(chamados[0]?.pedido.body).toBeUndefined();
    expect(aoNaoAutenticado).not.toHaveBeenCalled();
  });

  it('token já recusado devolve o erro, sem mexer na sessão atual', async () => {
    const { api, aoNaoAutenticado } = montar(() => ({ status: 401, corpo: { erro: 'nao_autenticado' } }));
    const erro = await erroDe(api.revogarDispositivo(sessaoA));
    expect([erro.codigo, erro.status]).toEqual(['nao_autenticado', 401]);
    expect(aoNaoAutenticado).not.toHaveBeenCalled();
  });

  it('desiste em 5 s, bem antes do tempo limite dos outros pedidos', async () => {
    vi.useFakeTimers();
    try {
      let sinal: AbortSignal | undefined;
      const buscar: Buscar = (_url, pedido) =>
        new Promise((_resolver, rejeitar) => {
          sinal = pedido.signal;
          pedido.signal?.addEventListener('abort', () => rejeitar(new Error('abortado')));
        });
      const api = criarApi({ buscar, sessaoAtual: () => sessaoA, aoNaoAutenticado: vi.fn() });

      const pendente = erroDe(api.revogarDispositivo(sessaoA));
      await vi.advanceTimersByTimeAsync(TEMPO_LIMITE_REVOGACAO_MS - 1);
      expect(sinal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect((await pendente).codigo).toBe('tempo_esgotado');
      expect(TEMPO_LIMITE_REVOGACAO_MS).toBe(5000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('falha de rede e demora', () => {
  it('erro de rede vira ErroApi "rede" e não desconecta', async () => {
    const aoNaoAutenticado = vi.fn();
    const buscar: Buscar = async () => {
      throw new TypeError('Network request failed');
    };
    const api = criarApi({ buscar, sessaoAtual: () => sessaoA, aoNaoAutenticado });
    const erro = await erroDe(api.listarBots());
    expect([erro.codigo, erro.status]).toEqual(['rede', null]);
    expect(aoNaoAutenticado).not.toHaveBeenCalled();
  });

  it('falha ao ler o corpo também vira "rede"', async () => {
    const buscar: Buscar = async () => ({
      status: 200,
      text: async () => {
        throw new Error('conexão caiu');
      },
    });
    const api = criarApi({ buscar, sessaoAtual: () => sessaoA, aoNaoAutenticado: vi.fn() });
    expect((await erroDe(api.listarBots())).codigo).toBe('rede');
  });

  it('aborta e devolve tempo_esgotado quando o servidor não responde', async () => {
    vi.useFakeTimers();
    try {
      const aoNaoAutenticado = vi.fn();
      let sinal: AbortSignal | undefined;
      const buscar: Buscar = (_url, pedido) =>
        new Promise((_resolver, rejeitar) => {
          sinal = pedido.signal;
          pedido.signal?.addEventListener('abort', () => rejeitar(new Error('abortado')));
        });
      const api = criarApi({ buscar, sessaoAtual: () => sessaoA, aoNaoAutenticado, tempoLimiteMs: 5000 });

      const pendente = erroDe(api.listarBots());
      await vi.advanceTimersByTimeAsync(4999);
      expect(sinal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      const erro = await pendente;
      expect([erro.codigo, erro.status]).toEqual(['tempo_esgotado', null]);
      expect(sinal?.aborted).toBe(true);
      expect(aoNaoAutenticado).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('não deixa relógio pendente depois de responder', async () => {
    vi.useFakeTimers();
    try {
      const { api } = montar(() => ({ status: 200, corpo: { bots: [] } }));
      await api.listarBots();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('aprovações', () => {
  const pendente: Aprovacao = {
    id: 'apr0000000000001',
    botId: BOT_ID,
    mensagemId: 'msg0000000000002',
    ferramenta: 'Bash',
    resumo: 'rm -rf build',
    estado: 'pendente',
    criadaEm: 10,
    resolvidaEm: null,
  };
  const aprovada: Aprovacao = { ...pendente, estado: 'aprovada', resolvidaEm: 20 };

  it('listarAprovacoes faz GET em /v1/aprovacoes com o token e valida a lista', async () => {
    const { api, chamados } = montar(() => ({ status: 200, corpo: { aprovacoes: [pendente] } }));
    await expect(api.listarAprovacoes()).resolves.toEqual({ aprovacoes: [pendente] });
    expect(chamados[0]?.url).toBe(`${SERVIDOR}/v1/aprovacoes`);
    expect(chamados[0]?.pedido.method).toBe('GET');
    expect(chamados[0]?.pedido.headers.authorization).toBe(`Bearer ${TOKEN_A}`);
    expect(chamados[0]?.pedido.body).toBeUndefined();
  });

  it('listarAprovacoes recusa lista fora do contrato', async () => {
    const { api } = montar(() => ({ status: 200, corpo: { aprovacoes: [{ ...pendente, estado: 'talvez' }] } }));
    expect((await erroDe(api.listarAprovacoes())).codigo).toBe('resposta_invalida');
  });

  it.each(['aprovar', 'negar'] as const)('decidirAprovacao manda "%s" em POST e devolve a aprovação resolvida', async (decisao) => {
    const { api, chamados } = montar(() => ({ status: 200, corpo: aprovada }));
    await expect(api.decidirAprovacao(pendente.id, { decisao })).resolves.toEqual(aprovada);
    expect(chamados[0]?.url).toBe(`${SERVIDOR}/v1/aprovacoes/${pendente.id}`);
    expect(chamados[0]?.pedido.method).toBe('POST');
    expect(JSON.parse(chamados[0]?.pedido.body ?? '')).toEqual({ decisao });
  });

  it('decidirAprovacao escapa o id no caminho', async () => {
    const { api, chamados } = montar(() => ({ status: 200, corpo: aprovada }));
    await api.decidirAprovacao('a/b?c', { decisao: 'negar' });
    expect(chamados[0]?.url).toBe(`${SERVIDOR}/v1/aprovacoes/a%2Fb%3Fc`);
  });

  it.each([
    [409, 'ja_resolvida'],
    [404, 'nao_encontrado'],
    [400, 'dados_invalidos'],
  ])('decidirAprovacao devolve o código do erro %i', async (status, codigo) => {
    const { api, aoNaoAutenticado } = montar(() => ({ status, corpo: { erro: codigo } }));
    const erro = await erroDe(api.decidirAprovacao(pendente.id, { decisao: 'aprovar' }));
    expect([erro.codigo, erro.status]).toEqual([codigo, status]);
    expect(aoNaoAutenticado).not.toHaveBeenCalled();
  });

  it('decidirAprovacao recusa resposta de sucesso fora do contrato', async () => {
    const { api } = montar(() => ({ status: 200, corpo: { ok: true } }));
    expect((await erroDe(api.decidirAprovacao(pendente.id, { decisao: 'aprovar' }))).codigo).toBe('resposta_invalida');
  });
});
