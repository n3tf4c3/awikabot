// A interface de decisor e a escada: toda resposta é conferida contra o esquema da pergunta, e a
// que vem fora dele, ilegível, atrasada ou de um decisor que falhou sobe um degrau. Nenhuma vira "sim".
import { describe, expect, it } from 'vitest';
import {
  EsquemaPergunta,
  esquemaDaResposta,
  lerResposta,
  subirEscada,
  type Decisor,
  type Pergunta,
  type PerguntaEntrada,
} from './decisao';

const ESCOLHA: PerguntaEntrada = {
  tipo: 'escolha',
  enunciado: 'Qual entrega fica?',
  opcoes: [
    { id: 'a', texto: 'a do primeiro worker' },
    { id: 'b', texto: 'a do segundo worker' },
  ],
};
const NOTA: PerguntaEntrada = { tipo: 'nota', enunciado: 'Quanto a entrega atende à tarefa?', minimo: 1, maximo: 5 };
const AFIRMACAO: PerguntaEntrada = { tipo: 'afirmacao', enunciado: 'A entrega atende à tarefa.', contexto: 'tarefa: some 2 e 2; entrega: 5' };

const ler = (entrada: PerguntaEntrada): Pergunta => EsquemaPergunta.parse(entrada);

/** Um decisor de teste: devolve o que lhe dão, depois de `atrasoMs`, e anota se foi chamado e abortado. */
function decisor(id: string, resposta: unknown, opcoes: { atrasoMs?: number; falha?: boolean; prazoMs?: number } = {}) {
  const registro = { chamadas: 0, abortado: false };
  const d: Decisor = {
    id,
    prazoMs: opcoes.prazoMs ?? 1000,
    decidir: (_pergunta, sinal) => {
      registro.chamadas += 1;
      sinal.addEventListener('abort', () => {
        registro.abortado = true;
      });
      return new Promise((ok, falha) => {
        setTimeout(() => (opcoes.falha ? falha(new Error('o motor caiu')) : ok(resposta)), opcoes.atrasoMs ?? 0);
      });
    },
  };
  return { d, registro };
}

describe('pergunta', () => {
  it('aceita os três tipos, com o contexto vazio por padrão', () => {
    expect(ler(ESCOLHA).contexto).toBe('');
    expect(ler(NOTA).tipo).toBe('nota');
    expect(ler(AFIRMACAO).contexto).toContain('some 2 e 2');
  });

  it.each([
    ['uma opção só', { ...ESCOLHA, opcoes: [{ id: 'a', texto: 'x' }] }],
    ['opções repetidas', { ...ESCOLHA, opcoes: [{ id: 'a', texto: 'x' }, { id: 'a', texto: 'y' }] }],
    ['opção com id que vira opção de linha de comando', { ...ESCOLHA, opcoes: [{ id: '--tools=Bash', texto: 'x' }, { id: 'b', texto: 'y' }] }],
    ['256 opções', { ...ESCOLHA, opcoes: Array.from({ length: 256 }, (_, i) => ({ id: `o${i}`, texto: 'x' })) }],
    ['escala invertida', { ...NOTA, minimo: 5, maximo: 1 }],
    ['escala grande demais', { ...NOTA, minimo: 0, maximo: 101 }],
    ['nota com escala fracionária', { ...NOTA, maximo: 5.5 }],
    ['enunciado vazio', { ...AFIRMACAO, enunciado: '  ' }],
  ])('recusa %s', (_nome, entrada) => {
    expect(EsquemaPergunta.safeParse(entrada).success).toBe(false);
  });

  it('dá ao motor um esquema que só admite o valor da pergunta e o motivo', () => {
    expect(esquemaDaResposta(ler(ESCOLHA))).toEqual({
      type: 'object',
      properties: { resposta: { type: 'string', enum: ['a', 'b'] }, motivo: { type: 'string' } },
      required: ['resposta', 'motivo'],
      additionalProperties: false,
    });
    expect((esquemaDaResposta(ler(NOTA)).properties as Record<string, unknown>).resposta).toEqual({ type: 'integer', minimum: 1, maximum: 5 });
    expect((esquemaDaResposta(ler(AFIRMACAO)).properties as Record<string, unknown>).resposta).toEqual({ type: 'boolean' });
  });
});

describe('conferência da resposta contra o esquema', () => {
  it('aceita a resposta inteira dentro do esquema, como objeto ou texto JSON', () => {
    expect(lerResposta(ler(ESCOLHA), { resposta: 'b', motivo: 'mais completa' })).toEqual({ ok: true, resposta: 'b', motivo: 'mais completa', confianca: null });
    expect(lerResposta(ler(NOTA), '{"resposta":4,"motivo":"quase"}')).toMatchObject({ ok: true, resposta: 4 });
    expect(lerResposta(ler(AFIRMACAO), { resposta: false, motivo: '2 + 2 = 4', confianca: 0.9 })).toMatchObject({ ok: true, resposta: false, confianca: 0.9 });
  });

  it.each([
    ['texto que não é JSON', 'a opção b'],
    ['JSON cortado', '{"resposta":"b","moti'],
    ['nada', undefined],
    ['nulo', null],
  ])('%s é ilegível', (_nome, bruto) => {
    expect(lerResposta(ler(ESCOLHA), bruto)).toEqual({ ok: false, razao: 'ilegivel' });
  });

  it.each<[string, PerguntaEntrada, unknown]>([
    ['opção que não existe', ESCOLHA, { resposta: 'c', motivo: 'x' }],
    ['texto da opção no lugar do id', ESCOLHA, { resposta: 'a do primeiro worker', motivo: 'x' }],
    ['nota fora da escala', NOTA, { resposta: 6, motivo: 'x' }],
    ['nota fracionária', NOTA, { resposta: 3.5, motivo: 'x' }],
    ['nota como texto', NOTA, { resposta: '4', motivo: 'x' }],
    ['"sim" no lugar de true', AFIRMACAO, { resposta: 'sim', motivo: 'x' }],
    ['"true" como texto', AFIRMACAO, { resposta: 'true', motivo: 'x' }],
    ['1 no lugar de true', AFIRMACAO, { resposta: 1, motivo: 'x' }],
    ['sem motivo', AFIRMACAO, { resposta: true }],
    ['motivo vazio', AFIRMACAO, { resposta: true, motivo: '  ' }],
    ['campo a mais', AFIRMACAO, { resposta: true, motivo: 'x', aprovar: true }],
    ['confiança acima de 1', AFIRMACAO, { resposta: true, motivo: 'x', confianca: 1.5 }],
    ['uma lista', AFIRMACAO, [true]],
    ['um número solto', NOTA, 4],
  ])('%s fica fora do esquema', (_nome, pergunta, bruto) => {
    expect(lerResposta(ler(pergunta), bruto)).toEqual({ ok: false, razao: 'fora_do_esquema' });
  });

  it('corta o motivo longo', () => {
    const lida = lerResposta(ler(AFIRMACAO), { resposta: true, motivo: 'm'.repeat(5000) });
    expect(lida.ok && lida.motivo.length).toBe(2000);
  });
});

describe('escada da decisão', () => {
  it('o primeiro degrau que decide responde, e os de cima nem são chamados', async () => {
    const rapido = decisor('rapido', { resposta: 'a', motivo: 'certo', confianca: 0.97 });
    const juiz = decisor('juiz', { resposta: 'b', motivo: 'outro' });
    const resultado = await subirEscada([rapido.d, juiz.d], ESCOLHA);
    expect(resultado).toEqual({ quem: 'decisor', decisao: { decisor: 'rapido', resposta: 'a', motivo: 'certo', confianca: 0.97 }, tentativas: [] });
    expect(juiz.registro.chamadas).toBe(0);
  });

  it('a resposta fora das opções sobe um degrau', async () => {
    const rapido = decisor('rapido', { resposta: 'c', motivo: 'inventei' });
    const juiz = decisor('juiz', { resposta: 'b', motivo: 'mais completa' });
    const resultado = await subirEscada([rapido.d, juiz.d], ESCOLHA);
    expect(resultado).toMatchObject({ quem: 'decisor', decisao: { decisor: 'juiz', resposta: 'b' }, tentativas: [{ decisor: 'rapido', razao: 'fora_do_esquema' }] });
  });

  it('a resposta ilegível sobe um degrau', async () => {
    const rapido = decisor('rapido', 'acho que a b');
    const juiz = decisor('juiz', '{"resposta":3,"motivo":"metade"}');
    const resultado = await subirEscada([rapido.d, juiz.d], NOTA);
    expect(resultado).toMatchObject({ quem: 'decisor', decisao: { decisor: 'juiz', resposta: 3 }, tentativas: [{ decisor: 'rapido', razao: 'ilegivel' }] });
  });

  it('a resposta atrasada sobe um degrau, o decisor atrasado é abortado, e a resposta que chega depois não vale', async () => {
    const rapido = decisor('rapido', { resposta: true, motivo: 'tarde demais' }, { atrasoMs: 200, prazoMs: 30 });
    const juiz = decisor('juiz', { resposta: false, motivo: '2 + 2 = 4' });
    const resultado = await subirEscada([rapido.d, juiz.d], AFIRMACAO);
    expect(resultado).toMatchObject({ quem: 'decisor', decisao: { decisor: 'juiz', resposta: false }, tentativas: [{ decisor: 'rapido', razao: 'atrasada' }] });
    expect(rapido.registro.abortado).toBe(true);
    await new Promise((ok) => setTimeout(ok, 250));
    expect(resultado).toMatchObject({ decisao: { decisor: 'juiz', resposta: false } });
  });

  it('o decisor que falha sobe um degrau', async () => {
    const rapido = decisor('rapido', null, { falha: true });
    const juiz = decisor('juiz', { resposta: 'a', motivo: 'certo' });
    expect(await subirEscada([rapido.d, juiz.d], ESCOLHA)).toMatchObject({ quem: 'decisor', tentativas: [{ decisor: 'rapido', razao: 'falha' }] });
  });

  it('o decisor que lança na hora também conta como falha', async () => {
    const quebrado: Decisor = {
      id: 'quebrado',
      prazoMs: 1000,
      decidir: () => {
        throw new Error('sem chave');
      },
    };
    expect(await subirEscada([quebrado], ESCOLHA)).toEqual({ quem: 'pessoa', tentativas: [{ decisor: 'quebrado', razao: 'falha' }] });
  });

  it('sem decisão em nenhum degrau, a pergunta vai para a pessoa, com o motivo de cada degrau', async () => {
    const degraus = [
      decisor('fora', { resposta: 'sim', motivo: 'x' }).d,
      decisor('ilegivel', 'sim').d,
      decisor('atrasado', { resposta: true, motivo: 'x' }, { atrasoMs: 200, prazoMs: 20 }).d,
      decisor('quebrado', null, { falha: true }).d,
    ];
    expect(await subirEscada(degraus, AFIRMACAO)).toEqual({
      quem: 'pessoa',
      tentativas: [
        { decisor: 'fora', razao: 'fora_do_esquema' },
        { decisor: 'ilegivel', razao: 'ilegivel' },
        { decisor: 'atrasado', razao: 'atrasada' },
        { decisor: 'quebrado', razao: 'falha' },
      ],
    });
  });

  it('nenhuma resposta sem decisão vira "sim"', async () => {
    const quaseSim: unknown[] = ['sim', 'true', '{"resposta":"sim","motivo":"x"}', { resposta: 'true', motivo: 'x' }, { resposta: 1, motivo: 'x' }, { resposta: true }, true];
    for (const bruto of quaseSim) {
      const resultado = await subirEscada([decisor('d', bruto).d], AFIRMACAO);
      expect(resultado.quem).toBe('pessoa');
      expect(resultado).not.toHaveProperty('decisao');
    }
    const atrasado = await subirEscada([decisor('d', { resposta: true, motivo: 'x' }, { atrasoMs: 100, prazoMs: 10 }).d], AFIRMACAO);
    expect(atrasado).toEqual({ quem: 'pessoa', tentativas: [{ decisor: 'd', razao: 'atrasada' }] });
  });

  it('sem degraus, vai direto para a pessoa', async () => {
    expect(await subirEscada([], AFIRMACAO)).toEqual({ quem: 'pessoa', tentativas: [] });
  });
});
