import { useEffect, useState } from 'react';
import type { Catalogo } from '@awikabot/core';

import { api } from '@/servicos';

/**
 * O catálogo do servidor, buscado ao abrir o formulário. `null` enquanto não chega, e também
 * quando não vem: um servidor anterior à rota responde 404, e o formulário segue com o "Auto",
 * o "Outro" e o motor padrão.
 */
export function useCatalogo(): Catalogo | null {
  const [catalogo, definirCatalogo] = useState<Catalogo | null>(null);

  useEffect(() => {
    let aberto = true;
    api.catalogo().then(
      (lido) => {
        if (aberto) definirCatalogo(lido);
      },
      () => {
        // Sem catálogo o formulário funciona; a falha de rede aparece, se houver, ao salvar.
      },
    );
    return () => {
      aberto = false;
    };
  }, []);

  return catalogo;
}
