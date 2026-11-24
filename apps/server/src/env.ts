import { z } from 'zod';

const EsquemaEnv = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    // Padrão em loopback: só a imagem do contêiner abre para a rede dele.
    AWIKA_HOST: z.string().min(1).default('127.0.0.1'),
    AWIKA_PORTA: z.coerce.number().int().min(1).max(65535).default(8790),
    // Onde o gancho do motor pergunta se pode usar uma ferramenta. Sempre em loopback; nunca publicar.
    AWIKA_PORTA_GANCHO: z.coerce.number().int().min(1).max(65535).default(8791),
    /** Pasta do banco e das pastas de trabalho dos bots. */
    AWIKA_DADOS: z.string().min(1).default('./dados'),
    AWIKA_MOTOR: z.enum(['claude-code', 'simulado']).default('claude-code'),
    AWIKA_CLAUDE_BIN: z.string().min(1).default('claude'),
    AWIKA_TURNOS_SIMULTANEOS: z.coerce.number().int().min(1).max(16).default(4),
    /**
     * Por onde o gancho de aprovação entra no motor. `gerenciado`: pela configuração gerenciada
     * do Claude Code, que a imagem instala e o bot não alcança. `opcao`: pela linha de comando.
     */
    AWIKA_GANCHO: z.enum(['opcao', 'gerenciado']).default('opcao'),
  })
  // O motor simulado só existe para teste; em produção ele derruba a partida.
  .refine((env) => !(env.NODE_ENV === 'production' && env.AWIKA_MOTOR === 'simulado'), { path: ['AWIKA_MOTOR'] })
  .refine((env) => env.AWIKA_PORTA !== env.AWIKA_PORTA_GANCHO, { path: ['AWIKA_PORTA_GANCHO'] });

export type Env = z.infer<typeof EsquemaEnv>;

/** Leva só os nomes das variáveis recusadas, nunca os valores. */
export class EnvInvalida extends Error {
  readonly campos: string[];

  constructor(campos: string[]) {
    super(`Variáveis de ambiente inválidas: ${campos.join(', ')}`);
    this.name = 'EnvInvalida';
    this.campos = campos;
  }
}

/**
 * O que o motor precisa herdar do servidor para rodar: sistema, idioma, proxy e as variáveis
 * do próprio Claude Code. Nada mais passa, para que um segredo posto no ambiente do servidor
 * não chegue aos bots sem alguém decidir isso aqui.
 */
const NOMES_DO_MOTOR = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'TERM', 'TMPDIR', 'TEMP', 'TMP',
  'DISABLE_AUTOUPDATER', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  // Windows, para o servidor em desenvolvimento.
  'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH',
  'PROGRAMFILES', 'PROGRAMDATA',
]);
const PREFIXOS_DO_MOTOR = ['ANTHROPIC_', 'CLAUDE_', 'LC_'];

export function ambienteDoMotor(origem: Record<string, string | undefined>): Record<string, string> {
  const saida: Record<string, string> = {};
  for (const [nome, valor] of Object.entries(origem)) {
    if (valor === undefined) continue;
    const maiusculo = nome.toUpperCase();
    if (NOMES_DO_MOTOR.has(maiusculo) || PREFIXOS_DO_MOTOR.some((prefixo) => maiusculo.startsWith(prefixo))) saida[nome] = valor;
  }
  return saida;
}

const EsquemaEnvDoGancho = z.object({
  AWIKA_PORTA_GANCHO: z.coerce.number().int().min(1).max(65535),
  AWIKA_TURNO_TOKEN: z.string().min(1),
});

/**
 * O que o gancho recebe do servidor, pelo ambiente do motor: a porta em loopback e o token do
 * turno. Com qualquer coisa fora do lugar devolve `null`, e o gancho nega.
 */
export function lerEnvDoGancho(origem: Record<string, string | undefined>): { porta: number; token: string } | null {
  const lido = EsquemaEnvDoGancho.safeParse(origem);
  return lido.success ? { porta: lido.data.AWIKA_PORTA_GANCHO, token: lido.data.AWIKA_TURNO_TOKEN } : null;
}

export function lerEnv(origem: Record<string, string | undefined>): Env {
  const resultado = EsquemaEnv.safeParse(origem);
  if (!resultado.success) {
    const campos = [...new Set(resultado.error.issues.map((problema) => String(problema.path[0] ?? '?')))];
    throw new EnvInvalida(campos);
  }
  return resultado.data;
}
