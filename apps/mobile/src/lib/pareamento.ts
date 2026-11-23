import {
  EsquemaPedidoPareamento,
  LIMITES,
  VERSAO_PROTOCOLO,
  type PedidoPareamento,
  type RespostaPareamento,
} from '@awikabot/core';
import type { Api } from './api';
import { mensagemDoEndereco, normalizarEnderecoServidor } from './endereco-servidor';
import { mensagemDeErro } from './erros';
import type { GuardaSessao } from './sessao';

/** Os campos da tela de pareamento, como a pessoa digita. */
export interface CamposPareamento {
  endereco: string;
  codigo: string;
  nome: string;
}

export type ErrosPareamento = Partial<Record<keyof CamposPareamento, string>>;

export const NOME_PADRAO_DO_APARELHO = 'Meu celular';

const MENSAGENS = {
  codigo: 'O código de pareamento tem 12 caracteres: letras de A a Z e números de 2 a 7.',
  nome: `Informe um nome com até ${LIMITES.nomeDispositivo} caracteres.`,
} as const;

/** Valida os três campos e devolve o endereço normalizado e o corpo de `POST /v1/parear`. */
export function validarPareamento(
  campos: CamposPareamento,
): { ok: true; servidor: string; pedido: PedidoPareamento } | { ok: false; erros: ErrosPareamento } {
  const erros: ErrosPareamento = {};
  const endereco = normalizarEnderecoServidor(campos.endereco);
  if (!endereco.ok) erros.endereco = mensagemDoEndereco(endereco.motivo);

  const pedido = EsquemaPedidoPareamento.safeParse({ codigo: campos.codigo, nome: campos.nome });
  if (!pedido.success) {
    for (const problema of pedido.error.issues) {
      const campo = problema.path[0];
      if (campo === 'codigo' || campo === 'nome') erros[campo] = MENSAGENS[campo];
    }
  }

  if (!endereco.ok || !pedido.success) return { ok: false, erros };
  return { ok: true, servidor: endereco.url, pedido: pedido.data };
}

/** Frase para quando o servidor fala outra versão do contrato. */
export function mensagemDeProtocolo(doServidor: number): string {
  return (
    `Este app e o servidor falam versões diferentes do protocolo (app: ${VERSAO_PROTOCOLO}, servidor: ${doServidor}). ` +
    'Atualize o app ou o servidor e pareie de novo com um código novo.'
  );
}

export const FALHA_AO_GUARDAR =
  'O servidor aceitou o código, mas não foi possível guardar o acesso neste aparelho. Gere outro código e tente de novo.';

/** `erros` aponta os campos a corrigir; `falha` é o que deu errado depois de falar com o servidor. */
export type ResultadoPareamento = { ok: true } | { ok: false; erros: ErrosPareamento; falha: string | null };

/**
 * Pareia o aparelho: valida os campos, troca o código pelo token e guarda a sessão.
 * Se o servidor fala outra versão do protocolo, a sessão não é guardada. O token que não vai ser
 * usado (protocolo diferente, falha ao guardar) é revogado no servidor por melhor esforço, para
 * não sobrar um acesso válido que ninguém tem.
 */
export async function parearAparelho(
  api: Pick<Api, 'parear' | 'revogarDispositivo'>,
  guarda: Pick<GuardaSessao, 'entrar'>,
  campos: CamposPareamento,
): Promise<ResultadoPareamento> {
  const lido = validarPareamento(campos);
  if (!lido.ok) return { ok: false, erros: lido.erros, falha: null };

  let resposta: RespostaPareamento;
  try {
    resposta = await api.parear(lido.servidor, lido.pedido);
  } catch (erro) {
    return { ok: false, erros: {}, falha: mensagemDeErro(erro) };
  }
  const credencial = { servidor: lido.servidor, token: resposta.token };

  if (resposta.servidor.protocolo !== VERSAO_PROTOCOLO) {
    await api.revogarDispositivo(credencial).catch(() => {});
    return { ok: false, erros: {}, falha: mensagemDeProtocolo(resposta.servidor.protocolo) };
  }

  try {
    await guarda.entrar({ ...credencial, dispositivo: resposta.dispositivo });
  } catch {
    await api.revogarDispositivo(credencial).catch(() => {});
    return { ok: false, erros: {}, falha: FALHA_AO_GUARDAR };
  }
  return { ok: true };
}

/**
 * Despareia: pede ao servidor que invalide o token (melhor esforço, com tempo limite curto) e
 * esquece a sessão no aparelho, tenha o servidor respondido ou não.
 */
export async function desparearAparelho(
  api: Pick<Api, 'revogarDispositivo'>,
  guarda: Pick<GuardaSessao, 'estado' | 'sair'>,
): Promise<void> {
  const sessao = guarda.estado().sessao;
  if (sessao !== null) await api.revogarDispositivo(sessao).catch(() => {});
  await guarda.sair();
}
