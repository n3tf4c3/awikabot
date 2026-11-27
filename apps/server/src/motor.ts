/** O que o servidor entrega a um motor para rodar um turno. */
export interface PedidoMotor {
  /** O motor gravado no bot, que escolhe o driver. */
  motor: string;
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
  /**
   * Turno de decisão (o juiz): sem ferramentas, e a resposta final presa a este esquema (JSON
   * Schema). O driver a devolve crua em `estruturada`; quem confere contra o esquema é quem perguntou.
   */
  saida?: { esquema: Record<string, unknown> };
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
  /** Num turno de decisão, a resposta final como o motor a entregou: objeto, texto ou nada. */
  estruturada?: unknown;
}

export interface TurnoEmCurso {
  parar: () => void;
  /** Sempre resolve, nunca rejeita. */
  fim: Promise<ResultadoMotor>;
}

export type Motor = (pedido: PedidoMotor) => TurnoEmCurso;

/**
 * Um motor que entrega cada turno ao driver do motor do bot. Um bot cujo motor este servidor não
 * sabe rodar recebe uma resposta que diz isso, marcada como falha; nada roda.
 */
export function despacharPorMotor(motores: Readonly<Record<string, Motor>>): Motor {
  return (pedido) => {
    const motor = Object.hasOwn(motores, pedido.motor) ? motores[pedido.motor] : undefined;
    if (motor) return motor(pedido);
    const texto = `Este servidor não roda o motor "${pedido.motor}".`;
    pedido.aoTexto(texto);
    return { parar: () => {}, fim: Promise.resolve({ estado: 'falhou', texto, sessao: pedido.sessao }) };
  };
}
