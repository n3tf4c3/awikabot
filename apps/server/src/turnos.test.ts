// O gestor de turnos por dentro: o que vai para o banco enquanto a resposta chega, o que ele
// recusa quando o servidor está saindo, e o que sobra quando o começo de um turno falha.
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { GestorDeAprovacoes } from './aprovacoes';
import { abrirBanco, type Banco } from './banco';
import { criarBot } from './bots';
import { listarMensagens } from './conversa';
import { Barramento } from './eventos';
import { Ganchos } from './gancho';
import type { Motor, ResultadoMotor } from './motor';
import { criarMotorSimulado } from './motor-simulado';
import { GestorDeTurnos } from './turnos';

const pasta = mkdtempSync(path.join(os.tmpdir(), 'awikabot-turnos-'));
const bancos: Banco[] = [];
afterAll(() => {
  for (const banco of bancos) if (banco.isOpen) banco.close();
  rmSync(pasta, { recursive: true, force: true });
});

function novoBanco(): Banco {
  const banco = abrirBanco(':memory:');
  bancos.push(banco);
  return banco;
}

const esperar = async (condicao: () => boolean, limiteMs = 3000): Promise<void> => {
  const fim = Date.now() + limiteMs;
  while (!condicao() && Date.now() < fim) await new Promise((ok) => setTimeout(ok, 5));
  expect(condicao()).toBe(true);
};
const pausa = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));

/** Motor que o teste dirige: fala quando mandam e termina quando mandam. */
function criarMotorDirigido() {
  const turnos: { falar: (trecho: string) => void; terminar: (texto: string) => void; parado: boolean }[] = [];
  const motor: Motor = (pedido) => {
    let resolver: (resultado: ResultadoMotor) => void = () => {};
    const fim = new Promise<ResultadoMotor>((ok) => {
      resolver = ok;
    });
    const turno = {
      falar: (trecho: string) => pedido.aoTexto(trecho),
      terminar: (texto: string) => resolver({ estado: 'completa', texto, sessao: pedido.sessao }),
      parado: false,
    };
    turnos.push(turno);
    return {
      fim,
      parar: () => {
        turno.parado = true;
        // Como um processo de verdade, o motor leva um tempo para sair depois do pedido de parada.
        setTimeout(() => resolver({ estado: 'parada', texto: 'até aqui', sessao: pedido.sessao }), 40);
      },
    };
  };
  return { motor, turnos };
}

const mensagensDe = (banco: Banco, botId: string) => listarMensagens(banco, botId, null, 10).mensagens;

describe('texto de uma resposta em andamento', () => {
  it('um trecho seguido de silêncio vai para o banco no intervalo, sem esperar o trecho seguinte', async () => {
    const banco = novoBanco();
    const { motor, turnos: emCurso } = criarMotorDirigido();
    const turnos = new GestorDeTurnos({ banco, barramento: new Barramento(), motor, limite: 4, pastaDosBots: pasta, intervaloGravacaoMs: 20 });
    const bot = criarBot(banco, { nome: 'Scout', instrucoes: '', modelo: null });
    expect(turnos.iniciar(bot, 'oi').ok).toBe(true);

    emCurso[0]!.falar('primeira parte');
    // O motor se cala: nenhum trecho novo vem empurrar a gravação.
    await esperar(() => mensagensDe(banco, bot.id)[1]?.texto === 'primeira parte');
    expect(mensagensDe(banco, bot.id)[1]?.estado).toBe('em_andamento');
    expect(turnos.ativo(bot.id)).toBe(true);

    // O mesmo vale para o trecho que chega depois de uma gravação.
    emCurso[0]!.falar(', e a segunda');
    await esperar(() => mensagensDe(banco, bot.id)[1]?.texto === 'primeira parte, e a segunda');

    emCurso[0]!.terminar('primeira parte, e a segunda. Fim.');
    await esperar(() => !turnos.ativo(bot.id));
    // Depois do fim, o relógio da gravação não escreve por cima da resposta concluída.
    await pausa(60);
    expect(mensagensDe(banco, bot.id)[1]).toMatchObject({ texto: 'primeira parte, e a segunda. Fim.', estado: 'completa' });
  });

  it('sem texto novo, não grava de novo', async () => {
    const banco = novoBanco();
    const { motor, turnos: emCurso } = criarMotorDirigido();
    const turnos = new GestorDeTurnos({ banco, barramento: new Barramento(), motor, limite: 4, pastaDosBots: pasta, intervaloGravacaoMs: 15 });
    const bot = criarBot(banco, { nome: 'Scout', instrucoes: '', modelo: null });
    turnos.iniciar(bot, 'oi');
    emCurso[0]!.falar('uma vez só');
    await esperar(() => mensagensDe(banco, bot.id)[1]?.texto === 'uma vez só');

    const antes = Number((banco.prepare('SELECT total_changes() AS total').get() as { total: number }).total);
    await pausa(90);
    const depois = Number((banco.prepare('SELECT total_changes() AS total').get() as { total: number }).total);
    expect(depois).toBe(antes);
    emCurso[0]!.terminar('uma vez só');
    await esperar(() => !turnos.ativo(bot.id));
  });
});

describe('servidor saindo', () => {
  it('depois do pedido de parada, nenhum turno novo é aceito, e os que já rodavam fecham', async () => {
    const banco = novoBanco();
    const { motor, turnos: emCurso } = criarMotorDirigido();
    const turnos = new GestorDeTurnos({ banco, barramento: new Barramento(), motor, limite: 4, pastaDosBots: pasta });
    const um = criarBot(banco, { nome: 'Um', instrucoes: '', modelo: null });
    const dois = criarBot(banco, { nome: 'Dois', instrucoes: '', modelo: null });
    expect(turnos.iniciar(um, 'a').ok).toBe(true);

    // O motor demora a parar: é nessa espera que um pedido novo chegava e era aceito.
    const parada = turnos.pararTodos();
    expect(emCurso[0]!.parado).toBe(true);
    expect(turnos.ativo(um.id)).toBe(true);
    expect(turnos.iniciar(dois, 'b')).toEqual({ ok: false, motivo: 'servidor_encerrando' });
    expect(turnos.iniciar(um, 'c')).toEqual({ ok: false, motivo: 'servidor_encerrando' });
    await parada;

    expect(mensagensDe(banco, um.id).map((m) => [m.papel, m.estado, m.texto])).toEqual([
      ['usuario', 'completa', 'a'],
      ['bot', 'parada', 'até aqui'],
    ]);
    // O turno recusado não deixou mensagem nem motor rodando.
    expect(mensagensDe(banco, dois.id)).toEqual([]);
    expect(emCurso).toHaveLength(1);
    expect(turnos.iniciar(dois, 'd')).toEqual({ ok: false, motivo: 'servidor_encerrando' });
  });

  it('do turno que não fecha no prazo, o texto que já chegou vai para o banco antes de ele ser fechado', async () => {
    const banco = novoBanco();
    const { motor, turnos: emCurso } = criarMotorDirigido();
    // O intervalo é longo: sem a gravação do fim da parada, o trecho ficaria só na memória.
    const turnos = new GestorDeTurnos({ banco, barramento: new Barramento(), motor, limite: 4, pastaDosBots: pasta, intervaloGravacaoMs: 60_000 });
    const bot = criarBot(banco, { nome: 'Lento', instrucoes: '', modelo: null });
    turnos.iniciar(bot, 'a');
    emCurso[0]!.falar('o que já tinha chegado');

    await turnos.pararTodos(5);

    expect(turnos.ativo(bot.id)).toBe(true);
    expect(mensagensDe(banco, bot.id)[1]).toMatchObject({ estado: 'em_andamento', texto: 'o que já tinha chegado' });
    await esperar(() => !turnos.ativo(bot.id));
  });
});

describe('começo de turno que falha', () => {
  function comAprovacoes(banco: Banco, motor: Motor) {
    const barramento = new Barramento();
    const ganchos = new Ganchos();
    const tokens: string[] = [];
    const registrar = ganchos.registrar.bind(ganchos);
    ganchos.registrar = (turno) => {
      const token = registrar(turno);
      tokens.push(token);
      return token;
    };
    const turnos = new GestorDeTurnos({
      banco,
      barramento,
      motor,
      limite: 4,
      pastaDosBots: pasta,
      aprovacoes: { ganchos, aprovacoes: new GestorDeAprovacoes({ banco, barramento }), comando: 'gancho de teste', porta: 1 },
    });
    const tipos: string[] = [];
    barramento.assinar(undefined, (item) => tipos.push(item.evento.tipo));
    return { turnos, ganchos, tokens, tipos };
  }

  it('se a resposta em andamento não entra no banco, a mensagem da pessoa também não fica', async () => {
    const banco = novoBanco();
    const { turnos, tokens } = comAprovacoes(banco, criarMotorSimulado({ atrasoMs: 1 }));
    const bot = criarBot(banco, { nome: 'Scout', instrucoes: '', modelo: null });
    banco.exec(`CREATE TRIGGER falha_na_resposta BEFORE INSERT ON mensagens WHEN NEW.papel = 'bot'
      BEGIN SELECT RAISE(ABORT, 'falha injetada na segunda gravação'); END`);

    expect(() => turnos.iniciar(bot, 'oi')).toThrow(/falha injetada/);
    expect(mensagensDe(banco, bot.id)).toEqual([]);
    expect(turnos.ativo(bot.id)).toBe(false);
    expect(tokens).toEqual([]);

    // Passado o defeito, o bot aceita o turno, e a conversa começa do primeiro número.
    banco.exec('DROP TRIGGER falha_na_resposta');
    const inicio = turnos.iniciar(bot, 'oi de novo');
    expect(inicio.ok && [inicio.usuario.seq, inicio.bot.seq]).toEqual([1, 2]);
    await esperar(() => !turnos.ativo(bot.id));
  });

  it('se o motor quebra ao iniciar, a resposta fica como falha, o token do gancho some e o bot aceita o turno seguinte', async () => {
    const banco = novoBanco();
    let chamadas = 0;
    const simulado = criarMotorSimulado({ atrasoMs: 1 });
    const motor: Motor = (pedido) => {
      chamadas += 1;
      if (chamadas === 1) throw new Error('o driver quebrou ao subir o processo');
      return simulado(pedido);
    };
    const { turnos, ganchos, tokens, tipos } = comAprovacoes(banco, motor);
    const bot = criarBot(banco, { nome: 'Scout', instrucoes: '', modelo: null });

    const inicio = turnos.iniciar(bot, 'oi');
    expect(inicio.ok).toBe(true);
    await esperar(() => !turnos.ativo(bot.id));
    expect(mensagensDe(banco, bot.id).map((m) => [m.papel, m.estado])).toEqual([
      ['usuario', 'completa'],
      ['bot', 'falhou'],
    ]);
    expect(mensagensDe(banco, bot.id)[1]?.texto).toBe('O motor não conseguiu começar este turno.');
    // Quem acompanha pelo fluxo de eventos vê o turno abrir e fechar, como qualquer outro.
    expect(tipos).toEqual(['turno_iniciado', 'turno_terminado']);
    expect(tokens).toHaveLength(1);
    expect(ganchos.obter(tokens[0]!)).toBeUndefined();
    if (inicio.ok) expect(turnos.textoParcial(inicio.bot.id)).toBeUndefined();

    expect(turnos.iniciar(bot, 'de novo').ok).toBe(true);
    await esperar(() => !turnos.ativo(bot.id));
    expect(mensagensDe(banco, bot.id).map((m) => m.estado)).toEqual(['completa', 'falhou', 'completa', 'completa']);
  });
});
