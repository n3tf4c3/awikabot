import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { ESPERA_APROVACAO_MS } from '@awikabot/core';

/**
 * Prazo que o motor dá ao gancho, em segundos. Fica acima do prazo do próprio gancho
 * (`PRAZO_DO_PEDIDO_MS`, em `gancho.ts`): um gancho que o motor corta por tempo não bloqueia a
 * ferramenta, então quem precisa desistir primeiro, negando, é o gancho.
 */
export const PRAZO_DO_GANCHO_S = Math.ceil(ESPERA_APROVACAO_MS / 1000) + 60;

/** Onde o Claude Code lê, no Linux, a configuração que nem o usuário nem o projeto sobrepõem. */
export const CAMINHO_DA_CONFIGURACAO_GERENCIADA = '/etc/claude-code/managed-settings.json';

type Ganchos = { PreToolUse: { matcher: string; hooks: { type: 'command'; command: string; timeout: number }[] }[] };

/** O gancho roda antes de toda ferramenta, inclusive as de subagentes e de servidores MCP. */
function ganchos(comando: string): Ganchos {
  return { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: comando, timeout: PRAZO_DO_GANCHO_S }] }] };
}

/** Para o servidor fora da imagem: o gancho vai na opção `--settings` de cada turno. */
export function configuracaoPorOpcao(comando: string): { hooks: Ganchos } {
  return { hooks: ganchos(comando) };
}

/**
 * Para a imagem: o gancho mora na configuração gerenciada, gravada na parte somente leitura
 * do sistema de arquivos. Nenhum arquivo que um bot consiga escrever o desliga, e ganchos de
 * outras origens (usuário, projeto, plugins) ficam bloqueados.
 */
export function configuracaoGerenciada(comando: string): { allowManagedHooksOnly: true; hooks: Ganchos } {
  return { allowManagedHooksOnly: true, hooks: ganchos(comando) };
}

/** O arquivo gerenciado existe e é exatamente o que este servidor espera? */
export function gerenciadaInstalada(comando: string, caminho = CAMINHO_DA_CONFIGURACAO_GERENCIADA): boolean {
  try {
    return isDeepStrictEqual(JSON.parse(readFileSync(caminho, 'utf8')), configuracaoGerenciada(comando));
  } catch {
    return false;
  }
}
