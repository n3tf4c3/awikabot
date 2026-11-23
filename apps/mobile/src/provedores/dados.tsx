import { fetch } from 'expo/fetch';
import { createContext, use, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { criarArmazemDados, type ArmazemDados, type EstadoDados } from '@/lib/dados';
import { iniciarFluxoEventos } from '@/lib/fluxo-eventos';
import { criarOperacoes, type Operacoes } from '@/lib/operacoes';
import type { Sessao } from '@/lib/sessao';
import { api, guardaSessao } from '@/servicos';

/** Os dados de uma sessão. Trocou a sessão, nasce outro armazém: nada de um servidor vaza para o outro. */
interface DadosDaSessao {
  sessao: Sessao | null;
  armazem: ArmazemDados;
  operacoes: Operacoes;
}

function criarDados(sessao: Sessao | null): DadosDaSessao {
  const armazem = criarArmazemDados();
  return { sessao, armazem, operacoes: criarOperacoes(api, armazem) };
}

const Contexto = createContext<DadosDaSessao | null>(null);

/**
 * Guarda os dados do servidor em memória e mantém a única conexão do app com o fluxo de eventos.
 * A conexão abre com a sessão, fecha enquanto o app está em segundo plano e acaba quando a sessão
 * acaba (desparear, token recusado) ou o app desmonta.
 */
export function ProvedorDados({ sessao, children }: { sessao: Sessao | null; children: ReactNode }) {
  const [dados, definirDados] = useState(() => criarDados(sessao));
  if (dados.sessao !== sessao) definirDados(criarDados(sessao));

  useEffect(() => {
    const { armazem, operacoes } = dados;
    const daSessao = dados.sessao;
    if (daSessao === null) return;
    const fluxo = iniciarFluxoEventos({
      buscar: fetch,
      url: `${daSessao.servidor}/v1/eventos`,
      token: daSessao.token,
      aoEvento: (evento) => {
        armazem.despachar({ tipo: 'evento', evento });
        // As conversas abertas se atualizam sozinhas ao ver a marca; a lista de bots e os pedidos
        // de aprovação pendentes são buscados aqui.
        if (evento.tipo === 'ressincronizar') {
          operacoes.carregarBots().catch(() => {});
          operacoes.carregarAprovacoes().catch(() => {});
        }
      },
      aoNaoAutenticado: () => {
        void guardaSessao.sairSeAtual(daSessao);
      },
      aoMudarConexao: (conexao) => armazem.despachar({ tipo: 'conexao', conexao }),
    });
    // Primeira carga dos pedidos pendentes, sem depender de o fluxo conseguir abrir: um bot pode
    // estar parado à espera de aprovação desde antes de o app abrir.
    operacoes.carregarAprovacoes().catch(() => {});
    // Em segundo plano o sistema suspende o app e a conexão morre calada. O fluxo fecha ao sair
    // e, na volta, reconecta do ponto em que parou; `inactive` é passagem e não mexe em nada.
    if (AppState.currentState === 'background') fluxo.pausar();
    const estadoDoApp = AppState.addEventListener('change', (estado) => {
      if (estado === 'background') fluxo.pausar();
      else if (estado === 'active') fluxo.retomar();
    });
    return () => {
      estadoDoApp.remove();
      fluxo.parar();
    };
  }, [dados]);

  return <Contexto value={dados}>{children}</Contexto>;
}

export function useDados(): DadosDaSessao {
  const dados = use(Contexto);
  if (dados === null) throw new Error('useDados fora do ProvedorDados');
  return dados;
}

/** Lê uma parte do armazém. `selecionar` tem de devolver a mesma referência enquanto a parte não muda. */
export function useSelecao<T>(selecionar: (estado: EstadoDados) => T): T {
  const { armazem } = useDados();
  return useSyncExternalStore(armazem.assinar, () => selecionar(armazem.estado()));
}
