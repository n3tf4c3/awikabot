import { z } from 'zod';

/** Versão do contrato entre servidor e app. Sobe quando uma mudança quebra clientes antigos. */
export const VERSAO_PROTOCOLO = 1;

/** Intervalo do sinal de vida (`event: ping`) do fluxo de eventos, em milissegundos. */
export const INTERVALO_PING_MS = 15_000;

/** Limites compartilhados: o servidor valida com eles e o app os usa nos campos. */
export const LIMITES = {
  nomeDispositivo: 60,
  nomeBot: 60,
  instrucoes: 8000,
  modelo: 80,
  texto: 20_000,
  mensagensPorPagina: 50,
  ferramenta: 100,
  resumoAprovacao: 4000,
} as const;

/** Quanto tempo um pedido de aprovação espera pela pessoa antes de ser negado sozinho. */
export const ESPERA_APROVACAO_MS = 15 * 60_000;

const Id = z.string().regex(/^[a-z0-9]{16}$/);
/** Milissegundos desde 1970. */
const Instante = z.number().int().nonnegative();

/** Resposta de `GET /healthz`, que não pede token: só o estado, sem nada que identifique o servidor. */
export const EsquemaSaude = z.strictObject({ status: z.literal('ok') });
export type Saude = z.infer<typeof EsquemaSaude>;

/** O que o app precisa saber do servidor. Só sai na resposta do pareamento. */
export const EsquemaInfoDoServidor = z.object({
  versao: z.string().min(1).max(64),
  protocolo: z.number().int().positive(),
});
export type InfoDoServidor = z.infer<typeof EsquemaInfoDoServidor>;

/** Corpo de toda resposta de erro. `erro` é um código estável, não um texto para a tela. */
export const EsquemaErro = z.object({ erro: z.string().min(1).max(64) });
export type Erro = z.infer<typeof EsquemaErro>;

// --- Pareamento -------------------------------------------------------------

/** Tira espaços e hifens e põe em maiúsculas, para aceitar o código como a pessoa digitar. */
export function normalizarCodigoPareamento(codigo: string): string {
  return codigo.replace(/[\s-]/g, '').toUpperCase();
}

export const EsquemaPedidoPareamento = z.object({
  codigo: z.string().max(40).transform(normalizarCodigoPareamento).pipe(z.string().regex(/^[A-Z2-7]{12}$/)),
  nome: z.string().trim().min(1).max(LIMITES.nomeDispositivo),
});
export type PedidoPareamento = z.infer<typeof EsquemaPedidoPareamento>;

export const EsquemaDispositivo = z.object({
  id: Id,
  nome: z.string().min(1).max(LIMITES.nomeDispositivo),
  criadoEm: Instante,
});
export type Dispositivo = z.infer<typeof EsquemaDispositivo>;

/** O token só aparece aqui, uma vez. O servidor guarda apenas o hash dele. */
export const EsquemaRespostaPareamento = z.object({
  token: z.string().min(43).max(64),
  dispositivo: EsquemaDispositivo,
  servidor: EsquemaInfoDoServidor,
});
export type RespostaPareamento = z.infer<typeof EsquemaRespostaPareamento>;

// --- Bots -------------------------------------------------------------------

const NomeBot = z.string().trim().min(1).max(LIMITES.nomeBot);
const Instrucoes = z.string().max(LIMITES.instrucoes);
/** Nome de modelo do motor. O formato restrito impede que vire uma opção de linha de comando. */
const Modelo = z.string().trim().min(1).max(LIMITES.modelo).regex(/^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/);

export const EsquemaBotEntrada = z.object({
  nome: NomeBot,
  instrucoes: Instrucoes.default(''),
  modelo: Modelo.nullable().default(null),
});
export type BotEntrada = z.infer<typeof EsquemaBotEntrada>;

export const EsquemaBotEdicao = z
  .object({
    nome: NomeBot.optional(),
    instrucoes: Instrucoes.optional(),
    modelo: Modelo.nullable().optional(),
  })
  .refine((edicao) => Object.values(edicao).some((valor) => valor !== undefined), { message: 'edição vazia' });
export type BotEdicao = z.infer<typeof EsquemaBotEdicao>;

export const EsquemaBot = z.object({
  id: Id,
  nome: NomeBot,
  instrucoes: Instrucoes,
  modelo: Modelo.nullable(),
  criadoEm: Instante,
  atualizadoEm: Instante,
  turnoAtivo: z.boolean(),
});
export type Bot = z.infer<typeof EsquemaBot>;

export const EsquemaListaBots = z.object({ bots: z.array(EsquemaBot) });
export type ListaBots = z.infer<typeof EsquemaListaBots>;

// --- Conversa ---------------------------------------------------------------

export const EsquemaMensagem = z.object({
  id: Id,
  botId: Id,
  /** Ordem dentro do bot, a partir de 1. Serve de cursor da paginação. */
  seq: z.number().int().positive(),
  papel: z.enum(['usuario', 'bot']),
  texto: z.string(),
  estado: z.enum(['completa', 'em_andamento', 'parada', 'falhou']),
  criadaEm: Instante,
});
export type Mensagem = z.infer<typeof EsquemaMensagem>;

export const EsquemaListaMensagens = z.object({
  mensagens: z.array(EsquemaMensagem),
  temMais: z.boolean(),
});
export type ListaMensagens = z.infer<typeof EsquemaListaMensagens>;

export const EsquemaPedidoTurno = z.object({
  texto: z.string().trim().min(1).max(LIMITES.texto),
});
export type PedidoTurno = z.infer<typeof EsquemaPedidoTurno>;

export const EsquemaRespostaTurno = z.object({
  usuario: EsquemaMensagem,
  bot: EsquemaMensagem,
});
export type RespostaTurno = z.infer<typeof EsquemaRespostaTurno>;

// --- Aprovações -------------------------------------------------------------

/**
 * Pedido do bot para usar uma ferramenta que muda algo: rodar um comando, gravar um
 * arquivo, acessar a rede. A ação só acontece depois de `aprovada`. Sem resposta em
 * `ESPERA_APROVACAO_MS`, ou se o turno acabar antes, o pedido fica `expirada` e a ação não roda.
 */
export const EsquemaAprovacao = z.object({
  id: Id,
  botId: Id,
  /** A resposta do bot que estava em andamento quando o pedido surgiu. */
  mensagemId: Id,
  /** Nome da ferramenta do motor, como "Bash" ou "Write". */
  ferramenta: z.string().min(1).max(LIMITES.ferramenta),
  /** O que a pessoa lê no cartão: o comando, o arquivo ou o endereço. */
  resumo: z.string().max(LIMITES.resumoAprovacao),
  estado: z.enum(['pendente', 'aprovada', 'negada', 'expirada']),
  criadaEm: Instante,
  resolvidaEm: Instante.nullable(),
});
export type Aprovacao = z.infer<typeof EsquemaAprovacao>;

/** Resposta de `GET /v1/aprovacoes`: só as pendentes, de todos os bots, da mais antiga para a mais nova. */
export const EsquemaListaAprovacoes = z.object({ aprovacoes: z.array(EsquemaAprovacao) });
export type ListaAprovacoes = z.infer<typeof EsquemaListaAprovacoes>;

/** Corpo de `POST /v1/aprovacoes/:id`. */
export const EsquemaDecisaoAprovacao = z.object({ decisao: z.enum(['aprovar', 'negar']) });
export type DecisaoAprovacao = z.infer<typeof EsquemaDecisaoAprovacao>;

// --- Eventos (GET /v1/eventos, text/event-stream) ---------------------------

/**
 * Cada evento chega como `event: evento`, com um `id` e este objeto em `data`.
 * Para retomar, o app reconecta com o cabeçalho `Last-Event-ID` e recebe o que perdeu.
 * Numa conexão sem esse cabeçalho, o primeiro `event: ping` traz o `id` do ponto atual.
 * `ressincronizar` avisa que o app perdeu eventos e deve buscar listas e mensagens de novo.
 *
 * Em `texto`, `posicao` é o tamanho que a mensagem já tinha antes do trecho. Quem buscou a
 * mensagem em andamento junta os trechos sem repetir: ignora o que já tem e, se houver
 * um buraco, busca de novo.
 */
export const EsquemaEvento = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('turno_iniciado'), botId: Id, mensagemId: Id }),
  z.object({
    tipo: z.literal('texto'),
    botId: Id,
    mensagemId: Id,
    posicao: z.number().int().nonnegative(),
    trecho: z.string(),
  }),
  z.object({ tipo: z.literal('turno_terminado'), botId: Id, mensagem: EsquemaMensagem }),
  z.object({ tipo: z.literal('bot_salvo'), bot: EsquemaBot }),
  z.object({ tipo: z.literal('aprovacao_pedida'), aprovacao: EsquemaAprovacao }),
  /** A aprovação saiu de `pendente`: alguém decidiu, o prazo venceu ou o turno acabou. */
  z.object({ tipo: z.literal('aprovacao_resolvida'), aprovacao: EsquemaAprovacao }),
  z.object({ tipo: z.literal('ressincronizar') }),
]);
export type Evento = z.infer<typeof EsquemaEvento>;
