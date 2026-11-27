import { z } from 'zod';

/**
 * A decisão é uma pergunta fechada que o servidor faz: escolher entre opções, dar uma nota numa
 * escala ou dizer se uma afirmação é verdadeira. Quem responde é um decisor; quem não responde,
 * ou responde fora do esquema, deixa a pergunta subir um degrau da escada (`subirEscada`), que
 * termina na pessoa.
 *
 * Nada aqui resolve um pedido de aprovação. A decisão de uma aprovação só entra pela pessoa, com
 * token de aparelho (`POST /v1/aprovacoes/:id`); este módulo não conhece as aprovações.
 *
 * Por ora a pergunta não sai pela API: o esquema fica no servidor. Quando a decisão aparecer na
 * conversa da equipe (etapa 7, passo 5), o que sair vai para `packages/core`.
 */

export const LIMITES_DA_DECISAO = {
  enunciado: 2000,
  /** O estado que o decisor avalia: a tarefa, a entrega. É dado, nunca instrução. */
  contexto: 60_000,
  opcoes: 255,
  textoDaOpcao: 500,
  /** Quantos valores a escala de uma nota pode ter. */
  passosDaNota: 101,
  motivo: 2000,
} as const;

const IdDaOpcao = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);
const Enunciado = z.string().trim().min(1).max(LIMITES_DA_DECISAO.enunciado);
const Contexto = z.string().max(LIMITES_DA_DECISAO.contexto).default('');

export const EsquemaPergunta = z.discriminatedUnion('tipo', [
  z.object({
    tipo: z.literal('escolha'),
    enunciado: Enunciado,
    contexto: Contexto,
    opcoes: z
      .array(z.object({ id: IdDaOpcao, texto: z.string().trim().min(1).max(LIMITES_DA_DECISAO.textoDaOpcao) }))
      .min(2)
      .max(LIMITES_DA_DECISAO.opcoes)
      .refine((opcoes) => new Set(opcoes.map((opcao) => opcao.id)).size === opcoes.length, { message: 'opções repetidas' }),
  }),
  z
    .object({
      tipo: z.literal('nota'),
      enunciado: Enunciado,
      contexto: Contexto,
      minimo: z.number().int().min(-1000).max(1000),
      maximo: z.number().int().min(-1000).max(1000),
    })
    .refine((nota) => nota.minimo < nota.maximo && nota.maximo - nota.minimo < LIMITES_DA_DECISAO.passosDaNota, { message: 'escala inválida' }),
  z.object({ tipo: z.literal('afirmacao'), enunciado: Enunciado, contexto: Contexto }),
]);
export type Pergunta = z.infer<typeof EsquemaPergunta>;
/** A pergunta como quem a faz escreve: o contexto pode faltar. */
export type PerguntaEntrada = z.input<typeof EsquemaPergunta>;

/** A opção escolhida, a nota ou a afirmação dada por verdadeira (`true`) ou falsa (`false`). */
export type ValorDaResposta = string | number | boolean;

/** O esquema do valor, como o motor o recebe (JSON Schema): só cabe o que a pergunta admite. */
function esquemaDoValor(pergunta: Pergunta): Record<string, unknown> {
  switch (pergunta.tipo) {
    case 'escolha':
      return { type: 'string', enum: pergunta.opcoes.map((opcao) => opcao.id) };
    case 'nota':
      return { type: 'integer', minimum: pergunta.minimo, maximum: pergunta.maximo };
    case 'afirmacao':
      return { type: 'boolean' };
  }
}

/**
 * O esquema da resposta, em JSON Schema, para o motor prender a resposta final a ele: o valor e o
 * motivo, e nada mais.
 */
export function esquemaDaResposta(pergunta: Pergunta): Record<string, unknown> {
  return {
    type: 'object',
    properties: { resposta: esquemaDoValor(pergunta), motivo: { type: 'string' } },
    required: ['resposta', 'motivo'],
    additionalProperties: false,
  };
}

/** O mesmo esquema, em zod, para conferir o que voltou. A confiança só vem de um decisor rápido. */
function conferidorDaResposta(pergunta: Pergunta) {
  const valor =
    pergunta.tipo === 'escolha'
      ? z.enum(pergunta.opcoes.map((opcao) => opcao.id) as [string, ...string[]])
      : pergunta.tipo === 'nota'
        ? z.number().int().min(pergunta.minimo).max(pergunta.maximo)
        : z.boolean();
  return z.strictObject({
    resposta: valor,
    motivo: z.string().trim().min(1),
    confianca: z.number().min(0).max(1).nullable().optional(),
  });
}

/** Por que uma pergunta ficou sem decisão num degrau. Todas sobem um degrau; nenhuma vira "sim". */
export type SemDecisao = 'fora_do_esquema' | 'ilegivel' | 'atrasada' | 'falha';

export type LeituraDaResposta =
  | { ok: true; resposta: ValorDaResposta; motivo: string; confianca: number | null }
  | { ok: false; razao: 'fora_do_esquema' | 'ilegivel' };

/**
 * Confere o que um decisor devolveu contra o esquema da pergunta. Texto que não é JSON, ou nada,
 * é ilegível; JSON fora do esquema (outra opção, nota fora da escala, "sim" no lugar de `true`,
 * campo a mais, motivo vazio) é fora do esquema. Só uma resposta inteira dentro dele vale.
 */
export function lerResposta(pergunta: Pergunta, bruto: unknown): LeituraDaResposta {
  let lido = bruto;
  if (typeof bruto === 'string') {
    try {
      lido = JSON.parse(bruto);
    } catch {
      return { ok: false, razao: 'ilegivel' };
    }
  }
  if (lido === undefined || lido === null) return { ok: false, razao: 'ilegivel' };
  const conferido = conferidorDaResposta(pergunta).safeParse(lido);
  if (!conferido.success) return { ok: false, razao: 'fora_do_esquema' };
  const motivo = conferido.data.motivo.slice(0, LIMITES_DA_DECISAO.motivo);
  return { ok: true, resposta: conferido.data.resposta, motivo, confianca: conferido.data.confianca ?? null };
}

/**
 * Quem responde a uma pergunta fechada. `decidir` devolve a resposta crua, no formato
 * `{ resposta, motivo, confianca? }` ou como texto JSON; quem confere é a escada, nunca o decisor.
 * Rejeitar conta como falha. O sinal é abortado quando o prazo vence: o decisor deve parar o que
 * estiver fazendo.
 */
export interface Decisor {
  /** Quem respondeu, para a decisão gravada: o juiz e o motor dele, ou o decisor rápido. */
  readonly id: string;
  /** Quanto a escada espera este decisor antes de dar a pergunta por atrasada. */
  readonly prazoMs: number;
  decidir(pergunta: Pergunta, sinal: AbortSignal): Promise<unknown>;
}

export interface DecisaoTomada {
  decisor: string;
  resposta: ValorDaResposta;
  motivo: string;
  confianca: number | null;
}

export interface Tentativa {
  decisor: string;
  razao: SemDecisao;
}

export type ResultadoDaEscada =
  | { quem: 'decisor'; decisao: DecisaoTomada; tentativas: Tentativa[] }
  /** Nenhum decisor decidiu: a pergunta vai para a pessoa. */
  | { quem: 'pessoa'; tentativas: Tentativa[] };

const ATRASADA = Symbol('atrasada');

/** Pergunta a um decisor, com prazo. Sempre resolve: atraso, falha e resposta fora do esquema viram "sem decisão". */
export async function perguntarA(decisor: Decisor, pergunta: Pergunta): Promise<DecisaoTomada | Tentativa> {
  const controle = new AbortController();
  let relogio: NodeJS.Timeout | undefined;
  const prazo = new Promise<typeof ATRASADA>((ok) => {
    relogio = setTimeout(() => ok(ATRASADA), decisor.prazoMs);
  });
  // A resposta que chegar depois do prazo, ou a rejeição, não troca o que já foi dado.
  const resposta = Promise.resolve()
    .then(() => decisor.decidir(pergunta, controle.signal))
    .then(
      (bruto) => ({ bruto }),
      () => null,
    );
  const vencedor = await Promise.race([resposta, prazo]);
  clearTimeout(relogio);
  if (vencedor === ATRASADA) {
    controle.abort();
    return { decisor: decisor.id, razao: 'atrasada' };
  }
  if (vencedor === null) return { decisor: decisor.id, razao: 'falha' };
  const lida = lerResposta(pergunta, vencedor.bruto);
  if (!lida.ok) return { decisor: decisor.id, razao: lida.razao };
  return { decisor: decisor.id, resposta: lida.resposta, motivo: lida.motivo, confianca: lida.confianca };
}

/**
 * A escada da decisão: cada degrau é um decisor, do mais barato ao mais caro (regra no código,
 * decisor rápido, juiz). O primeiro que decide dentro do esquema e do prazo responde; o que não
 * decide passa a pergunta ao seguinte. Sem decisão em nenhum, a pergunta vai para a pessoa.
 * Uma pergunta fora do esquema é defeito de quem pergunta, não falta de decisão: lança antes de
 * qualquer degrau.
 */
export async function subirEscada(degraus: readonly Decisor[], entrada: PerguntaEntrada): Promise<ResultadoDaEscada> {
  const pergunta = EsquemaPergunta.parse(entrada);
  const tentativas: Tentativa[] = [];
  for (const decisor of degraus) {
    const resultado = await perguntarA(decisor, pergunta);
    if ('razao' in resultado) {
      tentativas.push(resultado);
      continue;
    }
    return { quem: 'decisor', decisao: resultado, tentativas };
  }
  return { quem: 'pessoa', tentativas };
}
