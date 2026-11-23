import { describe, expect, it } from 'vitest';
import { CODIGOS_DO_APP, ErroApi, codigoDoCorpo, ehRecusaDoToken, mensagemDeErro, mensagemDoCodigo, temCodigo } from './erros';

/** Códigos que o servidor devolve nas rotas usadas pelo app. */
const CODIGOS_DO_SERVIDOR = [
  'codigo_invalido',
  'muitas_tentativas',
  'dados_invalidos',
  'nao_autenticado',
  'nao_encontrado',
  'turno_em_andamento',
  'limite_de_turnos',
  'sem_turno_ativo',
];

describe('mensagemDoCodigo', () => {
  const generica = mensagemDoCodigo('codigo_que_nao_existe');

  it.each([...CODIGOS_DO_SERVIDOR, ...Object.values(CODIGOS_DO_APP).filter((codigo) => codigo !== 'erro_http')])(
    'tem frase própria para %s',
    (codigo) => {
      const mensagem = mensagemDoCodigo(codigo, 400);
      expect(mensagem).not.toBe(generica);
      expect(mensagem).not.toContain(codigo);
      expect(mensagem).not.toContain('400');
    },
  );

  it('explica o código de pareamento recusado', () => {
    expect(mensagemDoCodigo('codigo_invalido', 401)).toMatch(/Código de pareamento inválido/);
  });

  it('usa frase genérica com o status para código desconhecido', () => {
    expect(mensagemDoCodigo('algo_novo', 418)).toBe('O servidor respondeu com um erro inesperado (418). Tente de novo.');
  });

  it('usa frase genérica sem status quando não houve resposta', () => {
    expect(mensagemDoCodigo('algo_novo')).toBe('Algo deu errado. Tente de novo.');
  });
});

describe('mensagemDeErro', () => {
  it('traduz um ErroApi pelo código', () => {
    expect(mensagemDeErro(new ErroApi('rede', null))).toBe(mensagemDoCodigo('rede'));
  });

  it('não mostra o texto de um erro qualquer', () => {
    expect(mensagemDeErro(new Error('segredo interno'))).toBe('Algo deu errado. Tente de novo.');
    expect(mensagemDeErro('texto solto')).toBe('Algo deu errado. Tente de novo.');
  });
});

describe('temCodigo', () => {
  it('compara o código só de ErroApi', () => {
    expect(temCodigo(new ErroApi('sem_turno_ativo', 409), 'sem_turno_ativo')).toBe(true);
    expect(temCodigo(new ErroApi('rede', null), 'sem_turno_ativo')).toBe(false);
    expect(temCodigo(new Error('sem_turno_ativo'), 'sem_turno_ativo')).toBe(false);
  });
});

describe('codigoDoCorpo', () => {
  it('lê o código de um corpo no formato do contrato', () => {
    expect(codigoDoCorpo('{"erro":"nao_autenticado"}')).toBe('nao_autenticado');
    expect(codigoDoCorpo('{"erro":"turno_em_andamento","extra":1}')).toBe('turno_em_andamento');
  });

  it.each([
    ['vazio', ''],
    ['HTML', '<html><body>401 Unauthorized</body></html>'],
    ['texto solto', 'nao_autenticado'],
    ['JSON com outro campo', '{"error":"nao_autenticado"}'],
    ['código vazio', '{"erro":""}'],
    ['código que não é texto', '{"erro":401}'],
    ['lista', '["nao_autenticado"]'],
    ['nulo', 'null'],
  ])('devolve null para corpo %s', (_caso, corpo) => {
    expect(codigoDoCorpo(corpo)).toBeNull();
  });
});

describe('ehRecusaDoToken', () => {
  it('só vale para 401 com nao_autenticado no corpo do contrato', () => {
    expect(ehRecusaDoToken(401, '{"erro":"nao_autenticado"}')).toBe(true);
  });

  it.each([
    [401, '<html>Login do túnel</html>'],
    [401, ''],
    [401, '{"erro":"codigo_invalido"}'],
    [401, '{"error":"nao_autenticado"}'],
    [403, '{"erro":"nao_autenticado"}'],
    [200, '{"erro":"nao_autenticado"}'],
    [500, '{"erro":"nao_autenticado"}'],
  ])('não vale para %i com corpo %s', (status, corpo) => {
    expect(ehRecusaDoToken(status, corpo)).toBe(false);
  });
});
