import { EsquemaBotEntrada, LIMITES, type Bot, type BotEdicao, type BotEntrada } from '@awikabot/core';

/** O formulário do bot como a pessoa digita: tudo texto, modelo vazio quer dizer "padrão do motor". */
export interface CamposBot {
  nome: string;
  instrucoes: string;
  modelo: string;
}

export type ErrosBot = Partial<Record<keyof CamposBot, string>>;

export const CAMPOS_BOT_VAZIOS: CamposBot = { nome: '', instrucoes: '', modelo: '' };

const MENSAGENS: Readonly<Record<keyof CamposBot, string>> = {
  nome: `Informe um nome com até ${LIMITES.nomeBot} caracteres.`,
  instrucoes: `As instruções têm no máximo ${LIMITES.instrucoes} caracteres.`,
  modelo: `Use até ${LIMITES.modelo} caracteres, começando por letra ou número: letras, números, ponto, hífen, sublinhado, dois-pontos e colchetes.`,
};

export function camposDoBot(bot: Bot): CamposBot {
  return { nome: bot.nome, instrucoes: bot.instrucoes, modelo: bot.modelo ?? '' };
}

/** Valida com o esquema do contrato e devolve a entrada pronta para o servidor, ou o erro de cada campo. */
export function validarBot(campos: CamposBot): { ok: true; entrada: BotEntrada } | { ok: false; erros: ErrosBot } {
  const modelo = campos.modelo.trim();
  const lido = EsquemaBotEntrada.safeParse({
    nome: campos.nome,
    instrucoes: campos.instrucoes,
    modelo: modelo === '' ? null : modelo,
  });
  if (lido.success) return { ok: true, entrada: lido.data };
  const erros: ErrosBot = {};
  for (const problema of lido.error.issues) {
    const campo = problema.path[0];
    if (campo === 'nome' || campo === 'instrucoes' || campo === 'modelo') erros[campo] = MENSAGENS[campo];
  }
  return { ok: false, erros };
}

/** Só os campos que mudaram em relação ao bot, para o `PATCH`. `null` quando nada mudou. */
export function edicaoDoBot(bot: Bot, entrada: BotEntrada): BotEdicao | null {
  const edicao: BotEdicao = {};
  if (entrada.nome !== bot.nome) edicao.nome = entrada.nome;
  if (entrada.instrucoes !== bot.instrucoes) edicao.instrucoes = entrada.instrucoes;
  if (entrada.modelo !== bot.modelo) edicao.modelo = entrada.modelo;
  return Object.keys(edicao).length > 0 ? edicao : null;
}
