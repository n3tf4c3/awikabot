import type { Server } from 'node:http';
import path from 'node:path';
import { serve } from '@hono/node-server';
import pacote from '../package.json' with { type: 'json' };
import { criarApp } from './app';
import { abrirBanco, type Banco } from './banco';
import { marcarInterrompidas } from './conversa';
import { criarCodigo, LimitadorDeTentativas, listarDispositivos, revogar } from './dispositivos';
import { EnvInvalida, lerEnv, type Env } from './env';
import { Barramento } from './eventos';
import { criarMotorClaudeCode } from './motor-claude-code';
import { criarMotorSimulado } from './motor-simulado';
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

function servir(env: Env, banco: Banco): void {
  const interrompidas = marcarInterrompidas(banco);
  const barramento = new Barramento();
  const motor = env.AWIKA_MOTOR === 'simulado' ? criarMotorSimulado() : criarMotorClaudeCode({ binario: env.AWIKA_CLAUDE_BIN });
  const turnos = new GestorDeTurnos({
    banco,
    motor,
    barramento,
    limite: env.AWIKA_TURNOS_SIMULTANEOS,
    pastaDosBots: path.join(env.AWIKA_DADOS, 'trabalho'),
  });
  const app = criarApp({ versao: pacote.version, banco, barramento, turnos, limitador: new LimitadorDeTentativas() });

  const servidor = serve({ fetch: app.fetch, hostname: env.AWIKA_HOST, port: env.AWIKA_PORTA }, () => {
    console.log(`awikabot ${pacote.version} ouvindo em ${env.AWIKA_HOST}:${env.AWIKA_PORTA}, motor ${env.AWIKA_MOTOR}`);
    if (interrompidas > 0) console.log(`${interrompidas} turno(s) interrompido(s) na última parada foram marcados como falha.`);
  }) as Server;

  const encerrar = (): void => {
    turnos.pararTodos();
    servidor.close(() => {
      banco.close();
      process.exit(0);
    });
    servidor.closeAllConnections();
  };
  process.on('SIGTERM', encerrar);
  process.on('SIGINT', encerrar);
}

const formatarInstante = (instante: number | null): string => (instante === null ? '-' : new Date(instante).toISOString());

const env = lerEnvOuSair();
const banco = abrirBanco(path.join(env.AWIKA_DADOS, 'awikabot.db'));
const [comando = 'servir', argumento] = process.argv.slice(2);

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
  default:
    console.error('Uso: servir | parear | dispositivos | revogar <id>');
    process.exitCode = 64;
}
