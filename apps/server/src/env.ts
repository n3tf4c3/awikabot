import { z } from 'zod';

const EsquemaEnv = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Padrão em loopback: só a imagem do contêiner abre para a rede dele.
  AWIKA_HOST: z.string().min(1).default('127.0.0.1'),
  AWIKA_PORTA: z.coerce.number().int().min(1).max(65535).default(8790),
});

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
