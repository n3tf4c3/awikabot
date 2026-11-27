import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A configuração com que o Antigravity roda como motor de um bot. Ele não tem lugar gerenciado,
 * fora do alcance do bot, como o Claude Code e o Codex: a configuração pessoal mora em
 * `~/.gemini`, no volume. Por isso o servidor a repõe e a confere antes de cada turno. A prova da
 * etapa 7 mediu que o Antigravity só lê a configuração no começo de cada turno: o que um comando
 * aprovado trocar no meio de um turno não vale nele, e é desfeito antes do seguinte.
 *
 * O que cada parte fecha:
 *
 * - o gancho `PreToolUse`, para toda ferramenta, nega o que não conhece. Sem ele, a busca na web,
 *   os subagentes e os agendamentos rodam sem pedido de permissão;
 * - a sessão abre numa pasta vazia do servidor, e não na pasta do bot. O Antigravity lê `.agents/`
 *   da pasta da sessão como configuração: um gancho ou um servidor MCP plantado ali roda sem
 *   aprovação. Com a pasta do bot fora da sessão, nada dela é lido, e toda leitura e gravação nela
 *   chega ao driver como pedido de permissão, com o caminho completo. A pasta da sessão é
 *   esvaziada antes de cada turno;
 * - os ajustes tiram as regras que dispensariam o pedido.
 */

/**
 * As ferramentas que já chegam ao driver como pedido de permissão do protocolo: ler, gravar e
 * editar arquivo, e o terminal. Os nomes são os do `agy` 1.5.18 fixado na imagem, levantados na
 * prova; a documentação traz outros. Trocar a versão é levantar de novo: um nome que mudou cai no
 * "nega", que é o lado seguro.
 */
export const FERRAMENTAS_COM_PEDIDO: ReadonlySet<string> = new Set(['read_file', 'write_file', 'edit_file', 'run_command']);

export type DecisaoDoGancho =
  | { decision: 'deny'; reason: string }
  /** Segue para o pedido de permissão, com a linha do comando reescrita para partir da pasta do bot. */
  | { decision: 'allow'; reason: string; overwrite: { CommandLine: string } };

/**
 * A linha de um comando de terminal como ela roda de verdade: partindo da pasta do bot. É o que o
 * gancho entrega ao Antigravity e o que o driver mostra no cartão. As duas pontas usam esta função
 * para a pessoa aprovar exatamente o que vai rodar.
 */
export function comandoNaPastaDoBot(pastaDoBot: string, linha: string): string {
  // Entre aspas simples, a única coisa que o shell interpreta é a própria aspa simples.
  return `cd '${pastaDoBot.replaceAll("'", `'\\''`)}' && ${linha}`;
}

/** A ferramenta de terminal: a única em que o gancho mexe no que o modelo pediu. */
const FERRAMENTA_DE_TERMINAL = 'run_command';

/**
 * O que o gancho responde ao Antigravity antes de cada ferramenta. `null` é sair calado: a
 * ferramenta segue o fluxo normal, que é o pedido de permissão ao driver. Tudo o que não está na
 * lista é negado, inclusive o que uma versão nova trouxer e uma entrada que não dá para ler.
 *
 * O gancho quebrado também nega: a prova mediu que o Antigravity não roda a ferramenta quando o
 * gancho sai com erro, devolve algo ilegível ou estoura o prazo. Só não nega quando sai com 0 sem
 * dizer nada, e por isso a negação é o padrão aqui.
 *
 * No terminal, o gancho reescreve a linha do comando para ela partir da pasta do bot. Sem isso o
 * comando partiria da pasta da sessão, que é do servidor, e um caminho relativo cairia lá. O
 * `agy` 1.5.18 não tem argumento de pasta no comando: o que pega é trocar a linha. A resposta
 * "permitir" do gancho não dispensa o pedido de permissão, que chega ao driver do mesmo jeito,
 * mas com a linha original: por isso o driver refaz a mesma conta antes de mostrar o cartão.
 */
export function decidirNoGanchoDoAntigravity(entrada: string, pastaDoBot: string | null = null): DecisaoDoGancho | null {
  let ferramenta: unknown;
  let linha: unknown;
  try {
    const chamada = (JSON.parse(entrada) as { toolCall?: { name?: unknown; args?: { CommandLine?: unknown } } }).toolCall;
    ferramenta = chamada?.name;
    linha = chamada?.args?.CommandLine;
  } catch {
    return { decision: 'deny', reason: 'pedido ilegível' };
  }
  if (typeof ferramenta !== 'string' || !FERRAMENTAS_COM_PEDIDO.has(ferramenta)) {
    return { decision: 'deny', reason: 'esta ferramenta não existe para um bot do awikabot' };
  }
  // Sem a linha, o gancho não tem o que reescrever: o pedido segue, e o driver o nega.
  if (ferramenta === FERRAMENTA_DE_TERMINAL && pastaDoBot !== null && typeof linha === 'string' && linha !== '') {
    return { decision: 'allow', reason: 'o comando parte da pasta do bot', overwrite: { CommandLine: comandoNaPastaDoBot(pastaDoBot, linha) } };
  }
  return null;
}

/** O prazo, em segundos, que o Antigravity dá ao gancho. Ele só decide pelo nome: responde na hora. */
const PRAZO_DO_GANCHO_S = 30;

export function ganchosDoAntigravity(comando: string): string {
  const ganchos = { hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: comando, timeout: PRAZO_DO_GANCHO_S }] }] } };
  return `${JSON.stringify(ganchos, null, 2)}\n`;
}

/**
 * Os ajustes que o servidor fixa em `settings.json`. As regras de permissão (`permissions`) e os
 * modos que aprovam sozinhos dispensariam o pedido; a caixa de areia do Antigravity não sobe no
 * contêiner. O resto do arquivo, que é da própria CLI, fica como está.
 */
const AJUSTES_FIXOS = { toolPermission: 'request-review', allowNonWorkspaceAccess: false, enableTerminalSandbox: false } as const;
const AJUSTES_PROIBIDOS = ['permissions', 'agentMode'] as const;

/** A pasta em que o Antigravity guarda a configuração pessoal, a partir da pasta do usuário. */
export const pastaDeConfiguracao = (casa: string): string => path.join(casa, '.gemini', 'config');
const arquivoDeAjustes = (casa: string): string => path.join(casa, '.gemini', 'antigravity-cli', 'settings.json');

function gravarSeMudou(arquivo: string, conteudo: string, modo: number): void {
  let atual: string | null = null;
  try {
    atual = readFileSync(arquivo, 'utf8');
  } catch {
    // Ainda não existe.
  }
  if (atual !== conteudo) writeFileSync(arquivo, conteudo, { mode: modo });
}

/**
 * Repõe a configuração pessoal do Antigravity e confere o que o servidor não repõe. Devolve o
 * motivo, em português, quando o turno não pode começar; `null` quando está tudo no lugar.
 *
 * `comChave` diz se o acesso é pela chave de API do Gemini, que o servidor recebe pelo ambiente:
 * com ela, o Antigravity fala direto com a API e não abre sessão de conta.
 */
export function prepararConfiguracaoDoAntigravity(opcoes: { casa: string; comandoDoGancho: string; comChave: boolean }): string | null {
  const configuracao = pastaDeConfiguracao(opcoes.casa);
  try {
    mkdirSync(configuracao, { recursive: true, mode: 0o700 });
    gravarSeMudou(path.join(configuracao, 'hooks.json'), ganchosDoAntigravity(opcoes.comandoDoGancho), 0o600);
    // Nenhum servidor MCP: cada um é um comando que o Antigravity lança sozinho.
    gravarSeMudou(path.join(configuracao, 'mcp_config.json'), '', 0o600);
    // Plugin instalado traz ganchos e servidores MCP próprios, e o servidor não instala nenhum.
    if (existsSync(path.join(configuracao, 'plugins.json'))) return 'há uma lista de plugins na configuração do Antigravity';
    const plugins = path.join(configuracao, 'plugins');
    if (existsSync(plugins) && readdirSync(plugins).length > 0) return 'há um plugin instalado na configuração do Antigravity';

    const ajustes = arquivoDeAjustes(opcoes.casa);
    mkdirSync(path.dirname(ajustes), { recursive: true, mode: 0o700 });
    let atuais: Record<string, unknown> = {};
    try {
      const lido: unknown = JSON.parse(readFileSync(ajustes, 'utf8'));
      if (typeof lido === 'object' && lido !== null && !Array.isArray(lido)) atuais = lido as Record<string, unknown>;
    } catch {
      // Sem arquivo, ou ilegível: começa do zero.
    }
    for (const chave of AJUSTES_PROIBIDOS) delete atuais[chave];
    if (opcoes.comChave) atuais.modelProvider = 'gemini';
    else delete atuais.modelProvider;
    gravarSeMudou(ajustes, `${JSON.stringify({ ...atuais, ...AJUSTES_FIXOS }, null, 2)}\n`, 0o600);
    return null;
  } catch (erro) {
    return `não deu para repor a configuração do Antigravity (${erro instanceof Error ? erro.message : 'erro desconhecido'})`;
  }
}

/** Os nomes que o Antigravity reconhece como pasta de configuração dentro de uma pasta de trabalho. */
export const PASTAS_DE_CONFIGURACAO_DO_ANTIGRAVITY = ['.agents', '.agent', '_agents', '_agent'] as const;

/**
 * Prepara a pasta em que a sessão abre: vazia e fora de qualquer repositório Git. O Antigravity
 * lê `.agents/` da pasta da sessão e de cada pasta acima dela até a raiz do repositório; fora de
 * um repositório, só a da sessão. Devolve o motivo quando o turno não pode começar.
 *
 * A pasta é do servidor, e nada do bot mora nela. O que aparecer ali foi deixado por um comando
 * aprovado e é apagado antes do turno, que é quando passaria a valer como configuração. Só apaga
 * dentro de `base`, a pasta das sessões, e nunca a própria `base`.
 */
export function prepararPastaDaSessao(pasta: string, base: string = path.dirname(pasta)): string | null {
  try {
    const dentro = path.relative(path.resolve(base), path.resolve(pasta));
    if (dentro === '' || dentro.startsWith('..') || path.isAbsolute(dentro)) return 'a pasta da sessão do Antigravity está fora do lugar';
    mkdirSync(pasta, { recursive: true, mode: 0o700 });
    const sobras = readdirSync(pasta);
    for (const sobra of sobras) rmSync(path.join(pasta, sobra), { recursive: true, force: true });
    if (sobras.length > 0) console.error(`motor antigravity: ${sobras.length} item(ns) apagado(s) da pasta da sessão antes do turno`);
    if (readdirSync(pasta).length > 0) return 'a pasta da sessão do Antigravity não está vazia';
    for (let atual = path.resolve(pasta); ; atual = path.dirname(atual)) {
      if (existsSync(path.join(atual, '.git'))) return 'a pasta da sessão do Antigravity está dentro de um repositório Git';
      if (path.dirname(atual) === atual) break;
    }
    return null;
  } catch (erro) {
    return `não deu para preparar a pasta da sessão do Antigravity (${erro instanceof Error ? erro.message : 'erro desconhecido'})`;
  }
}
