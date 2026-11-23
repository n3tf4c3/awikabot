import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Mensagem } from '@awikabot/core';
import type { GestorDeAprovacoes } from './aprovacoes';
import type { Banco } from './banco';
import { gravarSessaoMotor, type BotInterno } from './bots';
import { concluirMensagem, inserirMensagem } from './conversa';
import type { Barramento } from './eventos';
import type { Ganchos } from './gancho';
import type { Motor, ResultadoMotor, TurnoEmCurso } from './motor';

export type InicioDeTurno =
  | { ok: true; usuario: Mensagem; bot: Mensagem }
  | { ok: false; motivo: 'turno_em_andamento' | 'limite_de_turnos' };

/** O que liga os turnos às aprovações. Sem isto, o motor nega o que pediria aprovação. */
export interface LigacaoDeAprovacoes {
  ganchos: Ganchos;
  aprovacoes: GestorDeAprovacoes;
  /** Linha de comando do gancho e a porta em loopback onde o servidor o atende. */
  comando: string;
  porta: number;
}

/** Dono dos turnos em curso: um por bot, e um teto para o servidor inteiro. */
export class GestorDeTurnos {
  private readonly ativos = new Map<string, TurnoEmCurso>();
  /** Texto já recebido de cada resposta em andamento, por id da mensagem. */
  private readonly parciais = new Map<string, string>();
  private readonly banco: Banco;
  private readonly motor: Motor;
  private readonly barramento: Barramento;
  private readonly limite: number;
  private readonly pastaDosBots: string;
  private readonly ligacao: LigacaoDeAprovacoes | null;

  constructor(deps: {
    banco: Banco;
    motor: Motor;
    barramento: Barramento;
    limite: number;
    pastaDosBots: string;
    aprovacoes?: LigacaoDeAprovacoes;
  }) {
    this.banco = deps.banco;
    this.motor = deps.motor;
    this.barramento = deps.barramento;
    this.limite = deps.limite;
    this.pastaDosBots = deps.pastaDosBots;
    this.ligacao = deps.aprovacoes ?? null;
  }

  ativo(botId: string): boolean {
    return this.ativos.has(botId);
  }

  /** O que já chegou de uma resposta em andamento; `undefined` se ela não está em curso. */
  textoParcial(mensagemId: string): string | undefined {
    return this.parciais.get(mensagemId);
  }

  iniciar(bot: BotInterno, texto: string): InicioDeTurno {
    if (this.ativos.has(bot.id)) return { ok: false, motivo: 'turno_em_andamento' };
    if (this.ativos.size >= this.limite) return { ok: false, motivo: 'limite_de_turnos' };

    // A pasta leva só o id gerado pelo servidor: nada vindo do app entra no caminho.
    const pasta = path.resolve(this.pastaDosBots, bot.id);
    mkdirSync(pasta, { recursive: true });

    const usuario = inserirMensagem(this.banco, { botId: bot.id, papel: 'usuario', texto, estado: 'completa' });
    const resposta = inserirMensagem(this.banco, { botId: bot.id, papel: 'bot', texto: '', estado: 'em_andamento' });

    const ligacao = this.ligacao;
    const token = ligacao?.ganchos.registrar({ botId: bot.id, mensagemId: resposta.id, pasta }) ?? null;

    this.parciais.set(resposta.id, '');
    const turno = this.motor({
      pasta,
      texto,
      instrucoes: bot.instrucoes,
      modelo: bot.modelo,
      sessao: bot.sessaoMotor,
      gancho: ligacao && token ? { comando: ligacao.comando, porta: ligacao.porta, token } : null,
      aoTexto: (trecho) => {
        const anterior = this.parciais.get(resposta.id) ?? '';
        this.parciais.set(resposta.id, anterior + trecho);
        this.barramento.publicar({ tipo: 'texto', botId: bot.id, mensagemId: resposta.id, posicao: anterior.length, trecho });
      },
    });
    this.ativos.set(bot.id, turno);
    this.barramento.publicar({ tipo: 'turno_iniciado', botId: bot.id, mensagemId: resposta.id });
    void turno.fim.then((resultado) => {
      this.concluir(bot.id, resposta.id, token, resultado);
    });

    return { ok: true, usuario, bot: resposta };
  }

  parar(botId: string): boolean {
    const turno = this.ativos.get(botId);
    if (!turno) return false;
    turno.parar();
    return true;
  }

  pararTodos(): void {
    for (const turno of this.ativos.values()) turno.parar();
  }

  private concluir(botId: string, mensagemId: string, token: string | null, resultado: ResultadoMotor): void {
    this.ativos.delete(botId);
    this.parciais.delete(mensagemId);
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
