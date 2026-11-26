import { describe, expect, it } from 'vitest';
import {
  EsquemaAprovacao,
  EsquemaDecisaoAprovacao,
  EsquemaBotEdicao,
  EsquemaBot,
  EsquemaBotEntrada,
  EsquemaCatalogo,
  EsquemaEvento,
  EsquemaPedidoPareamento,
  EsquemaPedidoTurno,
  EsquemaInfoDoServidor,
  EsquemaSaude,
  LIMITES,
  MOTOR_PADRAO,
  VERSAO_PROTOCOLO,
  normalizarCodigoPareamento,
} from './index';

describe('EsquemaSaude', () => {
  it('aceita só o estado', () => {
    expect(EsquemaSaude.parse({ status: 'ok' })).toEqual({ status: 'ok' });
  });

  it.each([
    ['status diferente de ok', { status: 'degradado' }],
    ['sem status', {}],
    // A rota não pede token: nada que identifique o servidor cabe na resposta.
    ['resposta com a versão do servidor', { status: 'ok', versao: '0.0.0' }],
    ['resposta com o protocolo', { status: 'ok', protocolo: 1 }],
  ])('recusa %s', (_caso, entrada) => {
    expect(EsquemaSaude.safeParse(entrada).success).toBe(false);
  });
});

describe('EsquemaInfoDoServidor', () => {
  it('aceita a versão e o protocolo atual', () => {
    const info = { versao: '0.0.0', protocolo: VERSAO_PROTOCOLO };
    expect(EsquemaInfoDoServidor.parse(info)).toEqual(info);
  });

  it.each([
    ['versão vazia', { versao: '', protocolo: 1 }],
    ['protocolo zero', { versao: '0.0.0', protocolo: 0 }],
    ['protocolo fracionário', { versao: '0.0.0', protocolo: 1.5 }],
    ['campo faltando', { versao: '0.0.0' }],
  ])('recusa %s', (_caso, entrada) => {
    expect(EsquemaInfoDoServidor.safeParse(entrada).success).toBe(false);
  });
});

describe('pareamento', () => {
  it.each([
    ['ABCD-EFGH-2345', 'ABCDEFGH2345'],
    ['abcd efgh 2345', 'ABCDEFGH2345'],
    [' abcdefgh2345 ', 'ABCDEFGH2345'],
  ])('normaliza o código "%s"', (digitado, esperado) => {
    expect(normalizarCodigoPareamento(digitado)).toBe(esperado);
    expect(EsquemaPedidoPareamento.parse({ codigo: digitado, nome: 'Celular' }).codigo).toBe(esperado);
  });

  it.each([['ABCD-EFGH-234'], ['ABCD-EFGH-23451'], ['ABCD-EFGH-2340'], ['ABCD-EFGH-234!'], ['']])(
    'recusa o código "%s"',
    (codigo) => {
      expect(EsquemaPedidoPareamento.safeParse({ codigo, nome: 'Celular' }).success).toBe(false);
    },
  );

  it('recusa nome vazio ou longo demais', () => {
    const codigo = 'ABCD-EFGH-2345';
    expect(EsquemaPedidoPareamento.safeParse({ codigo, nome: '   ' }).success).toBe(false);
    expect(EsquemaPedidoPareamento.safeParse({ codigo, nome: 'x'.repeat(LIMITES.nomeDispositivo + 1) }).success).toBe(false);
  });
});

describe('bots', () => {
  it('preenche instruções e modelo quando não vêm', () => {
    expect(EsquemaBotEntrada.parse({ nome: ' Scout ' })).toEqual({ nome: 'Scout', instrucoes: '', modelo: null, motor: 'claude-code', esforco: null });
  });

  it.each([['--dangerously-skip-permissions'], ['-p'], ['modelo com espaço'], ['a;b'], ['']])(
    'recusa o modelo "%s"',
    (modelo) => {
      expect(EsquemaBotEntrada.safeParse({ nome: 'Scout', modelo }).success).toBe(false);
    },
  );

  it.each([['sonnet'], ['claude-sonnet-5-5'], ['opus[1m]'], ['provedor:modelo.v2']])('aceita o modelo "%s"', (modelo) => {
    expect(EsquemaBotEntrada.parse({ nome: 'Scout', modelo }).modelo).toBe(modelo);
  });

  it('recusa edição vazia e aceita limpar o modelo', () => {
    expect(EsquemaBotEdicao.safeParse({}).success).toBe(false);
    expect(EsquemaBotEdicao.parse({ modelo: null })).toEqual({ modelo: null });
  });

  it('cria no motor padrão, com o esforço padrão, quando a entrada não diz', () => {
    expect(EsquemaBotEntrada.parse({ nome: 'Scout' })).toMatchObject({ motor: MOTOR_PADRAO, esforco: null });
    expect(EsquemaBotEntrada.parse({ nome: 'Scout', motor: 'outro-motor', esforco: 'high' })).toMatchObject({
      motor: 'outro-motor',
      esforco: 'high',
    });
  });

  it.each([['Claude-Code'], ['-x'], ['motor x'], ['--model=x'], [''], ['m'.repeat(41)]])('recusa o motor "%s"', (motor) => {
    expect(EsquemaBotEntrada.safeParse({ nome: 'Scout', motor }).success).toBe(false);
  });

  it.each([['High'], ['--x'], ['alto demais'], ['']])('recusa o esforço "%s"', (esforco) => {
    expect(EsquemaBotEntrada.safeParse({ nome: 'Scout', esforco }).success).toBe(false);
  });

  it('a edição muda o esforço e não carrega o motor', () => {
    expect(EsquemaBotEdicao.parse({ esforco: 'low' })).toEqual({ esforco: 'low' });
    expect(EsquemaBotEdicao.parse({ esforco: null })).toEqual({ esforco: null });
    // O motor é da criação: numa edição ele some, e uma edição só com ele é vazia.
    expect(EsquemaBotEdicao.parse({ nome: 'Novo', motor: 'outro' })).toEqual({ nome: 'Novo' });
    expect(EsquemaBotEdicao.safeParse({ motor: 'outro' }).success).toBe(false);
  });

  it('lê o bot de um servidor anterior ao motor como bot do motor padrão', () => {
    const antigo = {
      id: 'abcdefgh12345678',
      nome: 'Scout',
      instrucoes: '',
      modelo: null,
      criadoEm: 1,
      atualizadoEm: 1,
      turnoAtivo: false,
    };
    expect(EsquemaBot.parse(antigo)).toEqual({ ...antigo, motor: MOTOR_PADRAO, esforco: null });
  });

  it('recusa instruções acima do limite', () => {
    const instrucoes = 'x'.repeat(LIMITES.instrucoes + 1);
    expect(EsquemaBotEntrada.safeParse({ nome: 'Scout', instrucoes }).success).toBe(false);
  });
});

describe('catálogo', () => {
  const claude = {
    id: 'claude-code',
    nome: 'Claude Code',
    familia: 'agente',
    modelos: [{ id: 'opus', nome: 'Opus' }],
    esforcos: [{ id: 'high', nome: 'Alto' }],
    papeis: ['worker'],
    pronto: true,
  };

  it('aceita um motor com modelos, esforços e papéis', () => {
    expect(EsquemaCatalogo.parse({ motores: [claude] })).toEqual({ motores: [claude] });
    expect(EsquemaCatalogo.parse({ motores: [] })).toEqual({ motores: [] });
  });

  it.each([
    ['família desconhecida', { ...claude, familia: 'outra' }],
    ['papel desconhecido', { ...claude, papeis: ['chefe'] }],
    ['modelo sugerido com cara de opção', { ...claude, modelos: [{ id: '--x', nome: 'X' }] }],
    ['modelo sugerido sem nome', { ...claude, modelos: [{ id: 'opus', nome: '' }] }],
    ['esforço fora do formato', { ...claude, esforcos: [{ id: 'Alto', nome: 'Alto' }] }],
    ['sem o campo pronto', { ...claude, pronto: undefined }],
  ])('recusa %s', (_caso, motor) => {
    expect(EsquemaCatalogo.safeParse({ motores: [motor] }).success).toBe(false);
  });
});

describe('conversa e eventos', () => {
  it('apara o texto do turno e recusa texto vazio ou longo demais', () => {
    expect(EsquemaPedidoTurno.parse({ texto: '  oi  ' })).toEqual({ texto: 'oi' });
    expect(EsquemaPedidoTurno.safeParse({ texto: '   ' }).success).toBe(false);
    expect(EsquemaPedidoTurno.safeParse({ texto: 'x'.repeat(LIMITES.texto + 1) }).success).toBe(false);
  });

  it('distingue os eventos pelo tipo', () => {
    const id = 'abcdefgh12345678';
    expect(EsquemaEvento.parse({ tipo: 'texto', botId: id, mensagemId: id, posicao: 0, trecho: 'oi' }).tipo).toBe('texto');
    expect(EsquemaEvento.safeParse({ tipo: 'texto', botId: id, mensagemId: id, trecho: 'oi' }).success).toBe(false);
    expect(EsquemaEvento.safeParse({ tipo: 'texto', botId: id, mensagemId: id, posicao: -1, trecho: 'oi' }).success).toBe(false);
    expect(EsquemaEvento.parse({ tipo: 'ressincronizar' }).tipo).toBe('ressincronizar');
    expect(EsquemaEvento.safeParse({ tipo: 'texto', botId: id }).success).toBe(false);
    expect(EsquemaEvento.safeParse({ tipo: 'desconhecido' }).success).toBe(false);
  });
});

describe('aprovações', () => {
  const id = 'abcdefgh12345678';
  const aprovacao = {
    id,
    botId: id,
    mensagemId: id,
    ferramenta: 'Bash',
    resumo: 'echo oi',
    estado: 'pendente',
    criadaEm: 1,
    resolvidaEm: null,
  };

  it('aceita um pedido pendente e os eventos que o carregam', () => {
    expect(EsquemaAprovacao.parse(aprovacao)).toEqual(aprovacao);
    expect(EsquemaEvento.parse({ tipo: 'aprovacao_pedida', aprovacao }).tipo).toBe('aprovacao_pedida');
    const resolvida = { ...aprovacao, estado: 'aprovada', resolvidaEm: 2 };
    expect(EsquemaEvento.parse({ tipo: 'aprovacao_resolvida', aprovacao: resolvida }).tipo).toBe('aprovacao_resolvida');
  });

  it('recusa estado desconhecido, ferramenta vazia e resumo acima do limite', () => {
    expect(EsquemaAprovacao.safeParse({ ...aprovacao, estado: 'talvez' }).success).toBe(false);
    expect(EsquemaAprovacao.safeParse({ ...aprovacao, ferramenta: '' }).success).toBe(false);
    const resumo = 'x'.repeat(LIMITES.resumoAprovacao + 1);
    expect(EsquemaAprovacao.safeParse({ ...aprovacao, resumo }).success).toBe(false);
  });

  it('só aceita aprovar ou negar como decisão', () => {
    expect(EsquemaDecisaoAprovacao.parse({ decisao: 'aprovar' })).toEqual({ decisao: 'aprovar' });
    expect(EsquemaDecisaoAprovacao.parse({ decisao: 'negar' })).toEqual({ decisao: 'negar' });
    expect(EsquemaDecisaoAprovacao.safeParse({ decisao: 'allow' }).success).toBe(false);
    expect(EsquemaDecisaoAprovacao.safeParse({}).success).toBe(false);
  });
});
