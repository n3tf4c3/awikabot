/** O que o servidor entrega a um motor para rodar um turno. */
export interface PedidoMotor {
  /** Pasta de trabalho do bot. */
  pasta: string;
  texto: string;
  instrucoes: string;
  modelo: string | null;
  /** Esforço do motor; `null` é o padrão dele. */
  esforco: string | null;
  /** Sessão do motor a retomar, para o bot lembrar da conversa. */
  sessao: string | null;
  /**
   * Como o motor pergunta ao servidor se pode usar uma ferramenta. Com `null`, o motor
   * nega tudo o que pediria aprovação.
   */
  gancho: Gancho | null;
  aoTexto: (trecho: string) => void;
}

export interface Gancho {
  /** Linha de comando que o motor executa antes de cada ferramenta. */
  comando: string;
  /** Porta, em loopback, onde o servidor atende o gancho. */
  porta: number;
  /** Identifica o turno. Dá direito a pedir aprovação, não a aprovar. */
  token: string;
}

export interface ResultadoMotor {
  estado: 'completa' | 'parada' | 'falhou';
  texto: string;
  sessao: string | null;
}

export interface TurnoEmCurso {
  parar: () => void;
  /** Sempre resolve, nunca rejeita. */
  fim: Promise<ResultadoMotor>;
}

export type Motor = (pedido: PedidoMotor) => TurnoEmCurso;
