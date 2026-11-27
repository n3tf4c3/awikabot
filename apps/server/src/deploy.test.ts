import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Os scripts do host (`deploy/backup.sh` e `deploy/restaurar.sh`) são shell e não têm workspace
// próprio: o teste deles, com um `docker` de mentira, roda daqui para entrar em `pnpm test` e na CI.
// Sem um `sh` no PATH, como num Windows sem as ferramentas do Git, o caso é pulado.
it('os scripts de backup e de restauração do host passam nos casos de deploy/testes/testar.sh', { timeout: 180_000 }, (contexto) => {
  const roteiro = fileURLToPath(new URL('../../../deploy/testes/testar.sh', import.meta.url));
  const execucao = spawnSync('sh', [roteiro], { encoding: 'utf8' });
  if (execucao.error && (execucao.error as NodeJS.ErrnoException).code === 'ENOENT') {
    contexto.skip();
    return;
  }
  const saida = `${execucao.stdout}${execucao.stderr}`;
  expect(saida).toMatch(/^Passaram os \d+ casos\.$/m);
  expect(saida).not.toContain('FALHOU');
  expect(execucao.status).toBe(0);
});
