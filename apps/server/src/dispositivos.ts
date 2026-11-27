import { isIP } from 'node:net';
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

/** Os oito grupos de um IPv6 já validado, sem zeros à esquerda, com o IPv4 do fim em dois grupos. */
function gruposIpv6(endereco: string): string[] {
  let texto = endereco;
  const ipv4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(texto);
  if (ipv4) {
    const [a, b, c, d] = ipv4.slice(1).map(Number) as [number, number, number, number];
    texto = `${texto.slice(0, ipv4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [antes = '', depois] = texto.split('::');
  const cabeca = antes === '' ? [] : antes.split(':');
  const cauda = depois === undefined || depois === '' ? [] : depois.split(':');
  const meio = depois === undefined ? [] : Array<string>(8 - cabeca.length - cauda.length).fill('0');
  return [...cabeca, ...meio, ...cauda].map((grupo) => parseInt(grupo, 16).toString(16));
}

/** A chave de um endereço: o IPv4 inteiro, o IPv6 pelo /64. `null` se não é endereço. */
function chaveDoEndereco(bruto: string | undefined): string | null {
  const endereco = bruto?.trim().replace(/%.*$/, '') ?? '';
  if (isIP(endereco) === 4) return endereco;
  if (isIP(endereco) !== 6) return null;
  const grupos = gruposIpv6(endereco);
  // O Node entrega o IPv4 de um soquete de dupla pilha como `::ffff:a.b.c.d`.
  if (grupos.slice(0, 5).every((grupo) => grupo === '0') && grupos[5] === 'ffff') {
    const [alto, baixo] = grupos.slice(6).map((grupo) => parseInt(grupo, 16)) as [number, number];
    return [alto >> 8, alto & 0xff, baixo >> 8, baixo & 0xff].join('.');
  }
  return `${grupos.slice(0, 4).join(':')}::/64`;
}

/**
 * De onde vem um pedido de pareamento, para a trava. Pelo túnel, toda conexão é a do cloudflared, e
 * quem pediu vem no `CF-Connecting-IP`, que a Cloudflare escreve por cima do que o cliente mandar.
 * Sem esse cabeçalho, ou com um valor que não é endereço, vale o endereço da conexão. O IPv6 conta
 * pelo /64, que costuma ser inteiro de uma pessoa: cada endereço dele seria uma origem nova.
 *
 * O cabeçalho só é de confiança porque o servidor só se alcança pelo túnel e por loopback. Quem abre
 * a porta para a rede local deixa um vizinho trocar de origem a cada pedido; aí vale só o teto do
 * servidor inteiro, e o código, com 60 bits e cinco minutos de validade, continua impossível de adivinhar.
 */
export function origemDoPedido(cabecalhoDaCloudflare: string | undefined, conexao: string | undefined): string {
  return chaveDoEndereco(cabecalhoDaCloudflare) ?? chaveDoEndereco(conexao) ?? 'desconhecida';
}

/**
 * Trava o pareamento depois de tentativas erradas: cinco erros de uma origem travam essa origem, e
 * mil erros no servidor inteiro travam todas, na mesma janela de dez minutos. Uma trava só, para o
 * servidor inteiro, deixava qualquer um de fora bloquear o pareamento de todos com cinco pedidos.
 *
 * O teto do servidor não é o que impede adivinhar o código: com 60 bits, mil tentativas acertam um
 * código vivo com chance da ordem de 1e-15. Ele limita o que um atacante com muitas origens consegue,
 * e também a memória, porque um erro só entra depois de `bloqueado` dizer que não.
 */
export class LimitadorDeTentativas {
  private readonly porOrigem = new Map<string, number[]>();
  private todas: number[] = [];
  private readonly maximoPorOrigem: number;
  private readonly maximoTotal: number;
  private readonly janelaMs: number;

  constructor(opcoes: { porOrigem?: number; total?: number; janelaMs?: number } = {}) {
    this.maximoPorOrigem = opcoes.porOrigem ?? 5;
    this.maximoTotal = opcoes.total ?? 1000;
    this.janelaMs = opcoes.janelaMs ?? 10 * 60_000;
  }

  bloqueado(origem: string, agora = Date.now()): boolean {
    this.esquecer(agora);
    return this.todas.length >= this.maximoTotal || (this.porOrigem.get(origem)?.length ?? 0) >= this.maximoPorOrigem;
  }

  registrarFalha(origem: string, agora = Date.now()): void {
    this.esquecer(agora);
    this.todas.push(agora);
    this.porOrigem.set(origem, [...(this.porOrigem.get(origem) ?? []), agora]);
  }

  /** Quantas origens têm erro dentro da janela. */
  get origensGuardadas(): number {
    return this.porOrigem.size;
  }

  /** Tira o que saiu da janela; a origem sem erro nela deixa de ser guardada. */
  private esquecer(agora: number): void {
    const dentro = (instante: number): boolean => agora - instante < this.janelaMs;
    this.todas = this.todas.filter(dentro);
    for (const [origem, instantes] of this.porOrigem) {
      const restantes = instantes.filter(dentro);
      if (restantes.length === 0) this.porOrigem.delete(origem);
      else this.porOrigem.set(origem, restantes);
    }
  }
}
