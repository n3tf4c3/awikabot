import { MOTOR_PADRAO, type Catalogo, type MotorDoCatalogo } from '@awikabot/core';

/**
 * Os motores que o servidor conhece, entregue em `GET /v1/catalogo`. A lista de modelos sugere e
 * não bloqueia: um modelo fora dela vale se passar no formato. O motor e o esforço, ao contrário,
 * só valem se estiverem aqui, porque o servidor precisa saber rodá-los.
 *
 * Os modelos são os apelidos que o Claude Code resolve para o modelo mais novo de cada linha: a
 * lista não envelhece a cada lançamento. Os esforços são os que o binário fixado na imagem
 * (2.1.330) aceita em `--effort`; valor fora deles o binário ignora, com um aviso.
 *
 * Os papéis são os que o motor exerce hoje: sozinho, um bot é um worker. Orquestrador e decisão
 * entram quando as equipes e os decisores existirem (etapa 7 do `PLANO.md`).
 */
export const CATALOGO: Catalogo = {
  motores: [
    {
      id: MOTOR_PADRAO,
      nome: 'Claude Code',
      familia: 'agente',
      modelos: [
        { id: 'fable', nome: 'Fable' },
        { id: 'opus', nome: 'Opus' },
        { id: 'sonnet', nome: 'Sonnet' },
        { id: 'haiku', nome: 'Haiku' },
      ],
      esforcos: [
        { id: 'low', nome: 'Baixo' },
        { id: 'medium', nome: 'Médio' },
        { id: 'high', nome: 'Alto' },
        { id: 'xhigh', nome: 'Muito alto' },
        { id: 'max', nome: 'Máximo' },
      ],
      papeis: ['worker'],
      pronto: true,
    },
  ],
};

export function motorDoCatalogo(id: string, catalogo: Catalogo = CATALOGO): MotorDoCatalogo | null {
  return catalogo.motores.find((motor) => motor.id === id) ?? null;
}

/** Um bot só nasce num motor pronto, que conversa e usa ferramentas. */
export function motorParaCriarBot(id: string, catalogo: Catalogo = CATALOGO): MotorDoCatalogo | null {
  const motor = motorDoCatalogo(id, catalogo);
  return motor?.pronto && motor.familia === 'agente' ? motor : null;
}

/** `null` é o padrão do motor e sempre vale; outro esforço, só se o motor o lista. */
export function esforcoValido(motor: MotorDoCatalogo, esforco: string | null): boolean {
  return esforco === null || motor.esforcos.some((opcao) => opcao.id === esforco);
}
