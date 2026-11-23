#!/usr/bin/env node
// Simulador do motor, só para testar a prova sem login. Imita o suficiente da
// saída em eventos e da chamada do gancho; não prova nada sobre o Claude Code.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const args = process.argv.slice(2);
const valor = (nome) => {
  const i = args.indexOf(nome);
  return i >= 0 ? args[i + 1] : undefined;
};
const prompt = valor('-p') ?? '';
const retomar = valor('--resume');
const settings = valor('--settings');
const memoria = path.join(process.env.CLAUDE_CONFIG_DIR ?? '/tmp', 'falso-claude');
mkdirSync(memoria, { recursive: true });

const sessionId = retomar ?? randomUUID();
const emitir = (evento) => process.stdout.write(`${JSON.stringify({ ...evento, session_id: sessionId })}\n`);
const arquivoSessao = path.join(memoria, `${sessionId}.txt`);

emitir({ type: 'system', subtype: 'init' });

let texto = '1\n2\n3';
if (retomar) {
  const anterior = existsSync(arquivoSessao) ? readFileSync(arquivoSessao, 'utf8') : '';
  texto = /palavra-chave para depois: ([\w-]+)/.exec(anterior)?.[1] ?? 'não lembro';
} else {
  writeFileSync(arquivoSessao, prompt);
}

const comando = /este comando: (.+)/.exec(prompt)?.[1];
if (comando) {
  const gancho = JSON.parse(readFileSync(settings, 'utf8')).hooks.PreToolUse[0].hooks[0].command;
  const saida = spawnSync('sh', ['-c', gancho], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: comando } }),
    encoding: 'utf8',
  });
  const decisao = JSON.parse(saida.stdout).hookSpecificOutput.permissionDecision;
  emitir({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: comando } }] } });
  if (decisao === 'allow') {
    spawnSync('sh', ['-c', comando]);
    texto = 'feito';
  } else {
    texto = 'negado';
  }
  emitir({ type: 'user', message: { content: [{ type: 'tool_result', is_error: decisao !== 'allow' }] } });
}

for (const trecho of texto.split(/(?<=\n)/)) {
  emitir({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: trecho } } });
}
if (!comando && !retomar) {
  emitir({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '\n' } } });
}
emitir({ type: 'assistant', message: { content: [{ type: 'text', text: texto }] } });
emitir({ type: 'result', subtype: 'success', is_error: false, result: texto, num_turns: 1, duration_ms: 1 });
