#!/usr/bin/env node
// Gancho PreToolUse da prova do orquestrador, no Claude Code. Faz o papel do servidor: anota toda
// chamada de ferramenta que vê, guarda como tarefa a chamada de "delegar" e nega o resto.
import { appendFileSync, readFileSync } from 'node:fs';

const DIARIO = process.env.AWIKA_DIARIO_ORQ ?? '/data/registros/orquestrador-gancho.jsonl';
const DELEGAR = 'mcp__awika__delegar';

let pedido = {};
try { pedido = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* entrada ilegível: nega abaixo */ }
const ferramenta = typeof pedido.tool_name === 'string' ? pedido.tool_name : '';
// StructuredOutput é como o motor entrega a resposta de --json-schema: passa pelo gancho como ferramenta.
const permitida = ferramenta === DELEGAR || (process.env.AWIKA_NEGAR_LISTA !== '1' && ferramenta === 'StructuredOutput') || ['Read', 'Glob', 'Grep'].includes(ferramenta);

appendFileSync(DIARIO, `${JSON.stringify({ ferramenta, entrada: pedido.tool_input ?? null, decisao: permitida ? 'allow' : 'deny', temTokenDoTurno: Boolean(process.env.AWIKA_TURNO_TOKEN) })}\n`);

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: permitida ? 'allow' : 'deny',
    permissionDecisionReason: permitida ? 'aceita pela prova' : 'o orquestrador só lê e delega',
  },
}));
