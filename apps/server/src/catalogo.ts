import { MOTOR_PADRAO, type Catalogo, type MotorDoCatalogo } from '@awikabot/core';

/** O motor do Codex, dirigido por `motor-codex.ts`. */
export const MOTOR_CODEX = 'codex';
/** O motor do Antigravity, dirigido por `motor-antigravity.ts`. */
export const MOTOR_ANTIGRAVITY = 'antigravity';

/**
 * Os motores que o servidor conhece, entregue em `GET /v1/catalogo`. A lista de modelos sugere e
 * não bloqueia: um modelo fora dela vale se passar no formato. O motor e o esforço, ao contrário,
 * só valem se estiverem aqui, porque o servidor precisa saber rodá-los.
 *
 * Os modelos são os apelidos que o Claude Code resolve para o modelo mais novo de cada linha: a
 * lista não envelhece a cada lançamento. Os esforços são os que o binário fixado na imagem
 * (2.1.330) aceita em `--effort`; valor fora deles o binário ignora, com um aviso.
 *
 * Os papéis são os que o motor exerce hoje: sozinho, um bot é um worker; num turno sem ferramentas,
 * com a resposta presa a um esquema, o motor é o juiz (`juiz.ts`), o papel de decisão. O
 * orquestrador entra com as equipes (etapa 7 do `PLANO.md`).
 *
 * O Codex tem a versão 0.172.0 fixada na imagem. Os modelos são os mais novos de cada linha que
 * esse binário listou para a conta da prova em 26/11; os esforços, os que todos esses modelos
 * aceitam (`ultra` fica de fora: o `gpt-6-luna` não o tem). Ficou pronto em 26/11, depois de o
 * runbook de motor real passar com ele no Pi. Um motor novo entra com `pronto: false` até isso, e
 * só um servidor que o põe em `AWIKA_MOTORES_EM_PROVA` cria bot nele.
 *
 * O Antigravity tem a versão 1.5.18 fixada na imagem e ainda não está pronto: o runbook de motor
 * real não rodou com ele no Pi. Os modelos são os da linha Gemini 4 que esse binário ofereceu à
 * conta da prova em 26/11 e que não tinham data para sair; os esforços, os que todos eles aceitam
 * (`xhigh` fica de fora: o `gemini-4-carbon` não o tem). Com a chave de API a lista pode ser outra.
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
      papeis: ['worker', 'decisao'],
      pronto: true,
    },
    {
      id: MOTOR_CODEX,
      nome: 'Codex',
      familia: 'agente',
      modelos: [
        { id: 'gpt-6.2-sol', nome: 'GPT-6.2-Sol' },
        { id: 'gpt-6.2-astra', nome: 'GPT-6.2-Astra' },
        { id: 'gpt-6.1-terra', nome: 'GPT-6.1 Terra' },
        { id: 'gpt-6-luna', nome: 'GPT-6-Luna' },
      ],
      esforcos: [
        { id: 'low', nome: 'Baixo' },
        { id: 'medium', nome: 'Médio' },
        { id: 'high', nome: 'Alto' },
        { id: 'xhigh', nome: 'Muito alto' },
        { id: 'max', nome: 'Máximo' },
      ],
      papeis: ['worker', 'decisao'],
      pronto: true,
    },
    {
      id: MOTOR_ANTIGRAVITY,
      nome: 'Antigravity',
      familia: 'agente',
      modelos: [
        { id: 'gemini-4-neon', nome: 'Gemini 4 Neon' },
        { id: 'gemini-4-carbon', nome: 'Gemini 4 Carbon' },
        { id: 'gemini-4-hydrogen', nome: 'Gemini 4 Hydrogen' },
      ],
      esforcos: [
        { id: 'low', nome: 'Baixo' },
        { id: 'medium', nome: 'Médio' },
        { id: 'high', nome: 'Alto' },
      ],
      papeis: ['worker'],
      pronto: false,
    },
  ],
};

export function motorDoCatalogo(id: string, catalogo: Catalogo = CATALOGO): MotorDoCatalogo | null {
  return catalogo.motores.find((motor) => motor.id === id) ?? null;
}

/**
 * Um bot só nasce num motor que conversa e usa ferramentas, e que está pronto, ou em prova neste
 * servidor (`AWIKA_MOTORES_EM_PROVA`).
 */
export function motorParaCriarBot(id: string, catalogo: Catalogo = CATALOGO, emProva: readonly string[] = []): MotorDoCatalogo | null {
  const motor = motorDoCatalogo(id, catalogo);
  return motor && motor.familia === 'agente' && (motor.pronto || emProva.includes(motor.id)) ? motor : null;
}

/** `null` é o padrão do motor e sempre vale; outro esforço, só se o motor o lista. */
export function esforcoValido(motor: MotorDoCatalogo, esforco: string | null): boolean {
  return esforco === null || motor.esforcos.some((opcao) => opcao.id === esforco);
}
