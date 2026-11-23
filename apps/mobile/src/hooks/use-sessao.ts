import { useSyncExternalStore } from 'react';

import type { EstadoSessao } from '@/lib/sessao';
import { guardaSessao } from '@/servicos';

/** Sessão do app: carregando, pareado ou não, e se o servidor acabou de recusar o token. */
export function useSessao(): EstadoSessao {
  return useSyncExternalStore(guardaSessao.assinar, guardaSessao.estado);
}
