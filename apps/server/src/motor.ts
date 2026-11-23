/** O que o servidor entrega a um motor para rodar um turno. */
export interface PedidoMotor {
  /** Pasta de trabalho do bot. */
  pasta: string;
  texto: string;
  instrucoes: string;
  modelo: string | null;
  /** Sessão do motor a retomar, para o bot lembrar da conversa. */
  sessao: string | null;
  aoTexto: (trecho: string) => void;
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
