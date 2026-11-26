import { realpathSync } from 'node:fs';
import path from 'node:path';
import { LIMITES } from '@awikabot/core';

/** O que o servidor faz com um pedido do motor para usar uma ferramenta. */
export type Veredito =
  | { acao: 'permitir' }
  | { acao: 'negar'; motivo: string }
  | { acao: 'perguntar'; resumo: string };

/** Só leem. Passam sem perguntar, desde que fiquem dentro da pasta do bot. */
const SO_LEITURA = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
/** Gravam num arquivo. Vão para a pessoa, mas só quando o arquivo fica dentro da pasta do bot. */
const DE_ESCRITA = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
/** Não tocam em arquivo, comando nem rede. */
const SEM_EFEITO = new Set(['TodoWrite']);

const FORA_DA_PASTA = 'o bot só lê arquivos da própria pasta de trabalho';
const GRAVACAO_FORA_DA_PASTA = 'o bot só grava arquivos na própria pasta de trabalho';
const CONFIGURACAO_DO_MOTOR = 'o bot não altera a configuração do motor';

/** Caminho com os atalhos resolvidos. Para o que ainda não existe, resolve a pasta mais próxima que existe. */
function caminhoReal(caminho: string): string {
  try {
    return realpathSync(caminho);
  } catch {
    const pai = path.dirname(caminho);
    return pai === caminho ? caminho : path.join(caminhoReal(pai), path.basename(caminho));
  }
}

function dentroDaPasta(pasta: string, alvo: string): boolean {
  const base = caminhoReal(path.resolve(pasta));
  const real = caminhoReal(path.resolve(base, alvo));
  return real === base || real.startsWith(base + path.sep);
}

/**
 * Arquivos que um motor lê como configuração na pasta de trabalho: neles cabem ganchos e
 * comandos que rodariam nos turnos seguintes sem passar por aprovação. `.claude/` e `.mcp.json`
 * são do Claude Code; `.codex/` é do Codex.
 */
function ehConfiguracaoDoMotor(pasta: string, alvo: string): boolean {
  const base = caminhoReal(path.resolve(pasta));
  const real = caminhoReal(path.resolve(base, alvo));
  const partes = path.relative(base, real).split(path.sep).map((parte) => parte.toLowerCase());
  return partes.includes('.claude') || partes.includes('.codex') || partes.at(-1) === '.mcp.json';
}

/** Padrão de busca que não sai da pasta: relativo e sem subir de nível. */
function padraoContido(padrao: string): boolean {
  return !path.isAbsolute(padrao) && !/^[A-Za-z]:/.test(padrao) && !padrao.split(/[\\/]/).includes('..');
}

function cortar(texto: string): string {
  const limite = LIMITES.resumoAprovacao;
  const aviso = '\n… (cortado)';
  return texto.length <= limite ? texto : texto.slice(0, limite - aviso.length) + aviso;
}

function texto(valor: unknown): string | null {
  return typeof valor === 'string' && valor.length > 0 ? valor : null;
}

/** Uma troca de texto, como a pessoa a lê: o que sai e o que entra. */
function descreverTroca(troca: unknown): string | null {
  if (typeof troca !== 'object' || troca === null) return null;
  const { old_string: sai, new_string: entra } = troca as Record<string, unknown>;
  if (typeof sai !== 'string' && typeof entra !== 'string') return null;
  return `Sai:\n${typeof sai === 'string' ? sai : ''}\nEntra:\n${typeof entra === 'string' ? entra : ''}`;
}

/** O que vai ser gravado, para o cartão não mostrar só o nome do arquivo. */
function conteudoDaGravacao(ferramenta: string, entrada: Record<string, unknown>): string | null {
  // O Codex descreve toda gravação por um diff; num arquivo novo, é o conteúdo inteiro.
  if (typeof entrada.diff === 'string') return entrada.diff;
  if (ferramenta === 'Write') return typeof entrada.content === 'string' ? entrada.content : null;
  if (ferramenta === 'NotebookEdit') return typeof entrada.new_source === 'string' ? entrada.new_source : null;
  const trocas = Array.isArray(entrada.edits) ? entrada.edits : [entrada];
  const descritas = trocas.map(descreverTroca).filter((troca) => troca !== null);
  return descritas.length > 0 ? descritas.join('\n\n') : null;
}

function tituloDaGravacao(ferramenta: string, entrada: Record<string, unknown>, arquivo: string | null): string {
  const nome = arquivo ?? '(sem nome)';
  // `apagar` e `mover_para` vêm do Codex, que apaga e renomeia arquivos pela mesma ferramenta.
  if (entrada.apagar === true) return `Apagar o arquivo ${nome}`;
  const destino = texto(entrada.mover_para);
  if (destino !== null) return `Mover o arquivo ${nome} para ${destino}`;
  return `${ferramenta === 'Write' ? 'Gravar' : 'Alterar'} o arquivo ${nome}`;
}

function resumir(ferramenta: string, entrada: Record<string, unknown>, pastaDoBot: string): string {
  const arquivo = texto(entrada.file_path) ?? texto(entrada.notebook_path);
  switch (ferramenta) {
    case 'Bash': {
      const comando = texto(entrada.command) ?? JSON.stringify(entrada);
      // O Codex diz em que pasta o comando roda; fora da pasta do bot, o cartão avisa.
      const pasta = texto(entrada.cwd);
      const fora = pasta !== null && path.resolve(pastaDoBot, pasta) !== path.resolve(pastaDoBot);
      return cortar(fora ? `${comando}\n\n(na pasta ${pasta})` : comando);
    }
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const titulo = tituloDaGravacao(ferramenta, entrada, arquivo);
      const conteudo = conteudoDaGravacao(ferramenta, entrada);
      return cortar(conteudo === null ? titulo : `${titulo}\n\n${conteudo}`);
    }
    case 'WebFetch':
      return cortar(`Abrir ${texto(entrada.url) ?? '(sem endereço)'}`);
    case 'WebSearch':
      return cortar(`Pesquisar na web: ${texto(entrada.query) ?? '(sem termo)'}`);
    default:
      return cortar(JSON.stringify(entrada));
  }
}

/**
 * Decide sem a pessoa o que é seguro decidir: leitura dentro da pasta do bot passa; leitura e
 * gravação fora dela, e gravação na configuração do motor, são negadas. Todo o resto, inclusive
 * ferramenta desconhecida, vai para a pessoa.
 */
export function avaliarFerramenta(ferramenta: string, entrada: Record<string, unknown>, pastaDoBot: string): Veredito {
  if (SEM_EFEITO.has(ferramenta)) return { acao: 'permitir' };

  if (SO_LEITURA.has(ferramenta)) {
    for (const campo of ['file_path', 'path', 'notebook_path']) {
      const valor = entrada[campo];
      if (valor === undefined || valor === null) continue;
      if (typeof valor !== 'string' || !dentroDaPasta(pastaDoBot, valor)) return { acao: 'negar', motivo: FORA_DA_PASTA };
    }
    for (const campo of ['pattern', 'glob']) {
      const valor = entrada[campo];
      // Em Grep, `pattern` é uma expressão regular, não um caminho: só o `glob` dele filtra arquivos.
      if (campo === 'pattern' && ferramenta !== 'Glob') continue;
      if (valor === undefined || valor === null) continue;
      if (typeof valor !== 'string' || !padraoContido(valor)) return { acao: 'negar', motivo: FORA_DA_PASTA };
    }
    return { acao: 'permitir' };
  }

  if (DE_ESCRITA.has(ferramenta)) {
    // Sem um caminho legível não dá para saber onde a gravação cai: não vai nem para a pessoa.
    const alvo = texto(entrada.file_path) ?? texto(entrada.notebook_path);
    if (alvo === null) return { acao: 'negar', motivo: GRAVACAO_FORA_DA_PASTA };
    // Um arquivo movido grava em dois lugares, e os dois ficam presos à pasta do bot.
    const destino = entrada.mover_para;
    if (destino !== undefined && destino !== null && texto(destino) === null) return { acao: 'negar', motivo: GRAVACAO_FORA_DA_PASTA };
    for (const caminho of [alvo, texto(destino)]) {
      if (caminho === null) continue;
      if (!dentroDaPasta(pastaDoBot, caminho)) return { acao: 'negar', motivo: GRAVACAO_FORA_DA_PASTA };
      if (ehConfiguracaoDoMotor(pastaDoBot, caminho)) return { acao: 'negar', motivo: CONFIGURACAO_DO_MOTOR };
    }
  }

  return { acao: 'perguntar', resumo: resumir(ferramenta, entrada, pastaDoBot) };
}
