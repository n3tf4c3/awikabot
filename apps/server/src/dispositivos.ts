import type { Dispositivo } from '@awikabot/core';
import type { Banco } from './banco';
import { formatarCodigo, novoCodigo, novoId, novoToken, resumo } from './ids';

export const VALIDADE_CODIGO_MS = 5 * 60_000;

interface LinhaDispositivo {
  id: string;
  nome: string;
  criado_em: number;
  visto_em: number | null;
  revogado_em: number | null;
}

/** Cria um código de uso único. O banco guarda só o hash dele. */
export function criarCodigo(banco: Banco, agora = Date.now()): string {
  banco.prepare('DELETE FROM codigos_pareamento WHERE expira_em <= ? OR usado_em IS NOT NULL').run(agora);
  const codigo = novoCodigo();
  banco
    .prepare('INSERT INTO codigos_pareamento (codigo_hash, expira_em) VALUES (?, ?)')
    .run(resumo(codigo), agora + VALIDADE_CODIGO_MS);
  return formatarCodigo(codigo);
}

/** Troca um código válido por um token de aparelho. `codigo` já vem normalizado pelo contrato. */
export function parear(
  banco: Banco,
  codigo: string,
  nome: string,
  agora = Date.now(),
): { token: string; dispositivo: Dispositivo } | null {
  // O UPDATE condicional consome o código de forma atômica: dois pedidos com o mesmo código não passam os dois.
  const consumo = banco
    .prepare('UPDATE codigos_pareamento SET usado_em = ? WHERE codigo_hash = ? AND usado_em IS NULL AND expira_em > ?')
    .run(agora, resumo(codigo), agora);
  if (Number(consumo.changes) !== 1) return null;

  const token = novoToken();
  const dispositivo: Dispositivo = { id: novoId(), nome, criadoEm: agora };
  banco
    .prepare('INSERT INTO dispositivos (id, nome, token_hash, criado_em) VALUES (?, ?, ?, ?)')
    .run(dispositivo.id, nome, resumo(token), agora);
  return { token, dispositivo };
}

export function autenticar(banco: Banco, token: string, agora = Date.now()): Dispositivo | null {
  const linha = banco
    .prepare('SELECT id, nome, criado_em FROM dispositivos WHERE token_hash = ? AND revogado_em IS NULL')
    .get(resumo(token)) as unknown as Pick<LinhaDispositivo, 'id' | 'nome' | 'criado_em'> | undefined;
  if (!linha) return null;
  banco.prepare('UPDATE dispositivos SET visto_em = ? WHERE id = ?').run(agora, linha.id);
  return { id: linha.id, nome: linha.nome, criadoEm: linha.criado_em };
}

/** Só consulta: o aparelho ainda existe e não foi revogado? Barato o bastante para rodar a cada evento. */
export function dispositivoAtivo(banco: Banco, id: string): boolean {
  return banco.prepare('SELECT 1 FROM dispositivos WHERE id = ? AND revogado_em IS NULL').get(id) !== undefined;
}

export interface DispositivoAdmin extends Dispositivo {
  vistoEm: number | null;
  revogadoEm: number | null;
}

export function listarDispositivos(banco: Banco): DispositivoAdmin[] {
  const linhas = banco
    .prepare('SELECT id, nome, criado_em, visto_em, revogado_em FROM dispositivos ORDER BY criado_em, id')
    .all() as unknown as LinhaDispositivo[];
  return linhas.map((linha) => ({
    id: linha.id,
    nome: linha.nome,
    criadoEm: linha.criado_em,
    vistoEm: linha.visto_em,
    revogadoEm: linha.revogado_em,
  }));
}

export function revogar(banco: Banco, id: string, agora = Date.now()): boolean {
  const resultado = banco
    .prepare('UPDATE dispositivos SET revogado_em = ? WHERE id = ? AND revogado_em IS NULL')
    .run(agora, id);
  return Number(resultado.changes) === 1;
}

/** Trava o pareamento depois de várias tentativas erradas, para o servidor inteiro. */
export class LimitadorDeTentativas {
  private falhas: number[] = [];
  private readonly maximo: number;
  private readonly janelaMs: number;

  constructor(maximo = 5, janelaMs = 10 * 60_000) {
    this.maximo = maximo;
    this.janelaMs = janelaMs;
  }

  bloqueado(agora = Date.now()): boolean {
    this.falhas = this.falhas.filter((instante) => agora - instante < this.janelaMs);
    return this.falhas.length >= this.maximo;
  }

  registrarFalha(agora = Date.now()): void {
    this.falhas.push(agora);
  }
}
