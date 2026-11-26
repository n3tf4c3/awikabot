import { readFileSync } from 'node:fs';

/**
 * A configuração com que o Codex roda como motor de um bot. Cada valor fecha um caminho que a
 * prova da etapa 7 achou aberto sem cartão:
 *
 * - `approval_policy` e `sandbox_mode`: a caixa de areia só de leitura com aprovação `on-request`.
 *   No contêiner a caixa de areia não sobe, e todo comando e toda edição viram pedido de aprovação;
 * - `web_search`: sem isto o bot pesquisa na web sem pedir;
 * - os recursos desligados: os conectores da conta (`apps`), plugins e ganchos do usuário, o
 *   navegador e o uso do computador, a geração e a leitura de imagens, os subagentes e as
 *   sugestões e instalações de ferramentas. Todos agem sem passar pelo pedido de aprovação.
 *
 * O que escapar disto, o driver corta (ver `motor-codex.ts`).
 */
export const CONFIGURACAO_DO_CODEX = {
  approval_policy: 'on-request',
  sandbox_mode: 'read-only',
  web_search: 'disabled',
  check_for_update_on_startup: false,
  features: {
    apps: false,
    browser_use: false,
    browser_use_external: false,
    computer_use: false,
    hooks: false,
    image_generation: false,
    in_app_browser: false,
    multi_agent: false,
    plugins: false,
    remote_plugin: false,
    skill_mcp_dependency_install: false,
    tool_suggest: false,
    view_image: false,
  },
  // No 0.172.0, `features.multi_agent` está obsoleto e só controla o caminho antigo; é esta chave
  // que tira as ferramentas de subagente, segundo o aviso do próprio Codex.
  agents: {
    enabled: false,
  },
} as const;

/**
 * O que nem a configuração do usuário nem um turno conseguem afrouxar: quem decide os pedidos é
 * a pessoa (`user`, nunca o revisor automático do Codex), e só valem os ganchos gerenciados, que
 * aqui não existem. Os nomes foram conferidos no 0.172.0 com `codex app-server --print-startup-config`.
 */
export const REQUISITOS_DO_CODEX = {
  allowed_approval_policies: ['on-request'],
  allowed_sandbox_modes: ['read-only'],
  allowed_web_search_modes: ['disabled'],
  allowed_approvals_reviewers: ['user'],
  allow_remote_control: false,
  allow_browser_and_computer_use: false,
  allow_managed_hooks_only: true,
} as const;

/** Onde o Codex, no Linux, lê a configuração gerenciada e os requisitos. */
export const CAMINHO_DA_CONFIGURACAO_DO_CODEX = '/etc/codex/managed_config.toml';
export const CAMINHO_DOS_REQUISITOS_DO_CODEX = '/etc/codex/requirements.toml';

type ValorToml = string | boolean | readonly string[];

function valorToml(valor: ValorToml): string {
  if (typeof valor === 'boolean') return String(valor);
  if (typeof valor === 'string') return JSON.stringify(valor);
  return `[${valor.map((item) => JSON.stringify(item)).join(', ')}]`;
}

/** TOML de chaves simples e uma tabela por nível, que é tudo o que estes arquivos têm. */
function paraToml(objeto: Record<string, ValorToml | Record<string, ValorToml>>): string {
  const linhas = ['# Gerado pelo servidor do awikabot. Não editar à mão.'];
  const tabelas: string[] = [];
  for (const [chave, valor] of Object.entries(objeto)) {
    if (typeof valor === 'object' && !Array.isArray(valor)) {
      tabelas.push('', `[${chave}]`, ...Object.entries(valor).map(([nome, item]) => `${nome} = ${valorToml(item)}`));
    } else {
      linhas.push(`${chave} = ${valorToml(valor as ValorToml)}`);
    }
  }
  return `${[...linhas, ...tabelas].join('\n')}\n`;
}

export function configuracaoDoCodexToml(): string {
  return paraToml(CONFIGURACAO_DO_CODEX);
}

export function requisitosDoCodexToml(): string {
  return paraToml(REQUISITOS_DO_CODEX);
}

/**
 * A mesma configuração em opções `--config=chave=valor`, para o servidor fora da imagem. Na
 * imagem, ela mora em `/etc/codex`, fora do volume, onde nenhum comando aprovado a altera.
 */
export function configuracaoDoCodexPorOpcao(): string[] {
  const opcoes: string[] = [];
  for (const [chave, valor] of Object.entries(CONFIGURACAO_DO_CODEX)) {
    if (typeof valor === 'object') {
      for (const [nome, item] of Object.entries(valor)) opcoes.push(`--config=${chave}.${nome}=${valorToml(item)}`);
    } else {
      opcoes.push(`--config=${chave}=${valorToml(valor)}`);
    }
  }
  return opcoes;
}

/** Os dois arquivos de `/etc/codex` existem e são exatamente os que este servidor gera? */
export function codexGerenciadoInstalado(
  caminhos: { configuracao: string; requisitos: string } = {
    configuracao: CAMINHO_DA_CONFIGURACAO_DO_CODEX,
    requisitos: CAMINHO_DOS_REQUISITOS_DO_CODEX,
  },
): boolean {
  try {
    return (
      readFileSync(caminhos.configuracao, 'utf8') === configuracaoDoCodexToml() &&
      readFileSync(caminhos.requisitos, 'utf8') === requisitosDoCodexToml()
    );
  } catch {
    return false;
  }
}
