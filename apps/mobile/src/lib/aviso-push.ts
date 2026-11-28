import { EsquemaAvisoDoDispositivo, EsquemaBot } from '@awikabot/core';

/** Como terminou a tentativa de deixar o aparelho pronto para receber aviso com o app fechado. */
export type SituacaoDoAviso =
  /** O app foi montado sem projeto na conta Expo: o serviço de push não tem como dar um endereço. */
  | 'sem_projeto'
  /** Simulador ou emulador: não recebem aviso push. */
  | 'sem_aparelho'
  /** A pessoa não deixou o app mostrar avisos. */
  | 'sem_permissao'
  | 'registrado'
  /** O serviço de push ou o servidor não responderam como deviam; tenta de novo na próxima abertura. */
  | 'falhou';

export type Permissao = 'granted' | 'denied' | 'undetermined';

/** O que o fluxo usa do sistema e do servidor. Na tela vem do `expo-notifications`; no teste, de mentira. */
export interface RecursosDoAviso {
  /** O id do projeto na conta Expo, que o serviço de push exige; \`null\` quando o app não tem projeto. */
  projetoExpo: string | null;
  ehAparelho: boolean;
  /** Prepara o que o sistema pede antes de perguntar, como o canal de avisos do Android. */
  preparar(): Promise<void>;
  permissao(): Promise<Permissao>;
  pedirPermissao(): Promise<Permissao>;
  /** O endereço de aviso deste aparelho, que o serviço de push da Expo entrega. */
  obterEndereco(projetoExpo: string): Promise<string>;
  registrar(endereco: string): Promise<void>;
}

/**
 * Deixa o aparelho pronto para receber o aviso de pedido de aprovação com o app fechado: pede a
 * permissão, se ainda não foi pedida, pega o endereço no serviço de push da Expo e o entrega ao
 * servidor. Roda a cada abertura do app com sessão, porque o endereço pode mudar. Nunca rejeita:
 * sem aviso, o app funciona como antes, com os pedidos à vista só com ele aberto.
 */
export async function prepararAviso(recursos: RecursosDoAviso): Promise<SituacaoDoAviso> {
  if (recursos.projetoExpo === null) return 'sem_projeto';
  if (!recursos.ehAparelho) return 'sem_aparelho';
  try {
    await recursos.preparar();
    let permissao = await recursos.permissao();
    // Só pergunta quem ainda não respondeu: depois de um "não", quem muda é a pessoa, nos ajustes.
    if (permissao === 'undetermined') permissao = await recursos.pedirPermissao();
    if (permissao !== 'granted') return 'sem_permissao';
    const endereco = await recursos.obterEndereco(recursos.projetoExpo);
    const lido = EsquemaAvisoDoDispositivo.safeParse({ endereco });
    if (!lido.success) return 'falhou';
    await recursos.registrar(lido.data.endereco);
    return 'registrado';
  } catch {
    return 'falhou';
  }
}

/**
 * O bot da conversa que o toque num aviso abre. O que vem no aviso passou por terceiros: só vale um
 * id no formato do contrato, e o resto é ignorado.
 */
export function botDoAviso(dados: unknown): string | null {
  if (typeof dados !== 'object' || dados === null) return null;
  const lido = EsquemaBot.shape.id.safeParse((dados as { botId?: unknown }).botId);
  return lido.success ? lido.data : null;
}
