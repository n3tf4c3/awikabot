import { z } from 'zod';

/** Versão do contrato entre servidor e app. Sobe quando uma mudança quebra clientes antigos. */
export const VERSAO_PROTOCOLO = 1;

/** Resposta de `GET /healthz`. */
export const EsquemaSaude = z.object({
  status: z.literal('ok'),
  versao: z.string().min(1).max(64),
  protocolo: z.number().int().positive(),
});

export type Saude = z.infer<typeof EsquemaSaude>;
