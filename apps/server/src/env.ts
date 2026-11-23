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

export function lerEnv(origem: Record<string, string | undefined>): Env {
  const resultado = EsquemaEnv.safeParse(origem);
  if (!resultado.success) {
    const campos = [...new Set(resultado.error.issues.map((problema) => String(problema.path[0] ?? '?')))];
    throw new EnvInvalida(campos);
  }
  return resultado.data;
}
