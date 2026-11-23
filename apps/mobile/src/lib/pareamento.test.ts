import { describe, expect, it, vi } from 'vitest';
import { LIMITES, VERSAO_PROTOCOLO, type RespostaPareamento } from '@awikabot/core';
import type { Api } from './api';
import { ErroApi, mensagemDoCodigo } from './erros';
import {
  FALHA_AO_GUARDAR,
  NOME_PADRAO_DO_APARELHO,
  desparearAparelho,
  mensagemDeProtocolo,
  parearAparelho,
  validarPareamento,
} from './pareamento';
import { criarGuardaSessao, lerSessaoGuardada, type Cofre } from './sessao';

const validos = { endereco: 'https://bots.exemplo.com', codigo: 'ABCDEFGH2345', nome: NOME_PADRAO_DO_APARELHO };

function erros(campos: Partial<typeof validos>): string[] {
  const lido = validarPareamento({ ...validos, ...campos });
  return lido.ok ? [] : Object.keys(lido.erros);
}

describe('validarPareamento', () => {
  it('devolve o endereço normalizado e o pedido do contrato', () => {
    expect(validarPareamento({ endereco: ' bots.exemplo.com/ ', codigo: 'abcd-efgh 2345', nome: '  Celular da Ana ' })).toEqual({
      ok: true,
      servidor: 'https://bots.exemplo.com',
      pedido: { codigo: 'ABCDEFGH2345', nome: 'Celular da Ana' },
    });
  });

  it('o nome padrão do aparelho é válido', () => {
    expect(NOME_PADRAO_DO_APARELHO).toBe('Meu celular');
    expect(erros({})).toEqual([]);
  });

  it('aponta o endereço inválido com a frase do motivo', () => {
    const lido = validarPareamento({ ...validos, endereco: 'http://bots.exemplo.com' });
    expect(lido).toEqual({
      ok: false,
      erros: { endereco: 'Use https:// neste endereço. http:// só vale para localhost e endereços da rede local.' },
    });
  });

  it.each(['', 'ABC', 'ABCDEFGH2341', 'ABCDEFGH23456', 'ABCDEFGH234!', 'A'.repeat(41)])('recusa o código "%s"', (codigo) => {
    const lido = validarPareamento({ ...validos, codigo });
    expect(lido).toEqual({
      ok: false,
      erros: { codigo: 'O código de pareamento tem 12 caracteres: letras de A a Z e números de 2 a 7.' },
    });
  });

  it('exige nome do aparelho dentro do limite', () => {
    expect(erros({ nome: '   ' })).toEqual(['nome']);
    expect(erros({ nome: 'n'.repeat(LIMITES.nomeDispositivo) })).toEqual([]);
    expect(erros({ nome: 'n'.repeat(LIMITES.nomeDispositivo + 1) })).toEqual(['nome']);
  });

  it('aponta todos os campos com problema de uma vez', () => {
    expect(erros({ endereco: '', codigo: '', nome: '' }).sort()).toEqual(['codigo', 'endereco', 'nome']);
  });
});

describe('parearAparelho', () => {
  const TOKEN = 'p'.repeat(43);
  const dispositivo = { id: 'abcdefgh12345678', nome: NOME_PADRAO_DO_APARELHO, criadoEm: 1 };
  const resposta = (protocolo: number = VERSAO_PROTOCOLO): RespostaPareamento => ({
    token: TOKEN,
    dispositivo,
    servidor: { status: 'ok', versao: '0.2.0', protocolo },
  });

  function montar(parear: Api['parear'], cofre: Cofre = cofreEmMemoria()) {
    const revogarDispositivo = vi.fn<Api['revogarDispositivo']>(async () => {});
    const guarda = criarGuardaSessao(cofre);
    return { api: { parear: vi.fn(parear), revogarDispositivo }, guarda, cofre };
  }

  function cofreEmMemoria(): Cofre & { valor(): string | null } {
    let valor: string | null = null;
    return {
      valor: () => valor,
      ler: async () => valor,
      gravar: async (novo) => {
        valor = novo;
      },
      apagar: async () => {
        valor = null;
      },
    };
  }

  it('guarda endereço, token e dispositivo quando o servidor aceita o código', async () => {
    const cofre = cofreEmMemoria();
    const { api, guarda } = montar(async () => resposta(), cofre);

    await expect(parearAparelho(api, guarda, validos)).resolves.toEqual({ ok: true });

    expect(api.parear).toHaveBeenCalledWith('https://bots.exemplo.com', { codigo: 'ABCDEFGH2345', nome: 'Meu celular' });
    expect(guarda.estado().sessao).toEqual({ servidor: 'https://bots.exemplo.com', token: TOKEN, dispositivo });
    expect(lerSessaoGuardada(cofre.valor())).toEqual(guarda.estado().sessao);
    expect(api.revogarDispositivo).not.toHaveBeenCalled();
  });

  it('com campo inválido, aponta o campo e não fala com o servidor', async () => {
    const { api, guarda } = montar(async () => resposta());
    const resultado = await parearAparelho(api, guarda, { ...validos, codigo: 'curto' });
    expect(resultado).toMatchObject({ ok: false, falha: null });
    expect(resultado.ok === false && Object.keys(resultado.erros)).toEqual(['codigo']);
    expect(api.parear).not.toHaveBeenCalled();
  });

  it.each([
    ['codigo_invalido', 401],
    ['muitas_tentativas', 429],
    ['rede', null],
  ] as const)('traduz o erro %s do servidor e não guarda nada', async (codigo, status) => {
    const { api, guarda } = montar(() => Promise.reject(new ErroApi(codigo, status)));
    const resultado = await parearAparelho(api, guarda, validos);
    expect(resultado).toEqual({ ok: false, erros: {}, falha: mensagemDoCodigo(codigo, status) });
    expect(guarda.estado().sessao).toBeNull();
    expect(api.revogarDispositivo).not.toHaveBeenCalled();
  });

  it('com protocolo diferente, não guarda a sessão, explica e revoga o token recém-emitido', async () => {
    const cofre = cofreEmMemoria();
    const { api, guarda } = montar(async () => resposta(VERSAO_PROTOCOLO + 1), cofre);

    const resultado = await parearAparelho(api, guarda, validos);

    expect(resultado).toEqual({ ok: false, erros: {}, falha: mensagemDeProtocolo(VERSAO_PROTOCOLO + 1) });
    expect(guarda.estado().sessao).toBeNull();
    expect(cofre.valor()).toBeNull();
    expect(api.revogarDispositivo).toHaveBeenCalledTimes(1);
    expect(api.revogarDispositivo).toHaveBeenCalledWith({ servidor: 'https://bots.exemplo.com', token: TOKEN });
  });

  it('a frase do protocolo diz as duas versões', () => {
    expect(mensagemDeProtocolo(7)).toBe(
      `Este app e o servidor falam versões diferentes do protocolo (app: ${VERSAO_PROTOCOLO}, servidor: 7). ` +
        'Atualize o app ou o servidor e pareie de novo com um código novo.',
    );
  });

  it('com protocolo diferente, a falha ao revogar não muda o resultado', async () => {
    const { api, guarda } = montar(async () => resposta(VERSAO_PROTOCOLO + 1));
    api.revogarDispositivo.mockRejectedValue(new ErroApi('rede', null));
    const resultado = await parearAparelho(api, guarda, validos);
    expect(resultado).toMatchObject({ ok: false, falha: mensagemDeProtocolo(VERSAO_PROTOCOLO + 1) });
    expect(guarda.estado().sessao).toBeNull();
  });

  it('se o aparelho não consegue guardar o acesso, avisa e revoga o token que ficaria sem dono', async () => {
    const cofre = cofreEmMemoria();
    cofre.gravar = async () => {
      throw new Error('cofre cheio');
    };
    const { api, guarda } = montar(async () => resposta(), cofre);

    const resultado = await parearAparelho(api, guarda, validos);

    expect(resultado).toEqual({ ok: false, erros: {}, falha: FALHA_AO_GUARDAR });
    expect(guarda.estado().sessao).toBeNull();
    expect(api.revogarDispositivo).toHaveBeenCalledWith({ servidor: 'https://bots.exemplo.com', token: TOKEN });
  });

  describe('desparearAparelho', () => {
    async function pareado() {
      const cofre = cofreEmMemoria();
      const montado = montar(async () => resposta(), cofre);
      await parearAparelho(montado.api, montado.guarda, validos);
      return { ...montado, cofre };
    }

    it('revoga o token da sessão atual no servidor e depois esquece a sessão', async () => {
      const { api, guarda, cofre } = await pareado();
      const sessao = guarda.estado().sessao;
      const ordem: string[] = [];
      api.revogarDispositivo.mockImplementation(async () => {
        // Na hora do pedido a sessão ainda existe: é com ela que o servidor é avisado.
        ordem.push(guarda.estado().sessao === null ? 'revogar sem sessão' : 'revogar com sessão');
      });

      await desparearAparelho(api, guarda);

      expect(ordem).toEqual(['revogar com sessão']);
      expect(api.revogarDispositivo).toHaveBeenCalledWith(sessao);
      expect(guarda.estado()).toEqual({ fase: 'pronta', sessao: null, desconectado: false });
      expect(cofre.valor()).toBeNull();
    });

    it.each([
      ['a rede falha', new ErroApi('rede', null)],
      ['o servidor demora', new ErroApi('tempo_esgotado', null)],
      ['o token já não vale', new ErroApi('nao_autenticado', 401)],
    ])('esquece a sessão mesmo quando %s', async (_caso, erro) => {
      const { api, guarda, cofre } = await pareado();
      api.revogarDispositivo.mockRejectedValue(erro);

      await expect(desparearAparelho(api, guarda)).resolves.toBeUndefined();

      expect(guarda.estado().sessao).toBeNull();
      expect(cofre.valor()).toBeNull();
    });

    it('sem sessão, não chama o servidor', async () => {
      const { api, guarda } = montar(async () => resposta());
      await guarda.carregar();
      await desparearAparelho(api, guarda);
      expect(api.revogarDispositivo).not.toHaveBeenCalled();
      expect(guarda.estado().sessao).toBeNull();
    });
  });
});
