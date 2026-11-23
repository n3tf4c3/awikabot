import pacote from '../package.json' with { type: 'json' };
import { criarServidor } from './app';
import { EnvInvalida, lerEnv, type Env } from './env';

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

const env = lerEnvOuSair();
const servidor = criarServidor({ versao: pacote.version });

servidor.listen(env.AWIKA_PORTA, env.AWIKA_HOST, () => {
  console.log(`awikabot ${pacote.version} ouvindo em ${env.AWIKA_HOST}:${env.AWIKA_PORTA}`);
});

function encerrar(): void {
  servidor.close(() => process.exit(0));
  servidor.closeAllConnections();
}

process.on('SIGTERM', encerrar);
process.on('SIGINT', encerrar);
