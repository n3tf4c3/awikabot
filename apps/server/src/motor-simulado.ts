import type { Motor, ResultadoMotor } from './motor';

/** Motor de teste: devolve o texto recebido, palavra por palavra. Não fala com modelo nenhum. */
export function criarMotorSimulado(opcoes: { atrasoMs?: number } = {}): Motor {
  const atrasoMs = opcoes.atrasoMs ?? 15;

  return (pedido) => {
    const partes = `Você disse: ${pedido.texto}`.match(/\S+\s*/g) ?? [];
    let texto = '';
    let terminado = false;
    let relogio: NodeJS.Timeout | undefined;
    let resolver: (resultado: ResultadoMotor) => void = () => {};
    const fim = new Promise<ResultadoMotor>((ok) => {
      resolver = ok;
    });

    const terminar = (estado: ResultadoMotor['estado']): void => {
      if (terminado) return;
      terminado = true;
      clearTimeout(relogio);
      resolver({ estado, texto, sessao: pedido.sessao ?? 'sessao-simulada' });
    };

    const passo = (indice: number): void => {
      const parte = partes[indice];
      if (parte === undefined) {
        terminar('completa');
        return;
      }
      texto += parte;
      pedido.aoTexto(parte);
      relogio = setTimeout(() => passo(indice + 1), atrasoMs);
    };
    relogio = setTimeout(() => passo(0), atrasoMs);

    return { fim, parar: () => terminar('parada') };
  };
}
