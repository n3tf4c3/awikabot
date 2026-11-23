import type { Evento, ListaMensagens, Mensagem, RespostaTurno } from '@awikabot/core';

/** Trecho de um evento `texto`: `posicao` é o tamanho que a resposta tinha antes dele. */
interface Trecho {
  readonly posicao: number;
  readonly trecho: string;
}

/** Texto de uma resposta em andamento, montado com o que foi buscado e com os eventos `texto`. */
export interface TextoAoVivo {
  /** Sem buracos, do começo da resposta até onde o app tem. */
  readonly texto: string;
  /**
   * Trechos que chegaram com um buraco antes deles. Ficam à espera da busca que traz o que falta:
   * sem guardá-los, o que chega enquanto a busca corre viraria outro buraco logo depois dela.
   */
  readonly adiantados: readonly Trecho[];
}

export interface EstadoConversa {
  /** Em ordem crescente de `seq`, sem repetição. */
  readonly mensagens: readonly Mensagem[];
  /** Há mensagens mais antigas no servidor do que a primeira desta lista. */
  readonly temMais: boolean;
  /** Por id da mensagem do bot. */
  readonly aoVivo: Readonly<Record<string, TextoAoVivo>>;
  /** A página mais recente já foi buscada ao menos uma vez. */
  readonly carregada: boolean;
  /** O app pode ter perdido mensagens ou texto e precisa buscar a página mais recente de novo. */
  readonly desatualizada: boolean;
  /**
   * Quantas vezes a conversa soube que perdeu algo. Quem busca a página compara antes e depois:
   * se subiu no meio do pedido, a página pode ser anterior à perda.
   */
  readonly perdas: number;
}

export const CONVERSA_VAZIA: EstadoConversa = {
  mensagens: [],
  temMais: false,
  aoVivo: {},
  carregada: false,
  desatualizada: false,
  perdas: 0,
};

/** Teto de trechos adiantados por resposta. Passou disso, os novos saem e a próxima busca resolve. */
const MAXIMO_DE_ADIANTADOS = 256;

function terminou(mensagem: Mensagem): boolean {
  return mensagem.estado !== 'em_andamento';
}

/**
 * Junta um trecho ao texto sem repetir nada. Devolve o mesmo texto se o trecho já estava nele,
 * e `null` se há um buraco entre o fim do texto e o começo do trecho.
 */
export function juntarTrecho(texto: string, posicao: number, trecho: string): string | null {
  if (posicao > texto.length) return null;
  if (posicao + trecho.length <= texto.length) return texto;
  return texto + trecho.slice(texto.length - posicao);
}

/** Aplica os trechos adiantados que o texto já alcança e devolve o que sobrou deles. */
function encaixar(texto: string, adiantados: readonly Trecho[]): TextoAoVivo {
  let junto = texto;
  const sobra: Trecho[] = [];
  for (const adiantado of [...adiantados].sort((a, b) => a.posicao - b.posicao)) {
    const novo = juntarTrecho(junto, adiantado.posicao, adiantado.trecho);
    if (novo === null) sobra.push(adiantado);
    else junto = novo;
  }
  return { texto: junto, adiantados: sobra };
}

/**
 * Entre a versão local e a recebida da mesma mensagem, a terminada vence: uma resposta HTTP
 * montada antes do fim do turno pode chegar depois do evento `turno_terminado`.
 */
function maisRecente(local: Mensagem | undefined, recebida: Mensagem): Mensagem {
  return local && terminou(local) && !terminou(recebida) ? local : recebida;
}

function inserir(mensagens: readonly Mensagem[], recebida: Mensagem): Mensagem[] {
  const copia = [...mensagens];
  const indice = copia.findIndex((mensagem) => mensagem.id === recebida.id);
  if (indice !== -1) {
    copia[indice] = maisRecente(copia[indice], recebida);
    return copia;
  }
  const posicao = copia.findIndex((mensagem) => mensagem.seq > recebida.seq);
  copia.splice(posicao === -1 ? copia.length : posicao, 0, recebida);
  return copia;
}

/**
 * Acerta o texto ao vivo com a lista que acabou de mudar: só fica o de mensagem que está na lista
 * e ainda não terminou, e ele parte do maior entre o que o app já tinha e o que veio na lista
 * (os dois são começos da mesma resposta). `comBusca` diz que a lista veio de uma busca: os
 * adiantados que nem ela alcança saem, e o próximo trecho abre um buraco novo e pede outra busca.
 */
function acertarAoVivo(
  aoVivo: Readonly<Record<string, TextoAoVivo>>,
  mensagens: readonly Mensagem[],
  comBusca: boolean,
): Readonly<Record<string, TextoAoVivo>> {
  const acertado: Record<string, TextoAoVivo> = {};
  let mudou = false;
  for (const mensagem of mensagens) {
    const vivo = aoVivo[mensagem.id];
    if (!vivo || terminou(mensagem)) continue;
    const base = mensagem.texto.length > vivo.texto.length ? mensagem.texto : vivo.texto;
    const encaixado = encaixar(base, vivo.adiantados);
    const sobra = comBusca ? [] : encaixado.adiantados;
    const igual = encaixado.texto === vivo.texto && sobra.length === vivo.adiantados.length;
    acertado[mensagem.id] = igual ? vivo : { texto: encaixado.texto, adiantados: sobra };
    if (!igual) mudou = true;
  }
  return !mudou && Object.keys(acertado).length === Object.keys(aoVivo).length ? aoVivo : acertado;
}

/**
 * Aplica a página mais recente (`GET mensagens` sem `antes`). A página manda no trecho que cobre;
 * as mais antigas já carregadas só ficam se a página emenda nelas, e as que chegaram por evento
 * depois da página ficam no fim.
 */
export function aplicarPaginaRecente(estado: EstadoConversa, pagina: ListaMensagens): EstadoConversa {
  const primeira = pagina.mensagens[0];
  const ultima = pagina.mensagens[pagina.mensagens.length - 1];
  let mensagens: readonly Mensagem[] = estado.mensagens;
  let temMais = false;
  if (primeira && ultima) {
    const locais = new Map(estado.mensagens.map((mensagem) => [mensagem.id, mensagem]));
    const anteriores = locais.has(primeira.id) ? estado.mensagens.filter((mensagem) => mensagem.seq < primeira.seq) : [];
    const posteriores = estado.mensagens.filter((mensagem) => mensagem.seq > ultima.seq);
    mensagens = [
      ...anteriores,
      ...pagina.mensagens.map((mensagem) => maisRecente(locais.get(mensagem.id), mensagem)),
      ...posteriores,
    ];
    temMais = anteriores.length > 0 ? estado.temMais : pagina.temMais;
  }
  return {
    ...estado,
    mensagens,
    temMais,
    aoVivo: acertarAoVivo(estado.aoVivo, mensagens, true),
    carregada: true,
    desatualizada: false,
  };
}

/**
 * Aplica uma página de mensagens anteriores a `antes`. Se a lista mudou de começo enquanto
 * o pedido corria, a página não emenda mais e é descartada.
 */
export function aplicarPaginaAnterior(estado: EstadoConversa, antes: number, pagina: ListaMensagens): EstadoConversa {
  if (estado.mensagens[0]?.seq !== antes) return estado;
  const conhecidas = new Set(estado.mensagens.map((mensagem) => mensagem.id));
  const novas = pagina.mensagens.filter((mensagem) => mensagem.seq < antes && !conhecidas.has(mensagem.id));
  return { ...estado, mensagens: [...novas, ...estado.mensagens], temMais: pagina.temMais };
}

/** Aplica a resposta de `POST turnos`: a mensagem da pessoa e a do bot, ainda em andamento. */
export function aplicarTurnoEnviado(estado: EstadoConversa, resposta: RespostaTurno): EstadoConversa {
  const mensagens = inserir(inserir(estado.mensagens, resposta.usuario), resposta.bot);
  return { ...estado, mensagens, aoVivo: acertarAoVivo(estado.aoVivo, mensagens, false) };
}

/** Aplica um trecho de texto à resposta em andamento, pela posição dele. */
function aplicarTexto(estado: EstadoConversa, mensagemId: string, posicao: number, trecho: string): EstadoConversa {
  const conhecida = estado.mensagens.find((mensagem) => mensagem.id === mensagemId);
  if (conhecida && terminou(conhecida)) return estado;
  // Parte do texto que veio na busca, quando ainda não há nada ao vivo para esta mensagem.
  const atual = estado.aoVivo[mensagemId] ?? { texto: conhecida?.texto ?? '', adiantados: [] };
  const junto = juntarTrecho(atual.texto, posicao, trecho);

  if (junto === null) {
    // Buraco: falta texto antes deste trecho. Ele fica guardado e a conversa pede uma busca.
    // Só o primeiro buraco conta como perda nova; os seguintes esperam a mesma busca.
    const primeiro = atual.adiantados.length === 0;
    const adiantados =
      atual.adiantados.length < MAXIMO_DE_ADIANTADOS ? [...atual.adiantados, { posicao, trecho }] : atual.adiantados;
    return {
      ...estado,
      aoVivo: { ...estado.aoVivo, [mensagemId]: { texto: atual.texto, adiantados } },
      desatualizada: true,
      perdas: primeiro ? estado.perdas + 1 : estado.perdas,
    };
  }

  if (junto === atual.texto) return estado;
  return { ...estado, aoVivo: { ...estado.aoVivo, [mensagemId]: encaixar(junto, atual.adiantados) } };
}

/** Aplica um evento do servidor à conversa do bot `botId`. Evento de outro bot não muda nada. */
export function aplicarEvento(estado: EstadoConversa, botId: string, evento: Evento): EstadoConversa {
  switch (evento.tipo) {
    case 'turno_iniciado': {
      if (evento.botId !== botId || estado.aoVivo[evento.mensagemId]) return estado;
      const conhecida = estado.mensagens.find((mensagem) => mensagem.id === evento.mensagemId);
      if (conhecida && terminou(conhecida)) return estado;
      const vivo: TextoAoVivo = { texto: conhecida?.texto ?? '', adiantados: [] };
      return { ...estado, aoVivo: { ...estado.aoVivo, [evento.mensagemId]: vivo } };
    }
    case 'texto':
      return evento.botId === botId ? aplicarTexto(estado, evento.mensagemId, evento.posicao, evento.trecho) : estado;
    case 'turno_terminado': {
      if (evento.botId !== botId) return estado;
      const conhecida = estado.mensagens.some((mensagem) => mensagem.id === evento.mensagem.id);
      const mensagens = inserir(estado.mensagens, evento.mensagem);
      const semPerda = { ...estado, mensagens, aoVivo: acertarAoVivo(estado.aoVivo, mensagens, false) };
      // Resposta de um turno que o app não viu começar: falta ao menos a mensagem da pessoa.
      return conhecida ? semPerda : { ...semPerda, desatualizada: true, perdas: estado.perdas + 1 };
    }
    case 'ressincronizar':
      return { ...estado, desatualizada: true, perdas: estado.perdas + 1 };
    // Bots e pedidos de aprovação ficam fora da conversa: quem os guarda é o armazém.
    case 'bot_salvo':
    case 'aprovacao_pedida':
    case 'aprovacao_resolvida':
      return estado;
  }
}

/** A conversa precisa buscar a página mais recente: perdeu algo ou há turno de mensagens que ela não tem. */
export function precisaRecarregar(estado: EstadoConversa): boolean {
  if (estado.desatualizada) return true;
  return Object.keys(estado.aoVivo).some((id) => !estado.mensagens.some((mensagem) => mensagem.id === id));
}

function textoVisivel(estado: EstadoConversa, mensagem: Mensagem): string {
  const vivo = estado.aoVivo[mensagem.id];
  if (terminou(mensagem) || !vivo) return mensagem.texto;
  return vivo.texto.length > mensagem.texto.length ? vivo.texto : mensagem.texto;
}

/**
 * Mensagens para a tela, da mais nova para a mais antiga (a lista da conversa é invertida),
 * com o texto ao vivo no lugar do texto das respostas em andamento.
 */
export function mensagensVisiveis(estado: EstadoConversa): Mensagem[] {
  const visiveis: Mensagem[] = [];
  for (let indice = estado.mensagens.length - 1; indice >= 0; indice -= 1) {
    const mensagem = estado.mensagens[indice];
    if (!mensagem) continue;
    const texto = textoVisivel(estado, mensagem);
    visiveis.push(texto === mensagem.texto ? mensagem : { ...mensagem, texto });
  }
  return visiveis;
}

/** Rótulo pequeno abaixo de uma resposta que não terminou bem. */
export function rotuloDoEstado(estado: Mensagem['estado']): string | null {
  if (estado === 'parada') return 'Resposta parada';
  if (estado === 'falhou') return 'A resposta falhou';
  return null;
}
