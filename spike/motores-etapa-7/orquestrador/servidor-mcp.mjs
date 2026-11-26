#!/usr/bin/env node
// Servidor MCP mínimo da prova, por entrada e saída padrão: oferece só a ferramenta "delegar".
// Ele não fala com ninguém e não guarda nada: só confirma. Quem recebe a tarefa de verdade é o
// gancho PreToolUse, que vê a chamada inteira antes de ela rodar e já fala com o servidor do
// awikabot com o token do turno.
import { createInterface } from 'node:readline';

const FERRAMENTA = {
  name: 'delegar',
  description: 'Entrega uma tarefa a um worker da equipe. Use uma chamada por tarefa.',
  inputSchema: {
    type: 'object',
    properties: {
      worker: { type: 'string', description: 'Nome do worker que recebe a tarefa.' },
      tarefa: { type: 'string', description: 'O que o worker deve fazer, com tudo o que ele precisa saber.' },
    },
    required: ['worker', 'tarefa'],
    additionalProperties: false,
  },
};

const enviar = (mensagem) => process.stdout.write(`${JSON.stringify(mensagem)}\n`);

createInterface({ input: process.stdin }).on('line', (linha) => {
  let pedido;
  try { pedido = JSON.parse(linha); } catch { return; }
  if (pedido.id === undefined) return; // notificação: não tem resposta
  const responder = (result) => enviar({ jsonrpc: '2.0', id: pedido.id, result });
  switch (pedido.method) {
    case 'initialize':
      responder({ protocolVersion: pedido.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'awika', version: '0.0.0' } });
      break;
    case 'tools/list':
      responder({ tools: [FERRAMENTA] });
      break;
    case 'tools/call':
      responder({ content: [{ type: 'text', text: 'Tarefa recebida pelo servidor. O resultado chega depois; não espere por ele.' }] });
      break;
    case 'ping':
      responder({});
      break;
    default:
      enviar({ jsonrpc: '2.0', id: pedido.id, error: { code: -32601, message: `método desconhecido: ${pedido.method}` } });
  }
});
