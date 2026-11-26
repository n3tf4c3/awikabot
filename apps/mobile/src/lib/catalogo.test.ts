import { describe, expect, it } from 'vitest';
import { MOTOR_PADRAO, type Catalogo, type MotorDoCatalogo } from '@awikabot/core';
import {
  OPCAO_AUTO,
  OPCAO_ESFORCO_PADRAO,
  aoChegarCatalogo,
  digitarOutroModelo,
  escolherModelo,
  escolherMotor,
  estadoInicial,
  modeloDigitado,
  modeloMarcado,
  motoresParaCriar,
  nomeDoMotor,
  opcoesDeEsforco,
  opcoesDeModelo,
} from './catalogo';
import { CAMPOS_BOT_VAZIOS, validarBot } from './formulario-bot';

const claude: MotorDoCatalogo = {
  id: 'claude-code',
  nome: 'Claude Code',
  familia: 'agente',
  modelos: [
    { id: 'opus', nome: 'Opus' },
    { id: 'sonnet', nome: 'Sonnet' },
  ],
  esforcos: [
    { id: 'low', nome: 'Baixo' },
    { id: 'high', nome: 'Alto' },
  ],
  papeis: ['worker'],
  pronto: true,
};
const outro: MotorDoCatalogo = {
  ...claude,
  id: 'outro',
  nome: 'Outro motor',
  modelos: [{ id: 'rapido', nome: 'Rápido' }],
  esforcos: [{ id: 'high', nome: 'Alto' }],
};
const catalogo: Catalogo = { motores: [claude, outro] };

describe('listas do formulário', () => {
  it('a lista de modelos começa por "Auto" e segue a ordem do catálogo', () => {
    expect(opcoesDeModelo(catalogo, 'claude-code')).toEqual([
      { valor: '', rotulo: 'Auto' },
      { valor: 'opus', rotulo: 'Opus' },
      { valor: 'sonnet', rotulo: 'Sonnet' },
    ]);
    expect(opcoesDeModelo(catalogo, 'outro').map((opcao) => opcao.valor)).toEqual(['', 'rapido']);
  });

  it('sem catálogo, ou com motor desconhecido, a lista de modelos é só "Auto"', () => {
    expect(opcoesDeModelo(null, MOTOR_PADRAO)).toEqual([OPCAO_AUTO]);
    expect(opcoesDeModelo(catalogo, 'nao-existe')).toEqual([OPCAO_AUTO]);
  });

  it('a lista de esforços começa por "Padrão"; sozinho, quer dizer que o motor não aceita esforço', () => {
    expect(opcoesDeEsforco(catalogo, 'claude-code')).toEqual([
      { valor: '', rotulo: 'Padrão' },
      { valor: 'low', rotulo: 'Baixo' },
      { valor: 'high', rotulo: 'Alto' },
    ]);
    expect(opcoesDeEsforco(null, MOTOR_PADRAO)).toEqual([OPCAO_ESFORCO_PADRAO]);
    expect(opcoesDeEsforco({ motores: [{ ...claude, esforcos: [] }] }, 'claude-code')).toEqual([OPCAO_ESFORCO_PADRAO]);
  });

  it('o esforço do bot que o catálogo não tem continua na lista, com o próprio id', () => {
    expect(opcoesDeEsforco(null, MOTOR_PADRAO, 'high')).toEqual([OPCAO_ESFORCO_PADRAO, { valor: 'high', rotulo: 'high' }]);
    expect(opcoesDeEsforco(catalogo, 'claude-code', 'high')).toHaveLength(3);
    expect(opcoesDeEsforco(catalogo, 'claude-code', '')).toHaveLength(3);
  });

  it('para criar, só os motores prontos da família dos agentes', () => {
    const misturado: Catalogo = {
      motores: [claude, { ...outro, pronto: false }, { ...outro, id: 'juiz', familia: 'decisor' }],
    };
    expect(motoresParaCriar(misturado)).toEqual([{ valor: 'claude-code', rotulo: 'Claude Code' }]);
    expect(motoresParaCriar(catalogo).map((opcao) => opcao.valor)).toEqual(['claude-code', 'outro']);
  });

  it('sem catálogo, ou sem motor pronto, para criar só há o motor padrão', () => {
    expect(motoresParaCriar(null)).toEqual([{ valor: MOTOR_PADRAO, rotulo: MOTOR_PADRAO }]);
    expect(motoresParaCriar({ motores: [{ ...claude, pronto: false }] })).toEqual([{ valor: MOTOR_PADRAO, rotulo: 'Claude Code' }]);
  });

  it('mostra o nome do motor, ou o id quando o catálogo não o tem', () => {
    expect(nomeDoMotor(catalogo, 'claude-code')).toBe('Claude Code');
    expect(nomeDoMotor(null, 'claude-code')).toBe('claude-code');
  });
});

describe('modelo escolhido ou digitado', () => {
  const opcoes = opcoesDeModelo(catalogo, 'claude-code');

  it('vazio é o "Auto", um sugerido é da lista, o resto foi digitado', () => {
    expect(modeloDigitado('', opcoes)).toBe(false);
    expect(modeloDigitado('   ', opcoes)).toBe(false);
    expect(modeloDigitado('opus', opcoes)).toBe(false);
    expect(modeloDigitado(' opus ', opcoes)).toBe(false);
    expect(modeloDigitado('claude-modelo-novo', opcoes)).toBe(true);
    // Sem catálogo, todo modelo preenchido foi digitado.
    expect(modeloDigitado('opus', [OPCAO_AUTO])).toBe(true);
  });

  it('um bot fora da lista abre no "Outro", com o texto dele', () => {
    const estado = estadoInicial({ ...CAMPOS_BOT_VAZIOS, modelo: 'claude-modelo-novo' }, catalogo);
    expect(estado.digitarModelo).toBe(true);
    expect(modeloMarcado(estado)).toBeNull();
  });

  it('um bot com modelo da lista abre com ele marcado; sem modelo, com o "Auto"', () => {
    expect(modeloMarcado(estadoInicial({ ...CAMPOS_BOT_VAZIOS, modelo: 'sonnet' }, catalogo))).toBe('sonnet');
    expect(modeloMarcado(estadoInicial(CAMPOS_BOT_VAZIOS, catalogo))).toBe('');
  });

  it('escolher na lista troca o modelo e fecha o "Outro"', () => {
    const digitando = estadoInicial({ ...CAMPOS_BOT_VAZIOS, modelo: 'meu-modelo' }, catalogo);
    const escolhido = escolherModelo(digitando, 'opus');
    expect(escolhido).toEqual({ campos: { ...CAMPOS_BOT_VAZIOS, modelo: 'opus' }, digitarModelo: false });
    expect(modeloMarcado(escolherModelo(escolhido, ''))).toBe('');
  });

  it('"Outro" abre o campo vazio quando o modelo era da lista, e mantém o que já foi digitado', () => {
    const daLista = estadoInicial({ ...CAMPOS_BOT_VAZIOS, modelo: 'opus' }, catalogo);
    expect(digitarOutroModelo(daLista, catalogo)).toEqual({ campos: { ...CAMPOS_BOT_VAZIOS, modelo: '' }, digitarModelo: true });
    const digitado = estadoInicial({ ...CAMPOS_BOT_VAZIOS, modelo: 'meu-modelo' }, catalogo);
    expect(digitarOutroModelo(digitado, catalogo).campos.modelo).toBe('meu-modelo');
  });

  it('"Outro" com o campo em branco salva como "Auto"', () => {
    const estado = digitarOutroModelo(estadoInicial(CAMPOS_BOT_VAZIOS, catalogo), catalogo);
    expect(validarBot({ ...estado.campos, nome: 'Scout' })).toMatchObject({ ok: true, entrada: { modelo: null } });
  });

  it('o catálogo que chega depois tira do "Outro" o modelo que está na lista', () => {
    const semCatalogo = estadoInicial({ ...CAMPOS_BOT_VAZIOS, modelo: 'opus' }, null);
    expect(semCatalogo.digitarModelo).toBe(true);
    expect(aoChegarCatalogo(semCatalogo, catalogo)).toEqual({ campos: semCatalogo.campos, digitarModelo: false });
  });
});

describe('troca de motor na criação', () => {
  it('volta o modelo e o esforço da lista ao padrão quando o outro motor não os tem', () => {
    const estado = escolherModelo(estadoInicial({ ...CAMPOS_BOT_VAZIOS, esforco: 'low' }, catalogo), 'opus');
    expect(escolherMotor(estado, catalogo, 'outro')).toEqual({
      campos: { ...CAMPOS_BOT_VAZIOS, motor: 'outro', modelo: '', esforco: '' },
      digitarModelo: false,
    });
  });

  it('mantém o esforço que o outro motor também tem, e o modelo digitado', () => {
    const digitado = digitarOutroModelo(estadoInicial({ ...CAMPOS_BOT_VAZIOS, esforco: 'high' }, catalogo), catalogo);
    const comTexto = { ...digitado, campos: { ...digitado.campos, modelo: 'meu-modelo' } };
    expect(escolherMotor(comTexto, catalogo, 'outro')).toEqual({
      campos: { ...CAMPOS_BOT_VAZIOS, motor: 'outro', modelo: 'meu-modelo', esforco: 'high' },
      digitarModelo: true,
    });
  });

  it('escolher o mesmo motor não muda nada', () => {
    const estado = escolherModelo(estadoInicial(CAMPOS_BOT_VAZIOS, catalogo), 'opus');
    expect(escolherMotor(estado, catalogo, 'claude-code')).toBe(estado);
  });
});
