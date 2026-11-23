/** Um evento de `text/event-stream` já montado. */
export interface EventoSse {
  /** Último `id:` visto no fluxo até este evento, ou `null` se nenhum veio. */
  id: string | null;
  /** Valor de `event:`; `message` quando o servidor não manda o campo. */
  evento: string;
  /** Linhas de `data:` juntadas com `\n`. */
  dados: string;
}

export interface AnalisadorSse {
  /** Recebe um pedaço qualquer do texto do fluxo e devolve os eventos que ele completou. */
  alimentar(trecho: string): EventoSse[];
}

/**
 * Analisador de Server-Sent Events. Guarda o que ficou pela metade entre um pedaço e outro,
 * então o corte pode cair em qualquer lugar: no meio de uma linha, de um campo ou de um `\r\n`.
 */
export function criarAnalisadorSse(): AnalisadorSse {
  let resto = '';
  let noInicio = true;
  /** A linha anterior terminou em `\r` no fim do pedaço: um `\n` logo a seguir é do mesmo fim de linha. */
  let pularLf = false;
  let dados: string[] = [];
  let tipo = '';
  let ultimoId: string | null = null;

  function linha(texto: string, saida: EventoSse[]): void {
    if (texto === '') {
      if (dados.length > 0) saida.push({ id: ultimoId, evento: tipo === '' ? 'message' : tipo, dados: dados.join('\n') });
      dados = [];
      tipo = '';
      return;
    }
    if (texto.startsWith(':')) return;
    const doisPontos = texto.indexOf(':');
    const campo = doisPontos === -1 ? texto : texto.slice(0, doisPontos);
    let valor = doisPontos === -1 ? '' : texto.slice(doisPontos + 1);
    if (valor.startsWith(' ')) valor = valor.slice(1);
    if (campo === 'data') dados.push(valor);
    else if (campo === 'event') tipo = valor;
    else if (campo === 'id' && !valor.includes('\0')) ultimoId = valor;
  }

  return {
    alimentar(trecho) {
      const saida: EventoSse[] = [];
      let texto = trecho;
      if (texto === '') return saida;
      if (noInicio) {
        noInicio = false;
        if (texto.charCodeAt(0) === 0xfeff) texto = texto.slice(1);
      }
      let inicio = 0;
      if (pularLf) {
        pularLf = false;
        if (texto.charCodeAt(0) === 10) inicio = 1;
      }
      for (let i = inicio; i < texto.length; i += 1) {
        const codigo = texto.charCodeAt(i);
        if (codigo !== 10 && codigo !== 13) continue;
        linha(resto + texto.slice(inicio, i), saida);
        resto = '';
        if (codigo === 13) {
          if (i + 1 === texto.length) pularLf = true;
          else if (texto.charCodeAt(i + 1) === 10) i += 1;
        }
        inicio = i + 1;
      }
      resto += texto.slice(inicio);
      return saida;
    },
  };
}
