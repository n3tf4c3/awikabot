// Um `claude` de mentira, para os testes do juiz no driver do Claude Code (`juiz.test.ts`). Só faz
// o turno de decisão, como o Claude Code 2.1.330 fez na prova da etapa 7: com `--json-schema`, a
// resposta sai pela ferramenta `StructuredOutput`, que passa antes pelo gancho; negada, o turno
// termina sem erro e sem `structured_output`. Não fala com modelo nenhum.
//
// CLAUDE_DE_MENTIRA_RESPOSTA  o JSON que vai em `structured_output` (padrão: uma resposta de afirmação)
// CLAUDE_DE_MENTIRA_ATRASO_MS espera antes de responder
// CLAUDE_DE_MENTIRA_REGISTRO  arquivo onde grava as opções recebidas e a entrada padrão
//
// O gancho é chamado como o gancho gerenciado da imagem chamaria: pela porta e pelo token que o
// driver põe no ambiente. Sem eles, nega, como o gancho de verdade.
import { writeFileSync } from 'node:fs';

const escrever = (evento: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(evento)}\n`);
};

async function passaPeloGancho(ferramenta: string, entrada: unknown): Promise<boolean> {
  const porta = process.env.AWIKA_PORTA_GANCHO;
  const token = process.env.AWIKA_TURNO_TOKEN;
  if (!porta || !token) return false;
  try {
    const resposta = await fetch(`http://127.0.0.1:${porta}/gancho`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-awika-turno': token },
      body: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: ferramenta, tool_input: entrada }),
    });
    return ((await resposta.json()) as { decisao?: unknown }).decisao === 'allow';
  } catch {
    return false;
  }
}

let entrada = '';
process.stdin.setEncoding('utf8');
for await (const parte of process.stdin) entrada += String(parte);
const argv = process.argv.slice(2);
if (process.env.CLAUDE_DE_MENTIRA_REGISTRO) writeFileSync(process.env.CLAUDE_DE_MENTIRA_REGISTRO, JSON.stringify({ argv, entrada }));

const sessao = 'sessao-de-mentira';
const comEsquema = argv.some((opcao) => opcao.startsWith('--json-schema='));
escrever({ type: 'system', subtype: 'init', session_id: sessao, tools: comEsquema ? ['StructuredOutput'] : ['Bash', 'Read'] });
await new Promise((ok) => setTimeout(ok, Number(process.env.CLAUDE_DE_MENTIRA_ATRASO_MS ?? 0)));

if (!comEsquema) {
  escrever({ type: 'result', subtype: 'success', is_error: false, result: 'sem esquema', session_id: sessao });
} else {
  const resposta: unknown = JSON.parse(process.env.CLAUDE_DE_MENTIRA_RESPOSTA ?? '{"resposta":false,"motivo":"2 + 2 = 4"}');
  const passou = await passaPeloGancho('StructuredOutput', resposta);
  escrever({ type: 'result', subtype: 'success', is_error: false, result: '', session_id: sessao, ...(passou ? { structured_output: resposta } : {}) });
}
