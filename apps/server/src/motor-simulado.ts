import type { RespostaDoGancho } from './gancho';
import type { Gancho, Motor, ResultadoMotor } from './motor';

/** Pergunta ao servidor pelo mesmo caminho que o gancho do motor real usa. */
async function consultarGancho(gancho: Gancho, ferramenta: string, entrada: Record<string, unknown>): Promise<RespostaDoGancho> {
  try {
    const resposta = await fetch(`http://127.0.0.1:${gancho.porta}/gancho`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-awika-turno': gancho.token },
      body: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: ferramenta, tool_input: entrada }),
    });
    return (await resposta.json()) as RespostaDoGancho;
  } catch {
    return { decisao: 'deny', motivo: 'servidor de aprovação fora do ar' };
  }
}

/**
 * Motor de teste: devolve o texto recebido, palavra por palavra. Não fala com modelo nenhum.
 * Dois textos fazem o papel de um pedido de ferramenta, sem executar nada:
 * `!comando <linha>` pede para rodar um comando e `!ler <caminho>` pede para ler um arquivo.
 */
export function criarMotorSimulado(opcoes: { atrasoMs?: number } = {}): Motor {
  const atrasoMs = opcoes.atrasoMs ?? 15;

  return (pedido) => {
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

    const falar = (fala: string): void => {
      const partes = fala.match(/\S+\s*/g) ?? [];
      const passo = (indice: number): void => {
        if (terminado) return;
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
    };

    const ferramenta = /^!(comando|ler) (.+)$/s.exec(pedido.texto);
    if (ferramenta) {
      const [, tipo = '', alvo = ''] = ferramenta;
      const consulta =
        pedido.gancho === null
          ? Promise.resolve<RespostaDoGancho>({ decisao: 'deny', motivo: 'sem gancho' })
          : tipo === 'comando'
            ? consultarGancho(pedido.gancho, 'Bash', { command: alvo })
            : consultarGancho(pedido.gancho, 'Read', { file_path: alvo });
      const [permitido, negado] = tipo === 'comando' ? ['Comando permitido', 'Comando negado'] : ['Leitura permitida', 'Leitura negada'];
      void consulta.then((resposta) => {
        falar(resposta.decisao === 'allow' ? `${permitido}: ${alvo}` : `${negado}: ${resposta.motivo}`);
      });
    } else {
      falar(`Você disse: ${pedido.texto}`);
    }

    return { fim, parar: () => terminar('parada') };
  };
}
