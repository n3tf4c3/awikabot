import { useEffect, useState } from 'react';
import type { Bot } from '@awikabot/core';

import { mensagemDeErro } from '@/lib/erros';
import { useDados, useSelecao } from '@/provedores/dados';

interface ListaBots {
  /** `null` enquanto a primeira lista não chega. */
  bots: readonly Bot[] | null;
  erro: string | null;
  /** A pessoa puxou a lista para atualizar e o pedido ainda corre. */
  atualizando: boolean;
  atualizar(): void;
}

/** Lista de bots do servidor: busca ao abrir, de novo a pedido, e segue os eventos no meio. */
export function useListaBots(): ListaBots {
  const { operacoes } = useDados();
  const bots = useSelecao((estado) => estado.bots);
  const [erro, definirErro] = useState<string | null>(null);
  const [atualizando, definirAtualizando] = useState(false);

  useEffect(() => {
    operacoes.carregarBots().then(
      () => definirErro(null),
      (falha: unknown) => definirErro(mensagemDeErro(falha)),
    );
  }, [operacoes]);

  function atualizar(): void {
    definirAtualizando(true);
    operacoes
      .carregarBots()
      .then(
        () => definirErro(null),
        (falha: unknown) => definirErro(mensagemDeErro(falha)),
      )
      .finally(() => definirAtualizando(false));
  }

  return { bots, erro, atualizando, atualizar };
}

/** Um bot da lista, ou `null` se ele não está nela (lista ainda não carregada ou bot inexistente). */
export function useBot(id: string): Bot | null {
  return useSelecao((estado) => estado.bots?.find((bot) => bot.id === id) ?? null);
}
