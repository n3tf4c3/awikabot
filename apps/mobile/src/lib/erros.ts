import { EsquemaErro } from '@awikabot/core';

/**
 * Erro de uma chamada ao servidor. `codigo` é o código estável que veio no corpo
 * (`EsquemaErro`) ou um dos códigos do próprio app, quando não houve resposta útil.
 */
export class ErroApi extends Error {
  readonly codigo: string;
  /** Status HTTP, ou `null` quando o servidor não chegou a responder. */
  readonly status: number | null;

  constructor(codigo: string, status: number | null) {
    super(codigo);
    this.name = 'ErroApi';
    this.codigo = codigo;
    this.status = status;
  }
}

/** Códigos que nascem no app, sem corpo de erro do servidor. */
export const CODIGOS_DO_APP = {
  rede: 'rede',
  tempoEsgotado: 'tempo_esgotado',
  respostaInvalida: 'resposta_invalida',
  erroHttp: 'erro_http',
  /** 401 sem o corpo do contrato: quem respondeu foi um proxy, um túnel ou uma página de login. */
  recusaNoCaminho: 'recusa_no_caminho',
} as const;

/** O código de erro de um corpo no formato do contrato (`EsquemaErro`), ou `null` se o corpo é outra coisa. */
export function codigoDoCorpo(texto: string): string | null {
  try {
    const lido = EsquemaErro.safeParse(JSON.parse(texto));
    return lido.success ? lido.data.erro : null;
  } catch {
    return null;
  }
}

/**
 * Só este corpo num 401 quer dizer que o servidor recusou o token. Qualquer outro 401 (HTML de
 * um proxy, de um túnel) é falha passageira e não desfaz o pareamento.
 */
export function ehRecusaDoToken(status: number, corpo: string): boolean {
  return status === 401 && codigoDoCorpo(corpo) === 'nao_autenticado';
}

const MENSAGENS: Readonly<Record<string, string>> = {
  codigo_invalido: 'Código de pareamento inválido. Confira o código ou gere um novo no servidor.',
  muitas_tentativas: 'Muitas tentativas de pareamento. Espere um pouco e tente de novo.',
  dados_invalidos: 'O servidor recusou os dados enviados. Confira os campos e tente de novo.',
  json_invalido: 'O servidor recusou os dados enviados. Confira os campos e tente de novo.',
  corpo_grande_demais: 'O texto é grande demais para o servidor. Encurte e tente de novo.',
  nao_autenticado: 'Este aparelho não está mais pareado com o servidor. Pareie de novo.',
  nao_encontrado: 'Este bot não existe mais no servidor.',
  turno_em_andamento: 'O bot ainda está respondendo. Espere terminar ou toque em Parar.',
  limite_de_turnos: 'O servidor já está com o máximo de respostas em andamento. Tente de novo em instantes.',
  sem_turno_ativo: 'O bot já terminou de responder.',
  erro_interno: 'O servidor encontrou um erro. Tente de novo.',
  [CODIGOS_DO_APP.rede]: 'Não foi possível falar com o servidor. Confira o endereço e a conexão.',
  [CODIGOS_DO_APP.tempoEsgotado]: 'O servidor demorou demais para responder. Tente de novo.',
  [CODIGOS_DO_APP.respostaInvalida]:
    'O servidor respondeu de um jeito que este app não entende. Confira se o app e o servidor estão na mesma versão.',
  [CODIGOS_DO_APP.recusaNoCaminho]:
    'O acesso foi recusado antes de chegar ao servidor awikabot. Confira o endereço e o túnel ou proxy no caminho.',
};

/** Texto de tela para um código de erro. Código desconhecido vira uma frase genérica com o status. */
export function mensagemDoCodigo(codigo: string, status: number | null = null): string {
  const conhecida = MENSAGENS[codigo];
  if (conhecida !== undefined) return conhecida;
  return status === null
    ? 'Algo deu errado. Tente de novo.'
    : `O servidor respondeu com um erro inesperado (${status}). Tente de novo.`;
}

/** Texto de tela para qualquer coisa capturada num `catch`. */
export function mensagemDeErro(erro: unknown): string {
  if (erro instanceof ErroApi) return mensagemDoCodigo(erro.codigo, erro.status);
  return 'Algo deu errado. Tente de novo.';
}

export function temCodigo(erro: unknown, codigo: string): boolean {
  return erro instanceof ErroApi && erro.codigo === codigo;
}
