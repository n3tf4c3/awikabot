import type { Server } from 'node:http';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { MOTOR_PADRAO } from '@awikabot/core';
import pacote from '../package.json' with { type: 'json' };
import { criarApp } from './app';
import { expirarPendentesNaPartida, GestorDeAprovacoes } from './aprovacoes';
import { BackupRecusado, fazerBackup } from './backup';
import { abrirBanco, type Banco } from './banco';
import { marcarInterrompidas } from './conversa';
import { criarCodigo, LimitadorDeTentativas, listarDispositivos, revogar } from './dispositivos';
import { ambienteDoMotor, EnvInvalida, lerEnv, lerEnvDoGancho, type Env } from './env';
import { Barramento } from './eventos';
import { MOTOR_CODEX } from './catalogo';
import { codexGerenciadoInstalado, configuracaoDoCodexToml, requisitosDoCodexToml } from './configuracao-codex';
import { configuracaoGerenciada, gerenciadaInstalada } from './configuracao-motor';
import { criarAppDoGancho, executarGancho, Ganchos } from './gancho';
import { despacharPorMotor } from './motor';
import { criarMotorClaudeCode } from './motor-claude-code';
import { criarMotorCodex } from './motor-codex';
import { criarMotorSimulado } from './motor-simulado';
import { conferirSaude, registrarProcesso } from './saude';
import { GestorDeTurnos } from './turnos';

function lerEnvOuSair(): Env {
  try {
    return lerEnv(process.env);
  } catch (erro) {
    if (erro instanceof EnvInvalida) {
      // Configuração inválida derruba o processo na partida, antes de atender qualquer pedido.
      console.error(erro.message);
      process.exit(1);
    }
    throw erro;
  }
}

/** A linha de comando do gancho: este mesmo programa, com o subcomando `gancho`. */
const comandoDoGancho = (): string => `${JSON.stringify(process.execPath)} ${JSON.stringify(process.argv[1] ?? '')} gancho`;

function servir(env: Env, banco: Banco): void {
  const ganchoGerenciado = env.AWIKA_GANCHO === 'gerenciado';
  if (ganchoGerenciado && env.AWIKA_MOTOR === 'claude-code' && !gerenciadaInstalada(comandoDoGancho())) {
    // Sem o gancho instalado, o motor rodaria sem ninguém para perguntar. Melhor não subir.
    console.error('AWIKA_GANCHO=gerenciado, mas a configuração gerenciada do motor não está instalada como esperado.');
    process.exit(1);
  }
  if (ganchoGerenciado && env.AWIKA_MOTOR === 'claude-code' && !codexGerenciadoInstalado()) {
    // Sem a configuração do Codex em /etc/codex, o bot dele pesquisaria na web e usaria os conectores da conta sem cartão.
    console.error('AWIKA_GANCHO=gerenciado, mas a configuração gerenciada do Codex não está instalada como esperado.');
    process.exit(1);
  }
  const interrompidas = marcarInterrompidas(banco);
  expirarPendentesNaPartida(banco);

  const barramento = new Barramento();
  const aprovacoes = new GestorDeAprovacoes({ banco, barramento });
  const ganchos = new Ganchos();
  // Cada bot roda no motor gravado nele. O simulado, só de teste, responde por todos.
  const motor =
    env.AWIKA_MOTOR === 'simulado'
      ? criarMotorSimulado()
      : despacharPorMotor({
          [MOTOR_PADRAO]: criarMotorClaudeCode({ binario: env.AWIKA_CLAUDE_BIN, ambiente: ambienteDoMotor(process.env, 'claude-code'), ganchoGerenciado }),
          [MOTOR_CODEX]: criarMotorCodex({ binario: env.AWIKA_CODEX_BIN, ambiente: ambienteDoMotor(process.env, 'codex'), configuracaoGerenciada: ganchoGerenciado }),
        });
  const turnos = new GestorDeTurnos({
    banco,
    motor,
    barramento,
    limite: env.AWIKA_TURNOS_SIMULTANEOS,
    pastaDosBots: path.join(env.AWIKA_DADOS, 'trabalho'),
    aprovacoes: {
      ganchos,
      aprovacoes,
      comando: comandoDoGancho(),
      porta: env.AWIKA_PORTA_GANCHO,
    },
  });
  const app = criarApp({
    versao: pacote.version,
    banco,
    barramento,
    turnos,
    aprovacoes,
    limitador: new LimitadorDeTentativas(),
    motoresEmProva: env.AWIKA_MOTORES_EM_PROVA,
  });

  // O gancho do motor fala com o servidor por uma porta só de loopback, fora da API pública.
  const servidorDoGancho = serve({
    fetch: criarAppDoGancho({ ganchos, aprovacoes }).fetch,
    hostname: '127.0.0.1',
    port: env.AWIKA_PORTA_GANCHO,
  }) as Server;

  const servidor = serve({ fetch: app.fetch, hostname: env.AWIKA_HOST, port: env.AWIKA_PORTA }, () => {
    console.log(`awikabot ${pacote.version} ouvindo em ${env.AWIKA_HOST}:${env.AWIKA_PORTA}, motor ${env.AWIKA_MOTOR === 'simulado' ? 'simulado' : 'de cada bot'}`);
    if (env.AWIKA_MOTORES_EM_PROVA.length > 0) console.log(`Motores em prova, que aceitam bot novo: ${env.AWIKA_MOTORES_EM_PROVA.join(', ')}`);
    if (interrompidas > 0) console.log(`${interrompidas} turno(s) interrompido(s) na última parada foram marcados como falha.`);
  }) as Server;
  // A vigia da saúde precisa saber qual processo derrubar se o servidor travar.
  const esquecerProcesso = registrarProcesso(env.AWIKA_DADOS);

  let encerrando = false;
  const encerrar = (): void => {
    if (encerrando) return;
    encerrando = true;
    // Primeiro os turnos: cada resposta é gravada como parada, com o que já tinha chegado.
    void turnos.pararTodos().then(() => {
      servidorDoGancho.close();
      servidorDoGancho.closeAllConnections();
      servidor.close(() => {
        banco.close();
        esquecerProcesso();
        process.exit(0);
      });
      servidor.closeAllConnections();
    });
  };
  process.on('SIGTERM', encerrar);
  process.on('SIGINT', encerrar);
}

const formatarInstante = (instante: number | null): string => (instante === null ? '-' : new Date(instante).toISOString());

const USO = 'Uso: servir | parear | dispositivos | revogar <id> | backup <arquivo> | saude | configuracao-do-motor | configuracao-do-codex <configuracao|requisitos>';

function copiarBanco(banco: Banco, destino: string | undefined): void {
  if (!destino) {
    console.error('Informe o arquivo de destino do backup. Ele não pode existir.');
    process.exitCode = 64;
    return;
  }
  try {
    const resumo = fazerBackup(banco, destino);
    console.log(`Backup gravado em ${resumo.arquivo}`);
    console.log(`${resumo.bytes} bytes, sha256 ${resumo.sha256}`);
    console.log(
      `esquema ${resumo.versaoDoEsquema}, ${resumo.bots} bot(s), ${resumo.mensagens} mensagem(ns), ${resumo.aparelhosAtivos} aparelho(s) ativo(s)`,
    );
    console.log('O arquivo leva as conversas e os aparelhos pareados. Guarde-o cifrado.');
  } catch (erro) {
    // Erro que não é a recusa conhecida pode citar o caminho; a mensagem do SQLite não leva dado do banco.
    console.error(erro instanceof BackupRecusado ? erro.message : `Backup não concluído: ${erro instanceof Error ? erro.message : 'erro desconhecido'}`);
    process.exitCode = 1;
  }
}

function administrar(env: Env, comando: string, argumento: string | undefined): void {
  const banco = abrirBanco(path.join(env.AWIKA_DADOS, 'awikabot.db'));

  switch (comando) {
    case 'servir':
      servir(env, banco);
      break;
    case 'parear':
      console.log(`Código de pareamento: ${criarCodigo(banco)}`);
      console.log('Vale por 5 minutos e só uma vez.');
      break;
    case 'dispositivos':
      for (const dispositivo of listarDispositivos(banco)) {
        const situacao = dispositivo.revogadoEm === null ? 'ativo' : 'revogado';
        console.log(`${dispositivo.id}  ${situacao}  visto em ${formatarInstante(dispositivo.vistoEm)}  ${dispositivo.nome}`);
      }
      break;
    case 'revogar':
      if (!argumento || !revogar(banco, argumento)) {
        console.error('Informe o id de um aparelho ativo (veja o comando "dispositivos").');
        process.exitCode = 1;
      } else {
        console.log('Aparelho revogado.');
      }
      break;
    case 'backup':
      copiarBanco(banco, argumento);
      break;
    default:
      console.error(USO);
      process.exitCode = 64;
  }
}

const [comando = 'servir', argumento] = process.argv.slice(2);
if (comando === 'gancho') {
  // Chamado pelo motor antes de cada ferramenta. Não abre o banco nem lê a configuração do servidor.
  await executarGancho(lerEnvDoGancho(process.env));
} else if (comando === 'configuracao-do-motor') {
  // Usado no build da imagem: imprime a configuração gerenciada do motor, com o gancho deste programa.
  console.log(JSON.stringify(configuracaoGerenciada(comandoDoGancho()), null, 2));
} else if (comando === 'configuracao-do-codex') {
  // Usado no build da imagem: imprime /etc/codex/managed_config.toml ou /etc/codex/requirements.toml.
  if (argumento === 'configuracao') process.stdout.write(configuracaoDoCodexToml());
  else if (argumento === 'requisitos') process.stdout.write(requisitosDoCodexToml());
  else {
    console.error(USO);
    process.exitCode = 64;
  }
} else if (comando === 'saude') {
  // Chamado pelo health check da imagem. Não abre o banco: pergunta ao servidor que está no ar.
  const env = lerEnvOuSair();
  const { saudavel, derrubou } = await conferirSaude({
    host: env.AWIKA_HOST,
    porta: env.AWIKA_PORTA,
    reiniciar: argumento === '--reiniciar',
    pasta: env.AWIKA_DADOS,
  });
  if (derrubou) console.error('O servidor não respondeu a conferências seguidas e foi derrubado para reiniciar.');
  process.exitCode = saudavel ? 0 : 1;
} else {
  administrar(lerEnvOuSair(), comando, argumento);
}
