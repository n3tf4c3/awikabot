import { ESPERA_APROVACAO_MS, type Aprovacao } from '@awikabot/core';
import type { Banco } from './banco';
import type { Barramento } from './eventos';
import { novoId } from './ids';

interface LinhaAprovacao {
  id: string;
  bot_id: string;
  mensagem_id: string;
  ferramenta: string;
  resumo: string;
  estado: Aprovacao['estado'];
  criada_em: number;
  resolvida_em: number | null;
}

const COLUNAS = 'id, bot_id, mensagem_id, ferramenta, resumo, estado, criada_em, resolvida_em';

function deLinha(linha: LinhaAprovacao): Aprovacao {
  return {
    id: linha.id,
    botId: linha.bot_id,
    mensagemId: linha.mensagem_id,
    ferramenta: linha.ferramenta,
    resumo: linha.resumo,
    estado: linha.estado,
    criadaEm: linha.criada_em,
    resolvidaEm: linha.resolvida_em,
  };
}

export type Decisao = 'aprovar' | 'negar';

/** Na partida do servidor: quem esperava resposta morreu com o processo anterior. */
export function expirarPendentesNaPartida(banco: Banco, agora = Date.now()): number {
  const resultado = banco
    .prepare("UPDATE aprovacoes SET estado = 'expirada', resolvida_em = ? WHERE estado = 'pendente'")
    .run(agora);
  return Number(resultado.changes);
}

/** Guarda os pedidos de aprovação, avisa os apps e segura o motor até a pessoa decidir. */
export class GestorDeAprovacoes {
  private readonly esperas = new Map<string, { resolver: (decisao: Decisao) => void; relogio: NodeJS.Timeout }>();
  private readonly banco: Banco;
  private readonly barramento: Barramento;
  private readonly esperaMs: number;

  constructor(deps: { banco: Banco; barramento: Barramento; esperaMs?: number }) {
    this.banco = deps.banco;
    this.barramento = deps.barramento;
    this.esperaMs = deps.esperaMs ?? ESPERA_APROVACAO_MS;
  }

  /** Cria o pedido e espera a decisão. Sempre resolve: sem resposta a tempo, resolve como negado. */
  pedir(dados: { botId: string; mensagemId: string; ferramenta: string; resumo: string }): Promise<Decisao> {
    const linha = this.banco
      .prepare(
        `INSERT INTO aprovacoes (id, bot_id, mensagem_id, ferramenta, resumo, estado, criada_em)
         VALUES (?, ?, ?, ?, ?, 'pendente', ?) RETURNING ${COLUNAS}`,
      )
      .get(novoId(), dados.botId, dados.mensagemId, dados.ferramenta, dados.resumo, Date.now()) as unknown as LinhaAprovacao;
    const aprovacao = deLinha(linha);

    return new Promise<Decisao>((resolver) => {
      const relogio = setTimeout(() => {
        this.encerrar(aprovacao.id, 'expirada', null);
      }, this.esperaMs);
      this.esperas.set(aprovacao.id, { resolver, relogio });
      this.barramento.publicar({ tipo: 'aprovacao_pedida', aprovacao });
    });
  }

  decidir(id: string, decisao: Decisao, dispositivoId: string): Aprovacao | 'nao_encontrado' | 'ja_resolvida' {
    const existe = this.banco.prepare('SELECT 1 FROM aprovacoes WHERE id = ?').get(id);
    if (!existe) return 'nao_encontrado';
    return this.encerrar(id, decisao === 'aprovar' ? 'aprovada' : 'negada', dispositivoId) ?? 'ja_resolvida';
  }

  /** Fim do turno: o que ainda esperava resposta não vai mais rodar. */
  expirarDaMensagem(mensagemId: string): void {
    const pendentes = this.banco
      .prepare("SELECT id FROM aprovacoes WHERE mensagem_id = ? AND estado = 'pendente'")
      .all(mensagemId) as unknown as { id: string }[];
    for (const pendente of pendentes) this.encerrar(pendente.id, 'expirada', null);
  }

  pendentes(): Aprovacao[] {
    const linhas = this.banco
      .prepare(`SELECT ${COLUNAS} FROM aprovacoes WHERE estado = 'pendente' ORDER BY criada_em, id`)
      .all() as unknown as LinhaAprovacao[];
    return linhas.map(deLinha);
  }

  /**
   * Os pedidos já resolvidos que surgiram nestas mensagens, do mais antigo para o mais novo. É o
   * que o histórico da conversa mostra de cada um; o pendente fica de fora, porque já tem lista
   * e evento próprios.
   */
  resolvidasDasMensagens(mensagemIds: readonly string[]): Aprovacao[] {
    if (mensagemIds.length === 0) return [];
    const marcas = mensagemIds.map(() => '?').join(', ');
    const linhas = this.banco
      .prepare(`SELECT ${COLUNAS} FROM aprovacoes WHERE mensagem_id IN (${marcas}) AND estado <> 'pendente' ORDER BY criada_em, id`)
      .all(...mensagemIds) as unknown as LinhaAprovacao[];
    return linhas.map(deLinha);
  }

  /** Tira o pedido de `pendente` uma única vez: com dois aparelhos decidindo juntos, só o primeiro vale. */
  private encerrar(id: string, estado: Exclude<Aprovacao['estado'], 'pendente'>, dispositivoId: string | null): Aprovacao | null {
    const linha = this.banco
      .prepare(
        `UPDATE aprovacoes SET estado = ?, resolvida_em = ?, resolvida_por = ?
         WHERE id = ? AND estado = 'pendente' RETURNING ${COLUNAS}`,
      )
      .get(estado, Date.now(), dispositivoId, id) as unknown as LinhaAprovacao | undefined;
    if (!linha) return null;

    const aprovacao = deLinha(linha);
    const espera = this.esperas.get(id);
    if (espera) {
      clearTimeout(espera.relogio);
      this.esperas.delete(id);
      espera.resolver(estado === 'aprovada' ? 'aprovar' : 'negar');
    }
    this.barramento.publicar({ tipo: 'aprovacao_resolvida', aprovacao });
    return aprovacao;
  }
}
