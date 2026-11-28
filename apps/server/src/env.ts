import path from 'node:path';
import { z } from 'zod';
import { motorDoCatalogo } from './catalogo';

function avisoPushValido(valor: string): boolean {
  if (valor === 'expo' || valor === 'desligado') return true;
  try {
    const endereco = new URL(valor);
    if (endereco.username !== '' || endereco.password !== '') return false;
    if (endereco.protocol === 'https:') return true;
    return endereco.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endereco.hostname);
  } catch {
    return false;
  }
}

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
    /**
     * `claude-code`: cada bot roda no motor gravado nele. `simulado`: todos rodam no motor de teste.
     * O nome do valor padrão é de antes do motor por bot, e fica para não mudar a configuração de quem já roda.
     */
    AWIKA_MOTOR: z.enum(['claude-code', 'simulado']).default('claude-code'),
    AWIKA_CLAUDE_BIN: z.string().min(1).default('claude'),
    AWIKA_CODEX_BIN: z.string().min(1).default('codex'),
    AWIKA_AGY_BIN: z.string().min(1).default('agy'),
    /**
     * Motores do catálogo ainda não prontos em que este servidor aceita criar bot, separados por
     * vírgula. Serve ao runbook de um motor novo; o catálogo continua dizendo que ele não está pronto.
     */
    AWIKA_MOTORES_EM_PROVA: z
      .string()
      .default('')
      .transform((lista) => lista.split(',').map((nome) => nome.trim()).filter((nome) => nome !== ''))
      .pipe(z.array(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/))),
    AWIKA_TURNOS_SIMULTANEOS: z.coerce.number().int().min(1).max(16).default(4),
    /**
     * Por onde o gancho de aprovação e a configuração entram no motor. `gerenciado`: pela
     * configuração gerenciada do Claude Code e do Codex, que a imagem instala e o bot não alcança.
     * `opcao`: pela linha de comando.
     */
    AWIKA_GANCHO: z.enum(['opcao', 'gerenciado']).default('opcao'),
    /**
     * Para onde vão os avisos push de pedido de aprovação. `expo`: o serviço de push da Expo, que os
     * entrega à Apple e ao Google. `desligado`: nenhum aviso sai do servidor. Um endereço serve a um
     * serviço de mentira, como o do `pnpm verificar`: só `https://`, ou `http://` em loopback.
     */
    AWIKA_AVISO_PUSH: z.string().default('expo').refine(avisoPushValido),
  })
  // O motor simulado só existe para teste; em produção ele derruba a partida.
  .refine((env) => !(env.NODE_ENV === 'production' && env.AWIKA_MOTOR === 'simulado'), { path: ['AWIKA_MOTOR'] })
  .refine((env) => env.AWIKA_PORTA !== env.AWIKA_PORTA_GANCHO, { path: ['AWIKA_PORTA_GANCHO'] })
  // Só um motor que o catálogo conhece pode estar em prova.
  .refine((env) => env.AWIKA_MOTORES_EM_PROVA.every((motor) => motorDoCatalogo(motor) !== null), { path: ['AWIKA_MOTORES_EM_PROVA'] });

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
 * do próprio motor (`ANTHROPIC_` e `CLAUDE_` para o Claude Code; `CODEX_` e `OPENAI_` para o
 * Codex; `GEMINI_`, `GOOGLE_` e `AGY_` para o Antigravity). Nada mais passa, para que um segredo posto no ambiente do servidor não chegue aos bots
 * sem alguém decidir isso aqui, nem o de um motor aos bots do outro.
 */
const NOMES_DO_MOTOR = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'TERM', 'TMPDIR', 'TEMP', 'TMP',
  'DISABLE_AUTOUPDATER', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  // Windows, para o servidor em desenvolvimento.
  'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH',
  'PROGRAMFILES', 'PROGRAMDATA',
]);
const PREFIXOS_DE_CADA_MOTOR = {
  'claude-code': ['ANTHROPIC_', 'CLAUDE_'],
  codex: ['CODEX_', 'OPENAI_'],
  antigravity: ['GEMINI_', 'GOOGLE_', 'AGY_'],
} as const;
const PREFIXOS_DE_TODOS = ['LC_'];

export type MotorReal = keyof typeof PREFIXOS_DE_CADA_MOTOR;

export function ambienteDoMotor(origem: Record<string, string | undefined>, motor: MotorReal = 'claude-code'): Record<string, string> {
  const prefixos = [...PREFIXOS_DE_TODOS, ...PREFIXOS_DE_CADA_MOTOR[motor]];
  const saida: Record<string, string> = {};
  for (const [nome, valor] of Object.entries(origem)) {
    if (valor === undefined) continue;
    const maiusculo = nome.toUpperCase();
    if (NOMES_DO_MOTOR.has(maiusculo) || prefixos.some((prefixo) => maiusculo.startsWith(prefixo))) saida[nome] = valor;
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

/**
 * A pasta de trabalho do bot, que o driver do Antigravity entrega ao gancho dele pelo ambiente do
 * motor. Só vale um caminho completo; com qualquer outra coisa devolve `null`, e o gancho não mexe
 * na linha do comando.
 */
export function lerPastaDoBot(origem: Record<string, string | undefined>): string | null {
  const pasta = origem.AWIKA_PASTA_DO_BOT;
  return typeof pasta === 'string' && pasta !== '' && path.isAbsolute(pasta) ? pasta : null;
}

export function lerEnv(origem: Record<string, string | undefined>): Env {
  const resultado = EsquemaEnv.safeParse(origem);
  if (!resultado.success) {
    const campos = [...new Set(resultado.error.issues.map((problema) => String(problema.path[0] ?? '?')))];
    throw new EnvInvalida(campos);
  }
  return resultado.data;
}
