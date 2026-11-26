import { MOTOR_PADRAO, type Catalogo, type MotorDoCatalogo } from '@awikabot/core';
import type { CamposBot } from './formulario-bot';

/** Um item de uma lista do formulário. `valor` é o que vai para o campo; vazio é o padrão do motor. */
export interface OpcaoDaLista {
  valor: string;
  rotulo: string;
}

/** O primeiro item da lista de modelos: o bot sem modelo, que fica com o padrão do motor. */
export const OPCAO_AUTO: OpcaoDaLista = { valor: '', rotulo: 'Auto' };
/** O primeiro item da lista de esforços. */
export const OPCAO_ESFORCO_PADRAO: OpcaoDaLista = { valor: '', rotulo: 'Padrão' };
/** O último item da lista de modelos: abre o campo para digitar um modelo que a lista não tem. */
export const ROTULO_OUTRO_MODELO = 'Outro';

/** O motor com esse id, ou `null`. Sem catálogo (servidor anterior a ele, ou fora do ar), não há nenhum. */
export function motorDoCatalogo(catalogo: Catalogo | null, id: string): MotorDoCatalogo | null {
  return catalogo?.motores.find((motor) => motor.id === id) ?? null;
}

/** O nome do motor para a tela; sem catálogo, o próprio id. */
export function nomeDoMotor(catalogo: Catalogo | null, id: string): string {
  return motorDoCatalogo(catalogo, id)?.nome ?? id;
}

/**
 * Os motores em que dá para criar um bot: os prontos, da família dos agentes. Sem catálogo, ou
 * com um catálogo sem nenhum assim, só o motor padrão, que é o que o servidor usa quando o
 * pedido não diz.
 */
export function motoresParaCriar(catalogo: Catalogo | null): OpcaoDaLista[] {
  const prontos = (catalogo?.motores ?? []).filter((motor) => motor.pronto && motor.familia === 'agente');
  if (prontos.length === 0) return [{ valor: MOTOR_PADRAO, rotulo: nomeDoMotor(catalogo, MOTOR_PADRAO) }];
  return prontos.map((motor) => ({ valor: motor.id, rotulo: motor.nome }));
}

/** "Auto" e os modelos que o catálogo sugere para o motor, nessa ordem. "Outro" é um item à parte. */
export function opcoesDeModelo(catalogo: Catalogo | null, motor: string): OpcaoDaLista[] {
  const sugeridos = motorDoCatalogo(catalogo, motor)?.modelos ?? [];
  return [OPCAO_AUTO, ...sugeridos.map((modelo) => ({ valor: modelo.id, rotulo: modelo.nome }))];
}

/**
 * "Padrão" e os esforços do motor. Só "Padrão" quer dizer que o motor não aceita escolher o
 * esforço, e a tela não mostra a lista. O esforço `atual` do bot, se o catálogo não o tiver (um
 * servidor sem catálogo, por exemplo), entra no fim com o próprio id, para a tela não o esconder.
 */
export function opcoesDeEsforco(catalogo: Catalogo | null, motor: string, atual = ''): OpcaoDaLista[] {
  const esforcos = motorDoCatalogo(catalogo, motor)?.esforcos ?? [];
  const opcoes = [OPCAO_ESFORCO_PADRAO, ...esforcos.map((esforco) => ({ valor: esforco.id, rotulo: esforco.nome }))];
  return opcoes.some((opcao) => opcao.valor === atual) ? opcoes : [...opcoes, { valor: atual, rotulo: atual }];
}

/**
 * O modelo foi digitado, e não escolhido na lista: não está vazio e não é um dos sugeridos.
 * É assim que o formulário abre um bot com um modelo fora do catálogo: no "Outro", com o texto dele.
 */
export function modeloDigitado(modelo: string, opcoes: readonly OpcaoDaLista[]): boolean {
  const aparado = modelo.trim();
  return aparado !== '' && !opcoes.some((opcao) => opcao.valor === aparado);
}

/** O estado do formulário: os campos e se o modelo está sendo digitado ("Outro"). */
export interface EstadoDoFormulario {
  campos: CamposBot;
  digitarModelo: boolean;
}

export function estadoInicial(campos: CamposBot, catalogo: Catalogo | null): EstadoDoFormulario {
  return { campos, digitarModelo: modeloDigitado(campos.modelo, opcoesDeModelo(catalogo, campos.motor)) };
}

/**
 * O catálogo chegou depois de o formulário abrir. Enquanto a pessoa não mexeu na lista de modelos,
 * o "Outro" é decidido de novo: um modelo que agora está na lista deixa de parecer digitado.
 */
export function aoChegarCatalogo(estado: EstadoDoFormulario, catalogo: Catalogo | null): EstadoDoFormulario {
  return estadoInicial(estado.campos, catalogo);
}

/** Um item da lista de modelos: o campo fica com o valor dele, e o texto digitado some. */
export function escolherModelo(estado: EstadoDoFormulario, valor: string): EstadoDoFormulario {
  return { campos: { ...estado.campos, modelo: valor }, digitarModelo: false };
}

/** "Outro": abre o campo de texto. Um modelo já digitado continua; um escolhido na lista dá lugar ao campo vazio. */
export function digitarOutroModelo(estado: EstadoDoFormulario, catalogo: Catalogo | null): EstadoDoFormulario {
  const opcoes = opcoesDeModelo(catalogo, estado.campos.motor);
  const modelo = modeloDigitado(estado.campos.modelo, opcoes) ? estado.campos.modelo : '';
  return { campos: { ...estado.campos, modelo }, digitarModelo: true };
}

/**
 * Outro motor, só na criação. O modelo e o esforço escolhidos nas listas são do motor anterior e
 * voltam ao padrão, a menos que o outro motor também os tenha; um modelo digitado fica, porque o
 * formato vale para qualquer motor.
 */
export function escolherMotor(estado: EstadoDoFormulario, catalogo: Catalogo | null, motor: string): EstadoDoFormulario {
  if (motor === estado.campos.motor) return estado;
  const daLista = opcoesDeModelo(catalogo, motor).some((opcao) => opcao.valor === estado.campos.modelo);
  const modelo = estado.digitarModelo || daLista ? estado.campos.modelo : '';
  const esforcos = opcoesDeEsforco(catalogo, motor);
  const esforco = esforcos.some((opcao) => opcao.valor === estado.campos.esforco) ? estado.campos.esforco : '';
  return { campos: { ...estado.campos, motor, modelo, esforco }, digitarModelo: estado.digitarModelo };
}

/** O item marcado na lista de modelos: o valor do modelo, ou `null` quando é o "Outro". */
export function modeloMarcado(estado: EstadoDoFormulario): string | null {
  return estado.digitarModelo ? null : estado.campos.modelo.trim();
}
