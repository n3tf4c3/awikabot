#!/usr/bin/env node
// Gancho PreToolUse da prova: repassa o pedido ao servidor de aprovação e espera
// a resposta pelo tempo que for. Sem resposta, nega.
import { readFileSync } from 'node:fs';
import { request } from 'node:http';

const porta = Number(process.env.AWIKA_BROKER_PORT ?? 8791);

function responder(decisao, motivo) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decisao,
      permissionDecisionReason: motivo,
    },
  }));
}

let entrada = '{}';
try {
  entrada = readFileSync(0, 'utf8') || '{}';
} catch { /* sem stdin: segue com pedido vazio */ }

// node:http não tem limite de espera por padrão; o fetch global desiste em 300 s.
const pedido = request(
  { host: '127.0.0.1', port: porta, path: '/pedido', method: 'POST', headers: { 'content-type': 'application/json' } },
  (resposta) => {
    let corpo = '';
    resposta.setEncoding('utf8');
    resposta.on('data', (parte) => { corpo += parte; });
    resposta.on('end', () => {
      try {
        const { decisao, motivo } = JSON.parse(corpo);
        responder(decisao === 'allow' ? 'allow' : 'deny', motivo ?? '');
      } catch {
        responder('deny', 'resposta ilegível do servidor de aprovação');
      }
    });
  },
);
pedido.on('error', (erro) => responder('deny', `sem resposta do servidor de aprovação: ${erro.message}`));
pedido.end(entrada);
