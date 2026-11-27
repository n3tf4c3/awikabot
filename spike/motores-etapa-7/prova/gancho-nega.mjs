#!/usr/bin/env node
// Gancho PreToolUse do Antigravity que só nega, para a prova de fechar a busca na web.
// Os outros argumentos quebram o gancho de um jeito cada (quebra, lixo, mudo, trava), para medir o
// que o motor faz com a ferramenta; "permite" responde allow.
import { appendFileSync, readFileSync } from 'node:fs';

let entrada = '';
try { entrada = readFileSync(0, 'utf8'); } catch { /* sem stdin */ }
let ferramenta = '?';
try { ferramenta = JSON.parse(entrada).toolCall?.name ?? '?'; } catch { /* entrada ilegível */ }
try { appendFileSync('/tmp/awika-gancho-nega.log', `${process.argv[2] ?? 'nega'} ${ferramenta}\n`); } catch { /* diário opcional */ }
if (process.argv[2] === 'quebra') {
  process.stderr.write('gancho quebrado de propósito\n');
  process.exit(1);
}
if (process.argv[2] === 'lixo') { process.stdout.write('isto não é JSON {{{'); process.exit(0); }
if (process.argv[2] === 'mudo') process.exit(0);
if (process.argv[2] === 'trava') setInterval(() => {}, 1000);
else if (process.argv[2] === 'pergunta') process.stdout.write(JSON.stringify({ decision: 'force_ask', reason: 'a prova quer um pedido de permissão' }));
else if (process.argv[2] === 'permite') process.stdout.write(JSON.stringify({ decision: 'allow', reason: 'permitido pelo gancho da prova' }));
else process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'negado pelo gancho da prova' }));
