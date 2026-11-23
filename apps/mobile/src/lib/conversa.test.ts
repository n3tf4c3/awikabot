import { describe, expect, it } from 'vitest';
import type { Evento, Mensagem } from '@awikabot/core';
import {
  CONVERSA_VAZIA,
  aplicarEvento,
  aplicarPaginaAnterior,
  aplicarPaginaRecente,
  aplicarTurnoEnviado,
  juntarTrecho,
  mensagensVisiveis,
  precisaRecarregar,
  rotuloDoEstado,
  type EstadoConversa,
} from './conversa';

const BOT = 'bot0000000000001';
const OUTRO_BOT = 'bot0000000000002';

function id(seq: number): string {
  return `msg${String(seq).padStart(13, '0')}`;
}

/** Mensagem `seq` do bot: ímpar é da pessoa, par é do bot. */
function msg(seq: number, estado: Mensagem['estado'] = 'completa', texto = `texto ${seq}`): Mensagem {
  return { id: id(seq), botId: BOT, seq, papel: seq % 2 === 1 ? 'usuario' : 'bot', texto, estado, criadaEm: seq };
}

function faixa(de: number, ate: number): Mensagem[] {
  return Array.from({ length: ate - de + 1 }, (_, indice) => msg(de + indice));
}

function seqs(estado: EstadoConversa): number[] {
  return estado.mensagens.map((mensagem) => mensagem.seq);
}

function comEventos(estado: EstadoConversa, eventos: Evento[]): EstadoConversa {
  return eventos.reduce((atual, evento) => aplicarEvento(atual, BOT, evento), estado);
}

const iniciado = (seq: number, botId = BOT): Evento => ({ tipo: 'turno_iniciado', botId, mensagemId: id(seq) });
const texto = (seq: number, posicao: number, trecho: string, botId = BOT): Evento => ({
  tipo: 'texto',
  botId,
  mensagemId: id(seq),
  posicao,
  trecho,
});
const terminado = (mensagem: Mensagem, botId = BOT): Evento => ({ tipo: 'turno_terminado', botId, mensagem });

/** Conversa com as mensagens 1 e 2 já carregadas. */
const base = aplicarPaginaRecente(CONVERSA_VAZIA, { mensagens: faixa(1, 2), temMais: false });

/** A mesma conversa com um turno enviado: a mensagem 3 da pessoa e a 4 do bot, em andamento e vazia. */
const emCurso = aplicarTurnoEnviado(base, { usuario: msg(3), bot: msg(4, 'em_andamento', '') });

/** Página que o servidor devolve com a resposta 4 em andamento, já com `parcial` de texto. */
function paginaComParcial(parcial: string) {
  return { mensagens: [...faixa(1, 3), msg(4, 'em_andamento', parcial)], temMais: false };
}

/** Texto que a tela mostra para a mensagem `seq`. */
function visivel(estado: EstadoConversa, seq: number): string | undefined {
  return mensagensVisiveis(estado).find((mensagem) => mensagem.seq === seq)?.texto;
}

describe('juntarTrecho', () => {
  it('acrescenta o trecho que começa exatamente no fim do texto', () => {
    expect(juntarTrecho('Olá', 3, ', mundo')).toBe('Olá, mundo');
    expect(juntarTrecho('', 0, 'Olá')).toBe('Olá');
  });

  it('ignora o trecho que está inteiro antes do fim', () => {
    expect(juntarTrecho('Olá, mundo', 0, 'Olá')).toBe('Olá, mundo');
    expect(juntarTrecho('Olá, mundo', 3, ', mundo')).toBe('Olá, mundo');
    expect(juntarTrecho('Olá, mundo', 5, 'mun')).toBe('Olá, mundo');
  });

  it('aproveita só a parte nova do trecho que passa do fim', () => {
    expect(juntarTrecho('Olá, mun', 5, 'mundo!')).toBe('Olá, mundo!');
    expect(juntarTrecho('Olá', 0, 'Olá, mundo')).toBe('Olá, mundo');
    expect(juntarTrecho('Olá, mund', 3, ', mundo')).toBe('Olá, mundo');
  });

  it('devolve null quando o trecho começa depois do fim', () => {
    expect(juntarTrecho('Olá', 4, 'mundo')).toBeNull();
    expect(juntarTrecho('', 1, 'x')).toBeNull();
  });

  it('trecho vazio não muda nada, a não ser que esteja depois do fim', () => {
    expect(juntarTrecho('Olá', 3, '')).toBe('Olá');
    expect(juntarTrecho('Olá', 1, '')).toBe('Olá');
    expect(juntarTrecho('Olá', 4, '')).toBeNull();
  });
});

describe('aplicarPaginaRecente', () => {
  it('carrega a primeira página', () => {
    const estado = aplicarPaginaRecente(CONVERSA_VAZIA, { mensagens: faixa(11, 60), temMais: true });
    expect(seqs(estado)).toEqual(faixa(11, 60).map((mensagem) => mensagem.seq));
    expect(estado.temMais).toBe(true);
    expect(estado.carregada).toBe(true);
    expect(estado.desatualizada).toBe(false);
  });

  it('marca como carregada mesmo sem mensagens', () => {
    const estado = aplicarPaginaRecente(CONVERSA_VAZIA, { mensagens: [], temMais: false });
    expect(estado).toEqual({ ...CONVERSA_VAZIA, carregada: true });
  });

  it('mantém as mais antigas já carregadas quando a página emenda nelas', () => {
    const comAntigas: EstadoConversa = { ...CONVERSA_VAZIA, mensagens: faixa(1, 60), temMais: false, carregada: true };
    const estado = aplicarPaginaRecente(comAntigas, { mensagens: faixa(13, 62), temMais: true });
    expect(seqs(estado)).toEqual(faixa(1, 62).map((mensagem) => mensagem.seq));
    expect(estado.temMais).toBe(false);
  });

  it('descarta as mais antigas quando a página não emenda nelas', () => {
    const comAntigas: EstadoConversa = { ...CONVERSA_VAZIA, mensagens: faixa(1, 10), temMais: false, carregada: true };
    const estado = aplicarPaginaRecente(comAntigas, { mensagens: faixa(31, 80), temMais: true });
    expect(seqs(estado)).toEqual(faixa(31, 80).map((mensagem) => mensagem.seq));
    expect(estado.temMais).toBe(true);
  });

  it('a página substitui a versão local das mensagens que cobre', () => {
    const estado = aplicarPaginaRecente(base, { mensagens: [msg(1), msg(2, 'completa', 'corrigido')], temMais: false });
    expect(estado.mensagens[1]?.texto).toBe('corrigido');
  });

  it('não volta para em andamento uma resposta que já terminou por evento', () => {
    const terminada = comEventos(emCurso, [terminado(msg(4, 'completa', 'pronto'))]);
    // Resposta HTTP montada antes do fim do turno, entregue depois do evento.
    const estado = aplicarPaginaRecente(terminada, paginaComParcial('pron'));
    expect(estado.mensagens[3]).toEqual(msg(4, 'completa', 'pronto'));
    expect(visivel(estado, 4)).toBe('pronto');
  });

  it('mantém no fim as mensagens que chegaram depois da página', () => {
    const estado = aplicarPaginaRecente(emCurso, { mensagens: faixa(1, 2), temMais: false });
    expect(seqs(estado)).toEqual([1, 2, 3, 4]);
  });

  it('limpa a marca de desatualizada', () => {
    const marcada = comEventos(base, [{ tipo: 'ressincronizar' }]);
    expect(aplicarPaginaRecente(marcada, { mensagens: faixa(1, 2), temMais: false }).desatualizada).toBe(false);
  });

  it('mostra o texto que veio na busca para a resposta em andamento', () => {
    const estado = aplicarPaginaRecente(CONVERSA_VAZIA, paginaComParcial('Olá, mun'));
    expect(visivel(estado, 4)).toBe('Olá, mun');
    expect(precisaRecarregar(estado)).toBe(false);
  });

  it('fica com o texto ao vivo quando ele está na frente do texto buscado', () => {
    const adiantada = comEventos(emCurso, [iniciado(4), texto(4, 0, 'Olá'), texto(4, 3, ', mundo')]);
    // Página montada quando o servidor só tinha "Olá".
    const estado = aplicarPaginaRecente(adiantada, paginaComParcial('Olá'));
    expect(visivel(estado, 4)).toBe('Olá, mundo');
  });

  it('parte do texto buscado quando ele está na frente do texto ao vivo', () => {
    const atrasada = comEventos(emCurso, [iniciado(4), texto(4, 0, 'Olá')]);
    const estado = aplicarPaginaRecente(atrasada, paginaComParcial('Olá, mundo'));
    expect(visivel(estado, 4)).toBe('Olá, mundo');
    // O trecho que ainda vinha a caminho já está no texto buscado: não repete.
    expect(visivel(comEventos(estado, [texto(4, 3, ', mundo')]), 4)).toBe('Olá, mundo');
    expect(visivel(comEventos(estado, [texto(4, 10, '!')]), 4)).toBe('Olá, mundo!');
  });

  it('encaixa depois da busca os trechos que chegaram adiantados enquanto ela corria', () => {
    // O app abre a conversa no meio do turno: os trechos chegam antes da página e não emendam em nada.
    const aberta = comEventos({ ...CONVERSA_VAZIA }, [texto(4, 8, 'do'), texto(4, 10, '!')]);
    expect(precisaRecarregar(aberta)).toBe(true);

    // A página foi montada entre os dois trechos: traz o primeiro, e o segundo estava guardado.
    const estado = aplicarPaginaRecente(aberta, paginaComParcial('Olá, mundo'));

    expect(visivel(estado, 4)).toBe('Olá, mundo!');
    expect(estado.aoVivo[id(4)]?.adiantados).toEqual([]);
    expect(precisaRecarregar(estado)).toBe(false);
    expect(visivel(comEventos(estado, [texto(4, 11, ' Tudo bem?')]), 4)).toBe('Olá, mundo! Tudo bem?');
  });

  it('larga os adiantados que nem a busca alcança, e o trecho seguinte pede outra busca', () => {
    const comBuraco = comEventos(emCurso, [iniciado(4), texto(4, 0, 'Olá'), texto(4, 20, 'fim')]);
    const perdasAntes = comBuraco.perdas;
    // Página mais velha que o buraco: não traz o que falta entre 3 e 20.
    const estado = aplicarPaginaRecente(comBuraco, paginaComParcial('Olá, mun'));
    expect(visivel(estado, 4)).toBe('Olá, mun');
    expect(estado.aoVivo[id(4)]?.adiantados).toEqual([]);
    expect(precisaRecarregar(estado)).toBe(false);

    const depois = comEventos(estado, [texto(4, 23, '.')]);
    expect(visivel(depois, 4)).toBe('Olá, mun');
    expect(precisaRecarregar(depois)).toBe(true);
    expect(depois.perdas).toBe(perdasAntes + 1);
  });

  it('joga fora texto ao vivo de mensagem que a página não tem, para não buscar sem parar', () => {
    const orfa = comEventos(base, [iniciado(4), texto(4, 0, 'olá')]);
    expect(precisaRecarregar(orfa)).toBe(true);
    const estado = aplicarPaginaRecente(orfa, { mensagens: faixa(1, 2), temMais: false });
    expect(estado.aoVivo).toEqual({});
    expect(precisaRecarregar(estado)).toBe(false);
  });
});

describe('aplicarPaginaAnterior', () => {
  const recente = aplicarPaginaRecente(CONVERSA_VAZIA, { mensagens: faixa(51, 100), temMais: true });

  it('põe as mensagens antigas no começo e atualiza temMais', () => {
    const estado = aplicarPaginaAnterior(recente, 51, { mensagens: faixa(1, 50), temMais: false });
    expect(seqs(estado)).toEqual(faixa(1, 100).map((mensagem) => mensagem.seq));
    expect(estado.temMais).toBe(false);
  });

  it('descarta a página quando a lista mudou de começo durante o pedido', () => {
    const estado = aplicarPaginaAnterior(recente, 80, { mensagens: faixa(30, 79), temMais: true });
    expect(estado).toBe(recente);
  });

  it('descarta a página pedida para uma conversa que ficou vazia', () => {
    expect(aplicarPaginaAnterior(CONVERSA_VAZIA, 51, { mensagens: faixa(1, 50), temMais: false })).toBe(CONVERSA_VAZIA);
  });

  it('não repete mensagem aplicada duas vezes', () => {
    const pagina = { mensagens: faixa(41, 55), temMais: true };
    const estado = aplicarPaginaAnterior(recente, 51, pagina);
    expect(seqs(estado)).toEqual(faixa(41, 100).map((mensagem) => mensagem.seq));
    expect(aplicarPaginaAnterior(estado, 51, pagina)).toBe(estado);
  });
});

describe('aplicarTurnoEnviado', () => {
  it('acrescenta a mensagem da pessoa e a do bot em andamento', () => {
    expect(seqs(emCurso)).toEqual([1, 2, 3, 4]);
    expect(emCurso.mensagens[3]?.estado).toBe('em_andamento');
  });

  it('não repete mensagens se a resposta for aplicada duas vezes', () => {
    const resposta = { usuario: msg(3), bot: msg(4, 'em_andamento', '') };
    expect(seqs(aplicarTurnoEnviado(emCurso, resposta))).toEqual([1, 2, 3, 4]);
  });

  it('resolve a espera pelas mensagens de um turno cujo evento chegou antes da resposta', () => {
    const adiantado = comEventos(base, [iniciado(4), texto(4, 0, 'ol')]);
    expect(precisaRecarregar(adiantado)).toBe(true);
    const estado = aplicarTurnoEnviado(adiantado, { usuario: msg(3), bot: msg(4, 'em_andamento', '') });
    expect(precisaRecarregar(estado)).toBe(false);
    expect(visivel(estado, 4)).toBe('ol');
  });

  it('não desfaz um turno que já terminou por evento antes da resposta chegar', () => {
    const terminada = comEventos(base, [iniciado(4), terminado(msg(4, 'completa', 'pronto'))]);
    const estado = aplicarTurnoEnviado(terminada, { usuario: msg(3), bot: msg(4, 'em_andamento', '') });
    expect(estado.mensagens.map((mensagem) => [mensagem.seq, mensagem.estado])).toEqual([
      [1, 'completa'],
      [2, 'completa'],
      [3, 'completa'],
      [4, 'completa'],
    ]);
    expect(visivel(estado, 4)).toBe('pronto');
  });
});

describe('aplicarEvento: texto pela posição', () => {
  it('a resposta cresce a cada trecho que começa no fim do texto', () => {
    const passos = [iniciado(4), texto(4, 0, 'Olá'), texto(4, 3, ', '), texto(4, 5, 'mundo')];
    const vistos = passos.map((_, indice) => visivel(comEventos(emCurso, passos.slice(0, indice + 1)), 4));
    expect(vistos).toEqual(['', 'Olá', 'Olá, ', 'Olá, mundo']);
  });

  it('ignora o trecho repetido, que está inteiro antes do fim', () => {
    const estado = comEventos(emCurso, [iniciado(4), texto(4, 0, 'Olá'), texto(4, 3, ', mundo')]);
    expect(aplicarEvento(estado, BOT, texto(4, 0, 'Olá'))).toBe(estado);
    expect(aplicarEvento(estado, BOT, texto(4, 3, ', mundo'))).toBe(estado);
    expect(aplicarEvento(estado, BOT, texto(4, 5, 'mun'))).toBe(estado);
  });

  it('do trecho que se sobrepõe ao fim, junta só a parte nova', () => {
    const estado = comEventos(emCurso, [iniciado(4), texto(4, 0, 'Olá, mun'), texto(4, 5, 'mundo!')]);
    expect(visivel(estado, 4)).toBe('Olá, mundo!');
    expect(estado.desatualizada).toBe(false);
  });

  it('com buraco não junta o trecho e pede a busca da conversa', () => {
    const antes = comEventos(emCurso, [iniciado(4), texto(4, 0, 'Olá')]);
    const estado = comEventos(antes, [texto(4, 10, 'fim')]);
    expect(visivel(estado, 4)).toBe('Olá');
    expect(estado.desatualizada).toBe(true);
    expect(precisaRecarregar(estado)).toBe(true);
    expect(estado.perdas).toBe(antes.perdas + 1);
  });

  it('os buracos seguintes da mesma resposta esperam a mesma busca, sem contar perda nova', () => {
    const umBuraco = comEventos(emCurso, [iniciado(4), texto(4, 0, 'Olá'), texto(4, 10, 'a')]);
    const doisBuracos = comEventos(umBuraco, [texto(4, 11, 'b'), texto(4, 12, 'c')]);
    expect(doisBuracos.perdas).toBe(umBuraco.perdas);
    expect(visivel(doisBuracos, 4)).toBe('Olá');
  });

  it('o trecho que fecha o buraco traz junto os que estavam adiantados', () => {
    const estado = comEventos(emCurso, [iniciado(4), texto(4, 0, 'Olá'), texto(4, 5, 'mundo'), texto(4, 3, ', ')]);
    expect(visivel(estado, 4)).toBe('Olá, mundo');
    expect(estado.aoVivo[id(4)]?.adiantados).toEqual([]);
  });

  it('continua do texto buscado quando o trecho começa no fim dele', () => {
    const aberta = aplicarPaginaRecente(CONVERSA_VAZIA, paginaComParcial('Olá, mun'));
    expect(visivel(comEventos(aberta, [texto(4, 8, 'do')]), 4)).toBe('Olá, mundo');
  });

  it('não repete o trecho que já veio dentro do texto buscado', () => {
    const aberta = aplicarPaginaRecente(CONVERSA_VAZIA, paginaComParcial('Olá, mun'));
    expect(aplicarEvento(aberta, BOT, texto(4, 5, 'mun'))).toBe(aberta);
    expect(visivel(comEventos(aberta, [texto(4, 5, 'mundo')]), 4)).toBe('Olá, mundo');
  });

  it('trecho além do texto buscado é buraco: fica o texto buscado e a conversa busca de novo', () => {
    const aberta = aplicarPaginaRecente(CONVERSA_VAZIA, paginaComParcial('Olá'));
    const estado = comEventos(aberta, [texto(4, 8, 'do')]);
    expect(visivel(estado, 4)).toBe('Olá');
    expect(precisaRecarregar(estado)).toBe(true);
  });

  it('guarda um número limitado de trechos adiantados', () => {
    const eventos = Array.from({ length: 300 }, (_, indice) => texto(4, 10 + indice, 'x'));
    const estado = comEventos(emCurso, [iniciado(4), ...eventos]);
    expect(estado.aoVivo[id(4)]?.adiantados).toHaveLength(256);
    expect(visivel(estado, 4)).toBe('');
  });

  it('turno_iniciado repetido não apaga o texto já recebido', () => {
    const estado = comEventos(emCurso, [iniciado(4), texto(4, 0, 'Olá')]);
    expect(aplicarEvento(estado, BOT, iniciado(4))).toBe(estado);
  });

  it('turno_iniciado de resposta que veio na busca parte do texto buscado', () => {
    const aberta = aplicarPaginaRecente(CONVERSA_VAZIA, paginaComParcial('Olá'));
    expect(visivel(comEventos(aberta, [iniciado(4), texto(4, 3, '!')]), 4)).toBe('Olá!');
  });

  it('ignora trecho atrasado de uma resposta que já terminou', () => {
    const terminada = comEventos(emCurso, [iniciado(4), terminado(msg(4, 'completa', 'pronto'))]);
    expect(aplicarEvento(terminada, BOT, texto(4, 6, 'sobra'))).toBe(terminada);
    expect(aplicarEvento(terminada, BOT, texto(4, 99, 'sobra'))).toBe(terminada);
  });

  it('ignora turno_iniciado atrasado de uma resposta que já terminou', () => {
    const terminada = comEventos(emCurso, [iniciado(4), terminado(msg(4, 'completa', 'pronto'))]);
    expect(aplicarEvento(terminada, BOT, iniciado(4))).toBe(terminada);
  });
});

describe('aplicarEvento: turnos e ressincronização', () => {
  it('turno_terminado troca o texto ao vivo pela mensagem final', () => {
    const estado = comEventos(emCurso, [iniciado(4), texto(4, 0, 'Olá'), terminado(msg(4, 'completa', 'Olá, mundo'))]);
    expect(estado.mensagens[3]).toEqual(msg(4, 'completa', 'Olá, mundo'));
    expect(estado.aoVivo).toEqual({});
    expect(visivel(estado, 4)).toBe('Olá, mundo');
    expect(precisaRecarregar(estado)).toBe(false);
  });

  it.each(['parada', 'falhou'] as const)('guarda o estado %s que vem no fim do turno', (estadoFinal) => {
    const estado = comEventos(emCurso, [iniciado(4), texto(4, 0, 'Olá'), terminado(msg(4, estadoFinal, 'Olá'))]);
    expect(estado.mensagens[3]?.estado).toBe(estadoFinal);
  });

  it('ignora eventos de outro bot', () => {
    const eventos = [
      iniciado(4, OUTRO_BOT),
      texto(4, 0, 'x', OUTRO_BOT),
      terminado({ ...msg(4), botId: OUTRO_BOT }, OUTRO_BOT),
    ];
    expect(comEventos(emCurso, eventos)).toBe(emCurso);
  });

  it('bot_salvo não mexe na conversa', () => {
    const bot = { id: BOT, nome: 'x', instrucoes: '', modelo: null, criadoEm: 1, atualizadoEm: 2, turnoAtivo: false };
    expect(aplicarEvento(emCurso, BOT, { tipo: 'bot_salvo', bot })).toBe(emCurso);
  });

  it('turno iniciado por outro aparelho pede a busca das mensagens que faltam', () => {
    const estado = comEventos(base, [iniciado(4), texto(4, 0, 'Olá')]);
    expect(seqs(estado)).toEqual([1, 2]);
    expect(precisaRecarregar(estado)).toBe(true);
  });

  it('fim de um turno que o app não viu entra na lista e pede a busca do que falta', () => {
    const estado = comEventos(base, [terminado(msg(4, 'completa', 'pronto'))]);
    expect(seqs(estado)).toEqual([1, 2, 4]);
    expect(estado.desatualizada).toBe(true);
    expect(estado.perdas).toBe(base.perdas + 1);
    expect(precisaRecarregar(estado)).toBe(true);
  });

  it('conta cada perda, e a página recente não zera a conta', () => {
    const perdida = comEventos(base, [{ tipo: 'ressincronizar' }, { tipo: 'ressincronizar' }]);
    expect(perdida.perdas).toBe(2);
    const recarregada = aplicarPaginaRecente(perdida, { mensagens: faixa(1, 2), temMais: false });
    expect(recarregada.perdas).toBe(2);
    expect(recarregada.desatualizada).toBe(false);
  });

  it('turno que termina normalmente não conta como perda', () => {
    const estado = comEventos(emCurso, [iniciado(4), texto(4, 0, 'a'), terminado(msg(4, 'completa', 'a'))]);
    expect(estado.perdas).toBe(0);
    expect(estado.desatualizada).toBe(false);
  });

  it('ressincronizar marca a conversa e mantém o texto que já chegou, sem reticências', () => {
    const estado = comEventos(emCurso, [iniciado(4), texto(4, 0, 'Olá'), { tipo: 'ressincronizar' }]);
    expect(estado.desatualizada).toBe(true);
    expect(precisaRecarregar(estado)).toBe(true);
    expect(visivel(estado, 4)).toBe('Olá');
  });

  it('depois de ressincronizar, o trecho perdido vira buraco e a busca traz o que falta', () => {
    const perdida = comEventos(emCurso, [iniciado(4), texto(4, 0, 'Olá'), { tipo: 'ressincronizar' }, texto(4, 8, 'do')]);
    expect(visivel(perdida, 4)).toBe('Olá');
    const estado = aplicarPaginaRecente(perdida, paginaComParcial('Olá, mun'));
    expect(visivel(estado, 4)).toBe('Olá, mundo');
  });

  it('não muda o estado recebido', () => {
    const congelado = Object.freeze({ ...emCurso, mensagens: Object.freeze([...emCurso.mensagens]) });
    expect(() =>
      comEventos(congelado, [iniciado(4), texto(4, 0, 'a'), texto(4, 5, 'z'), terminado(msg(4, 'completa', 'a'))]),
    ).not.toThrow();
    expect(seqs(congelado)).toEqual([1, 2, 3, 4]);
    expect(congelado.mensagens[3]?.estado).toBe('em_andamento');
  });
});

describe('mensagensVisiveis', () => {
  it('devolve da mais nova para a mais antiga', () => {
    expect(mensagensVisiveis(base).map((mensagem) => mensagem.seq)).toEqual([2, 1]);
  });

  it('reaproveita o objeto das mensagens cujo texto não mudou', () => {
    const comTexto = comEventos(emCurso, [iniciado(4), texto(4, 0, 'Olá')]);
    const visiveis = mensagensVisiveis(comTexto);
    expect(visiveis[0]).toEqual(msg(4, 'em_andamento', 'Olá'));
    expect(visiveis[1]).toBe(comTexto.mensagens[2]);
    expect(visiveis[3]).toBe(comTexto.mensagens[0]);
  });

  it('usa o texto da mensagem quando não há texto ao vivo', () => {
    const estado = aplicarPaginaRecente(CONVERSA_VAZIA, { mensagens: [msg(1), msg(2, 'em_andamento', 'parcial')], temMais: false });
    expect(visivel(estado, 2)).toBe('parcial');
  });
});

describe('rotuloDoEstado', () => {
  it('só rotula resposta parada ou que falhou', () => {
    expect(rotuloDoEstado('parada')).toBe('Resposta parada');
    expect(rotuloDoEstado('falhou')).toBe('A resposta falhou');
    expect(rotuloDoEstado('completa')).toBeNull();
    expect(rotuloDoEstado('em_andamento')).toBeNull();
  });
});
