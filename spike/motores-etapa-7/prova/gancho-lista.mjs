#!/usr/bin/env node
// Gancho PreToolUse do Antigravity que nega tudo o que não conhece. As ferramentas que já chegam
// ao cliente como pedido de permissão (arquivo e terminal) seguem o fluxo normal: o gancho sai sem
// opinar. As de web, que não geram pedido, ficam com o gancho. O resto é negado.
//
//   node gancho-lista.mjs nega                 nega a busca e a leitura de endereço
//   node gancho-lista.mjs espera-permite:<s>   espera <s> segundos e permite, como quem pergunta ao servidor
//   node gancho-lista.mjs espera-nega:<s>      espera <s> segundos e nega
import { appendFileSync, readFileSync } from 'node:fs';

const DIARIO = '/tmp/awika-gancho-lista.log';
// Leem ou gravam arquivo, ou rodam comando: o pedido de permissão do protocolo cuida delas.
// Com AWIKA_GANCHO_SO_ANOTA=1 o gancho só anota o nome de cada ferramenta e não opina: serve para
// levantar os nomes de verdade, que não são os da documentação.
const COM_PEDIDO = new Set((process.env.AWIKA_GANCHO_COM_PEDIDO ?? 'read_file,write_file,edit_file,run_command').split(','));
const DE_WEB = new Set(['search_web', 'read_url_content']);

const [modo, segundos] = (process.argv[2] ?? 'nega').split(':');
let entrada = {};
try { entrada = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* entrada ilegível: cai no "nega" abaixo */ }
const ferramenta = entrada.toolCall?.name ?? '';
const args = entrada.toolCall?.args ?? {};
const anotar = (texto) => { try { appendFileSync(DIARIO, `${ferramenta || '(sem nome)'} ${texto}\n`); } catch { /* diário opcional */ } };
const responder = (decisao, motivo) => { anotar(`-> ${decisao}`); process.stdout.write(JSON.stringify({ decision: decisao, reason: motivo })); };

if (process.env.AWIKA_GANCHO_SO_ANOTA === '1' || COM_PEDIDO.has(ferramenta)) {
  anotar('-> fluxo normal');
  process.exit(0);
}
if (!DE_WEB.has(ferramenta)) {
  responder('deny', 'ferramenta fora da lista do awikabot');
} else {
  // É o que o cartão mostraria: o termo da busca ou o endereço, e de qual turno veio.
  anotar(`pedido: ${JSON.stringify({ query: args.query, domain: args.domain, Url: args.Url }).slice(0, 200)}; token do turno no ambiente: ${process.env.AWIKA_TURNO_TOKEN ? 'sim' : 'não'}`);
  if (modo === 'nega') responder('deny', 'a busca na web está fechada');
  else setTimeout(() => responder(modo === 'espera-permite' ? 'allow' : 'deny', modo === 'espera-permite' ? 'aprovado depois da espera' : 'negado depois da espera'), Number(segundos ?? 5) * 1000);
}
