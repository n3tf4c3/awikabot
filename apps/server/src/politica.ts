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
/** Não tocam em arquivo, comando nem rede. */
const SEM_EFEITO = new Set(['TodoWrite']);

const FORA_DA_PASTA = 'o bot só lê arquivos da própria pasta de trabalho';

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

function resumir(ferramenta: string, entrada: Record<string, unknown>): string {
  const arquivo = texto(entrada.file_path) ?? texto(entrada.notebook_path);
  switch (ferramenta) {
    case 'Bash':
      return cortar(texto(entrada.command) ?? JSON.stringify(entrada));
    case 'Write':
      return cortar(`Gravar o arquivo ${arquivo ?? '(sem nome)'}`);
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return cortar(`Alterar o arquivo ${arquivo ?? '(sem nome)'}`);
    case 'WebFetch':
      return cortar(`Abrir ${texto(entrada.url) ?? '(sem endereço)'}`);
    case 'WebSearch':
      return cortar(`Pesquisar na web: ${texto(entrada.query) ?? '(sem termo)'}`);
    default:
      return cortar(JSON.stringify(entrada));
  }
}

/**
 * Decide sem a pessoa o que é seguro decidir: leitura dentro da pasta do bot passa, leitura
 * fora dela é negada. Todo o resto, inclusive ferramenta desconhecida, vai para a pessoa.
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

  return { acao: 'perguntar', resumo: resumir(ferramenta, entrada) };
}
