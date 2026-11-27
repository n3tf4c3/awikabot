import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Mensagem } from '@awikabot/core';
import type { GestorDeAprovacoes } from './aprovacoes';
import { emTransacao, type Banco } from './banco';
import { gravarSessaoMotor, type BotInterno } from './bots';
import { concluirMensagem, gravarParcial, inserirMensagem } from './conversa';
import type { Barramento } from './eventos';
import type { Ganchos } from './gancho';
import type { Motor, ResultadoMotor, TurnoEmCurso } from './motor';

export type InicioDeTurno =
  | { ok: true; usuario: Mensagem; bot: Mensagem }
  | { ok: false; motivo: 'turno_em_andamento' | 'limite_de_turnos' | 'servidor_encerrando' };

/** O que liga os turnos às aprovações. Sem isto, o motor nega o que pediria aprovação. */
export interface LigacaoDeAprovacoes {
  ganchos: Ganchos;
  aprovacoes: GestorDeAprovacoes;
  /** Linha de comando do gancho e a porta em loopback onde o servidor o atende. */
  comando: string;
  porta: number;
}

/** De quanto em quanto tempo o texto de uma resposta em andamento vai para o banco. */
export const INTERVALO_GRAVACAO_PARCIAL_MS = 1000;

/** O que a pessoa lê na resposta de um turno cujo motor quebrou antes de começar. */
const MOTOR_NAO_INICIOU = 'O motor não conseguiu começar este turno.';

/** Quanto o servidor espera os turnos fecharem ao ser encerrado. Cabe no prazo de parada do contêiner. */
export const PRAZO_PARADA_MS = 5000;

/** Dono dos turnos em curso: um por bot, e um teto para o servidor inteiro. */
export class GestorDeTurnos {
  private readonly ativos = new Map<string, TurnoEmCurso>();
  /** Fecho de cada turno em curso: resolve depois de a resposta estar gravada. */
  private readonly fechos = new Map<string, Promise<void>>();
  /** Texto já recebido de cada resposta em andamento, por id da mensagem. */
  private readonly parciais = new Map<string, string>();
  /** A gravação marcada para o texto que chegou e ainda não foi para o banco, por id da mensagem. */
  private readonly gravacoes = new Map<string, NodeJS.Timeout>();
  /** O servidor recebeu o pedido de parada: nenhum turno novo começa. */
  private encerrando = false;
  private readonly banco: Banco;
  private readonly motor: Motor;
  private readonly barramento: Barramento;
  private readonly limite: number;
  private readonly pastaDosBots: string;
  private readonly ligacao: LigacaoDeAprovacoes | null;
  private readonly intervaloGravacaoMs: number;

  constructor(deps: {
    banco: Banco;
    motor: Motor;
    barramento: Barramento;
    limite: number;
    pastaDosBots: string;
    aprovacoes?: LigacaoDeAprovacoes;
    /** Menor nos testes. */
    intervaloGravacaoMs?: number;
  }) {
    this.banco = deps.banco;
    this.motor = deps.motor;
    this.barramento = deps.barramento;
    this.limite = deps.limite;
    this.pastaDosBots = deps.pastaDosBots;
    this.ligacao = deps.aprovacoes ?? null;
    this.intervaloGravacaoMs = deps.intervaloGravacaoMs ?? INTERVALO_GRAVACAO_PARCIAL_MS;
  }

  ativo(botId: string): boolean {
    return this.ativos.has(botId);
  }

  /** O que já chegou de uma resposta em andamento; `undefined` se ela não está em curso. */
  textoParcial(mensagemId: string): string | undefined {
    return this.parciais.get(mensagemId);
  }

  iniciar(bot: BotInterno, texto: string): InicioDeTurno {
    // Um turno aceito depois do pedido de parada ficaria fora dos que o servidor espera fechar.
    if (this.encerrando) return { ok: false, motivo: 'servidor_encerrando' };
    if (this.ativos.has(bot.id)) return { ok: false, motivo: 'turno_em_andamento' };
    if (this.ativos.size >= this.limite) return { ok: false, motivo: 'limite_de_turnos' };

    // A pasta leva só o id gerado pelo servidor: nada vindo do app entra no caminho.
    const pasta = path.resolve(this.pastaDosBots, bot.id);
    mkdirSync(pasta, { recursive: true });

    // A mensagem da pessoa e a resposta em andamento entram juntas: se a segunda não entra, a
    // primeira não fica sozinha na conversa.
    const { usuario, resposta } = emTransacao(this.banco, () => ({
      usuario: inserirMensagem(this.banco, { botId: bot.id, papel: 'usuario', texto, estado: 'completa' }),
      resposta: inserirMensagem(this.banco, { botId: bot.id, papel: 'bot', texto: '', estado: 'em_andamento' }),
    }));

    const ligacao = this.ligacao;
    const token = ligacao?.ganchos.registrar({ botId: bot.id, mensagemId: resposta.id, pasta }) ?? null;

    this.parciais.set(resposta.id, '');
    let turno: TurnoEmCurso;
    try {
      turno = this.motor({
        motor: bot.motor,
        pasta,
        texto,
        instrucoes: bot.instrucoes,
        modelo: bot.modelo,
        esforco: bot.esforco,
        sessao: bot.sessaoMotor,
        gancho: ligacao && token ? { comando: ligacao.comando, porta: ligacao.porta, token } : null,
        aoTexto: (trecho) => {
          const anterior = this.parciais.get(resposta.id) ?? '';
          this.parciais.set(resposta.id, anterior + trecho);
          this.marcarGravacao(resposta.id);
          this.barramento.publicar({ tipo: 'texto', botId: bot.id, mensagemId: resposta.id, posicao: anterior.length, trecho });
        },
      });
    } catch (erro) {
      // Um driver que quebra antes de devolver o turno deixaria a resposta em andamento para sempre,
      // com o token do gancho valendo. O turno fecha como falha, pelo mesmo caminho dos outros.
      console.error(`turnos: o motor não iniciou: ${erro instanceof Error ? erro.message : 'erro desconhecido'}`);
      turno = { parar: () => {}, fim: Promise.resolve({ estado: 'falhou', texto: MOTOR_NAO_INICIOU, sessao: bot.sessaoMotor }) };
    }
    this.ativos.set(bot.id, turno);
    this.barramento.publicar({ tipo: 'turno_iniciado', botId: bot.id, mensagemId: resposta.id });
    this.fechos.set(
      bot.id,
      turno.fim.then((resultado) => {
        this.concluir(bot.id, resposta.id, token, resultado);
      }),
    );

    return { ok: true, usuario, bot: resposta };
  }

  parar(botId: string): boolean {
    const turno = this.ativos.get(botId);
    if (!turno) return false;
    turno.parar();
    return true;
  }

  /**
   * Marca a gravação do que chegou de uma resposta, para daqui a um intervalo. Numa queda, o que
   * sobra é o que já foi para o banco: no máximo um intervalo se perde, mesmo que o motor se cale
   * depois de um trecho. Com uma gravação já marcada, não marca outra; sem texto novo, nenhuma roda.
   */
  private marcarGravacao(mensagemId: string): void {
    if (this.gravacoes.has(mensagemId)) return;
    const relogio = setTimeout(() => {
      this.gravacoes.delete(mensagemId);
      this.gravarOQueChegou(mensagemId);
    }, this.intervaloGravacaoMs);
    this.gravacoes.set(mensagemId, relogio);
  }

  /** Com o banco já fechado, como no fim de uma parada, não há onde gravar: o relógio não derruba o processo. */
  private gravarOQueChegou(mensagemId: string): void {
    const parcial = this.parciais.get(mensagemId);
    if (parcial !== undefined && this.banco.isOpen) gravarParcial(this.banco, mensagemId, parcial);
  }

  /**
   * Para todos os turnos e espera cada resposta ser gravada, até o prazo. Do turno que não fechar
   * a tempo, o texto que já chegou vai para o banco, e a partida seguinte marca a resposta como
   * falha. Depois desta chamada o gestor não aceita turno novo: ela é o pedido de parada do servidor.
   */
  async pararTodos(prazoMs = PRAZO_PARADA_MS): Promise<void> {
    // Antes de qualquer espera: daqui em diante, `iniciar` recusa, também para o pedido que já lia o corpo.
    this.encerrando = true;
    const fechos = [...this.fechos.values()];
    for (const turno of this.ativos.values()) turno.parar();
    let relogio: NodeJS.Timeout | undefined;
    const prazo = new Promise<void>((ok) => {
      relogio = setTimeout(ok, prazoMs);
    });
    await Promise.race([Promise.all(fechos), prazo]);
    clearTimeout(relogio);
    // Quem chama fecha o banco em seguida: o que ainda esperava a gravação marcada vai agora.
    for (const [mensagemId, marcada] of this.gravacoes) {
      clearTimeout(marcada);
      this.gravarOQueChegou(mensagemId);
    }
    this.gravacoes.clear();
  }

  private concluir(botId: string, mensagemId: string, token: string | null, resultado: ResultadoMotor): void {
    this.ativos.delete(botId);
    this.fechos.delete(botId);
    this.parciais.delete(mensagemId);
    // A gravação marcada não roda mais: a resposta vai inteira para o banco logo abaixo.
    clearTimeout(this.gravacoes.get(mensagemId));
    this.gravacoes.delete(mensagemId);
    if (this.ligacao && token) {
      // O token deixa de valer com o turno, e o que ainda esperava resposta não vai mais rodar.
      this.ligacao.ganchos.remover(token);
      this.ligacao.aprovacoes.expirarDaMensagem(mensagemId);
    }
    gravarSessaoMotor(this.banco, botId, resultado.sessao);
    const mensagem = concluirMensagem(this.banco, mensagemId, resultado.texto, resultado.estado);
    this.barramento.publicar({ tipo: 'turno_terminado', botId, mensagem });
  }
}
