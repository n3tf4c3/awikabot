#!/usr/bin/env node
// Gancho da prova, para os dois motores: repassa o pedido ao servidor de aprovação e espera a
// resposta até o prazo do próprio gancho. Sem resposta, com resposta ilegível ou com o servidor
// fora do ar, nega.
//
//   node gancho.mjs codex   gancho PreToolUse ou PermissionRequest do Codex
//   node gancho.mjs agy     gancho PreToolUse do Antigravity
//
// O arquivo de controle serve só à prova: diz a porta do servidor, o prazo do gancho e um
// defeito a simular no próprio gancho, para ver o que o motor faz com um gancho quebrado.
import { appendFileSync, readFileSync } from 'node:fs';
import { request } from 'node:http';

const motor = process.argv[2] ?? 'codex';
const CONTROLE = process.env.AWIKA_CONTROLE ?? '/tmp/awika-gancho.json';
const DIARIO = process.env.AWIKA_DIARIO ?? '/tmp/awika-gancho.log';

let controle = {};
try { controle = JSON.parse(readFileSync(CONTROLE, 'utf8')); } catch { /* sem controle: padrões */ }
const porta = Number(controle.porta ?? 8791);
const prazoMs = Number(controle.prazoMs ?? 600_000);
const defeito = controle.defeito ?? '';

let entrada = '{}';
try { entrada = readFileSync(0, 'utf8') || '{}'; } catch { /* sem stdin: pedido vazio */ }
let pedido = {};
try { pedido = JSON.parse(entrada); } catch { /* entrada ilegível: pedido vazio */ }
const evento = pedido.hook_event_name ?? 'PreToolUse';

const anotar = (texto) => {
  try { appendFileSync(DIARIO, `${new Date().toISOString()} ${motor} ${evento} ${texto}\n`); } catch { /* diário é opcional */ }
};

function responder(decisao, motivo) {
  anotar(`decisao=${decisao} motivo=${motivo}`);
  let saida;
  if (motor === 'agy') {
    saida = { decision: decisao === 'allow' ? 'allow' : 'deny', reason: motivo };
  } else if (evento === 'PermissionRequest') {
    saida = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: decisao === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: motivo } } };
  } else {
    saida = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decisao === 'allow' ? 'allow' : 'deny', permissionDecisionReason: motivo } };
  }
  process.stdout.write(JSON.stringify(saida));
  process.exit(0);
}

// Defeitos do próprio gancho. Aqui ele deixa de ser o nosso programa e vira um programa quebrado:
// o que interessa é o que o motor faz com a ferramenta.
anotar(`chamado defeito=${defeito || '-'}`);
if (defeito === 'sai1') {
  process.stderr.write('gancho quebrado de propósito\n');
  process.exit(1);
}
if (defeito === 'lixo') {
  process.stdout.write('isto não é JSON {{{');
  process.exit(0);
}
if (defeito === 'mudo') {
  process.exit(0);
}
if (defeito === 'trava') {
  setInterval(() => {}, 1000);
} else {
  const relogio = setTimeout(() => responder('deny', 'o servidor de aprovação não respondeu no prazo do gancho'), prazoMs);
  const chamada = request(
    { host: '127.0.0.1', port: porta, path: '/pedido', method: 'POST', headers: { 'content-type': 'application/json', 'x-awika-motor': motor } },
    (resposta) => {
      let corpo = '';
      resposta.setEncoding('utf8');
      resposta.on('data', (parte) => { corpo += parte; });
      resposta.on('end', () => {
        clearTimeout(relogio);
        try {
          const lido = JSON.parse(corpo);
          if (lido.decisao !== 'allow' && lido.decisao !== 'deny') throw new Error('decisão desconhecida');
          responder(lido.decisao, String(lido.motivo ?? ''));
        } catch {
          responder('deny', 'resposta ilegível do servidor de aprovação');
        }
      });
    },
  );
  chamada.on('error', (erro) => {
    clearTimeout(relogio);
    responder('deny', `sem resposta do servidor de aprovação: ${erro.code ?? erro.message}`);
  });
  chamada.end(JSON.stringify({ motor, evento, pedido }));
}
