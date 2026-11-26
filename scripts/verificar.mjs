#!/usr/bin/env node
// Runbook `verificar` em forma de comando. Percorre os fluxos do mapa
// (docs/fluxos.md) pelo lado do servidor e sai com código diferente de zero
// se algo falhar.
//
// Sem variáveis: constrói o servidor, sobe o pacote de produção numa porta
// dedicada com o motor simulado e um banco descartável, e encerra no fim.
//
// Com AWIKA_VERIFICAR_BASE e AWIKA_VERIFICAR_CODIGO: usa um servidor que já
// está no ar, com o motor real, e um código de pareamento gerado nele. Gasta
// uso da conta do motor e deixa um bot de teste no banco desse servidor.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_EXTERNA = process.env.AWIKA_VERIFICAR_BASE;
const motorReal = Boolean(BASE_EXTERNA);
const PORTA = Number(process.env.AWIKA_VERIFICAR_PORTA ?? 8795);
const BASE = BASE_EXTERNA ?? `http://127.0.0.1:${PORTA}`;
const LIMITE_TURNO_MS = motorReal ? 120_000 : 8_000;
const inicio = Date.now();
const resultados = [];

function registrar(id, nome, passou, detalhe) {
  resultados.push({ id, nome, passou });
  console.log(`${passou ? 'PASSOU' : 'FALHOU'}  ${id}  ${nome}: ${detalhe}`);
}

async function responde(base = BASE) {
  try {
    return (await fetch(`${base}/healthz`)).ok;
  } catch {
    return false;
  }
}

async function esperar(condicao, limiteMs) {
  const fim = Date.now() + limiteMs;
  while (Date.now() < fim) {
    if (await condicao()) return true;
    await new Promise((ok) => { setTimeout(ok, 100); });
  }
  return false;
}

async function pedir(caminho, { metodo, corpo, token, base } = {}) {
  const resposta = await fetch(`${base ?? BASE}${caminho}`, {
    method: metodo ?? (corpo === undefined ? 'GET' : 'POST'),
    headers: {
      ...(corpo === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const texto = await resposta.text();
  return { status: resposta.status, corpo: texto ? JSON.parse(texto) : null };
}

/** Abre o fluxo de eventos e guarda o que chega, com o instante de cada evento. */
async function abrirEventos(token) {
  const controle = new AbortController();
  const resposta = await fetch(`${BASE}/v1/eventos`, {
    headers: { authorization: `Bearer ${token}` },
    signal: controle.signal,
  });
  const leitor = resposta.body.getReader();
  const decodificador = new TextDecoder();
  const eventos = [];
  let pendente = '';
  const ler = (async () => {
    try {
      for (;;) {
        const { done, value } = await leitor.read();
        if (done) return;
        pendente += decodificador.decode(value, { stream: true });
        const linhas = pendente.split('\n');
        pendente = linhas.pop() ?? '';
        for (const linha of linhas) {
          if (linha.startsWith('data: {')) eventos.push({ ...JSON.parse(linha.slice(6)), em: Date.now() });
        }
      }
    } catch { /* fluxo cancelado no encerramento */ }
  })();
  return {
    eventos,
    esperarEvento: (condicao, limiteMs = LIMITE_TURNO_MS) => esperar(() => eventos.some(condicao), limiteMs),
    fechar: async () => {
      controle.abort();
      await ler;
    },
  };
}

/** Inicia o pacote de produção do servidor com o ambiente dado e guarda a saída dele. */
function iniciarServidor(pasta, ambiente) {
  const processo = spawn(process.execPath, ['dist/server.mjs'], { cwd: pasta, env: ambiente, stdio: ['ignore', 'pipe', 'pipe'] });
  const servico = { processo, saida: '', saiu: new Promise((ok) => { processo.once('exit', ok); }) };
  processo.stdout.on('data', (parte) => { servico.saida += parte; });
  processo.stderr.on('data', (parte) => { servico.saida += parte; });
  return servico;
}

/** Roda um subcomando do servidor (`parear`, `backup`, `saude`) e devolve a saída e o código. */
function comandoDoServidor(args, ambiente = local.ambiente) {
  return spawnSync(process.execPath, ['dist/server.mjs', ...args], { cwd: local.servidor, env: ambiente, encoding: 'utf8' });
}

// 1. Subir (só no modo local).
let local = null;
/** O que o runbook cria além do servidor principal: desfeito no encerramento, passe ou falhe. */
const extras = { processos: [], pastas: [] };
if (!motorReal) {
  if (await responde()) {
    console.error(`FALHOU  a porta ${PORTA} já tem um servidor respondendo; encerre-o ou mude AWIKA_VERIFICAR_PORTA.`);
    process.exit(1);
  }
  const servidor = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'server');
  const build = spawnSync(process.execPath, ['build.mjs'], { cwd: servidor, encoding: 'utf8' });
  if (build.status !== 0) {
    console.error(build.stderr || build.stdout);
    console.error('FALHOU  build do servidor');
    process.exit(1);
  }
  const dados = mkdtempSync(path.join(os.tmpdir(), 'awikabot-verificar-'));
  const ambiente = {
    ...process.env,
    NODE_ENV: 'test',
    AWIKA_HOST: '127.0.0.1',
    AWIKA_PORTA: String(PORTA),
    AWIKA_PORTA_GANCHO: String(PORTA + 1),
    AWIKA_DADOS: dados,
    AWIKA_MOTOR: 'simulado',
  };
  local = { servidor, dados, ambiente, ...iniciarServidor(servidor, ambiente) };
}

function codigoDePareamento() {
  if (motorReal) return process.env.AWIKA_VERIFICAR_CODIGO;
  return /[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}/.exec(comandoDoServidor(['parear']).stdout ?? '')?.[0];
}

let fluxo = null;
try {
  // 2. Dirigir e 3. Observar.
  if (!(await esperar(responde, 10_000))) {
    registrar('F0', 'saúde do servidor', false, `sem resposta em ${BASE}/healthz; saída do servidor: ${local?.saida.trim() || '(não disponível)'}`);
  } else {
    const saude = await pedir('/healthz');
    registrar('F0', 'saúde do servidor, sem expor a versão', saude.status === 200 && JSON.stringify(saude.corpo) === '{"status":"ok"}',
      `status ${saude.status}, corpo ${JSON.stringify(saude.corpo)}`);
    if (local) {
      // O comando que o health check da imagem executa, aqui sem a opção de reiniciar.
      const vigia = comandoDoServidor(['saude']);
      registrar('O2', 'comando de saúde com o servidor no ar', vigia.status === 0, `saída ${vigia.status}`);
    }

    // F1: parear.
    const codigo = codigoDePareamento();
    const pareado = codigo ? await pedir('/v1/parear', { corpo: { codigo, nome: 'Runbook' } }) : { status: 0, corpo: null };
    const token = pareado.corpo?.token;
    registrar('F1', 'parear com código do servidor', pareado.status === 200 && typeof token === 'string' && Number.isInteger(pareado.corpo?.servidor?.protocolo),
      `código ${codigo ? 'informado' : 'ausente'}, status ${pareado.status}, protocolo ${pareado.corpo?.servidor?.protocolo}`);
    const repetido = codigo ? await pedir('/v1/parear', { corpo: { codigo, nome: 'Outro' } }) : { status: 0 };
    registrar('F1', 'código não vale duas vezes', repetido.status === 401, `status ${repetido.status}`);
    const semToken = await pedir('/v1/bots');
    registrar('F1', 'rota protegida sem token', semToken.status === 401, `status ${semToken.status}`);

    if (typeof token === 'string') {
      fluxo = await abrirEventos(token);

      // F2: criar e editar um bot.
      const criado = await pedir('/v1/bots', { token, corpo: { nome: 'Scout', instrucoes: 'Responda em português, em uma frase curta.' } });
      const botId = criado.corpo?.id;
      registrar('F2', 'criar bot', criado.status === 201 && criado.corpo?.nome === 'Scout', `status ${criado.status}`);
      const editado = await pedir(`/v1/bots/${botId}`, { token, metodo: 'PATCH', corpo: { nome: 'Scout 2' } });
      const lista = await pedir('/v1/bots', { token });
      const naLista = lista.corpo?.bots?.find((bot) => bot.id === botId);
      registrar('F2', 'editar bot', editado.status === 200 && naLista?.nome === 'Scout 2', `status ${editado.status}, nome na lista "${naLista?.nome}"`);

      // F2: o catálogo que monta as listas do formulário, e o motor por bot.
      const catalogo = await pedir('/v1/catalogo', { token });
      const claude = catalogo.corpo?.motores?.find((motor) => motor.id === 'claude-code');
      registrar('F2', 'catálogo com o motor padrão pronto', catalogo.status === 200 && claude?.pronto === true && claude?.modelos?.length > 0,
        `status ${catalogo.status}, ${claude?.modelos?.length ?? 0} modelo(s) e ${claude?.esforcos?.length ?? 0} esforço(s) sugeridos`);
      registrar('F2', 'bot criado sem motor fica no motor padrão', criado.corpo?.motor === 'claude-code' && criado.corpo?.esforco === null,
        `motor ${criado.corpo?.motor}, esforço ${criado.corpo?.esforco}`);
      // Um modelo fora da lista vale; um motor numa edição é ignorado. Volta ao padrão antes do turno.
      const foraDaLista = await pedir(`/v1/bots/${botId}`, { token, metodo: 'PATCH', corpo: { motor: 'outro', modelo: 'modelo-fora-da-lista', esforco: 'high' } });
      const devolta = await pedir(`/v1/bots/${botId}`, { token, metodo: 'PATCH', corpo: { modelo: null, esforco: null } });
      registrar('F2', 'modelo fora do catálogo aceito e motor fixo na edição',
        foraDaLista.status === 200 && foraDaLista.corpo?.modelo === 'modelo-fora-da-lista' && foraDaLista.corpo?.esforco === 'high' &&
          foraDaLista.corpo?.motor === 'claude-code' && devolta.status === 200 && devolta.corpo?.modelo === null,
        `status ${foraDaLista.status}, motor ${foraDaLista.corpo?.motor}, modelo ${foraDaLista.corpo?.modelo}`);

      // F3: conversar com resposta aos poucos.
      const enviadoEm = Date.now();
      const turno = await pedir(`/v1/bots/${botId}/turnos`, { token, corpo: { texto: motorReal ? 'Diga olá e guarde o número 47 para depois.' : 'olá mundo' } });
      const terminou = await fluxo.esperarEvento((e) => e.tipo === 'turno_terminado');
      const trechos = fluxo.eventos.filter((e) => e.tipo === 'texto');
      const mensagens = await pedir(`/v1/bots/${botId}/mensagens`, { token });
      const resposta = mensagens.corpo?.mensagens?.[1];
      const textoOk = motorReal ? Boolean(resposta?.texto) : resposta?.texto === 'Você disse: olá mundo';
      registrar('F3', 'turno com resposta aos poucos',
        turno.status === 201 && terminou && trechos.length >= (motorReal ? 1 : 2) && textoOk && resposta?.estado === 'completa',
        `status ${turno.status}, ${trechos.length} trechos, primeiro em ${trechos[0] ? trechos[0].em - enviadoEm : 'n/d'} ms, `
        + `resposta (${resposta?.estado}) "${String(resposta?.texto).slice(0, 80)}"`);

      if (motorReal) {
        // A conversa continua na mesma sessão do motor.
        const antes = fluxo.eventos.length;
        await pedir(`/v1/bots/${botId}/turnos`, { token, corpo: { texto: 'Qual número eu pedi para guardar? Responda só o número.' } });
        await fluxo.esperarEvento((e) => e.tipo === 'turno_terminado' && fluxo.eventos.indexOf(e) >= antes);
        const depois = await pedir(`/v1/bots/${botId}/mensagens`, { token });
        const lembrou = depois.corpo?.mensagens?.[3];
        registrar('F3', 'o bot lembra do turno anterior', lembrou?.estado === 'completa' && String(lembrou?.texto).includes('47'),
          `resposta (${lembrou?.estado}) "${String(lembrou?.texto).slice(0, 80)}"`);
      }

      // F3: parar um turno.
      const marca = fluxo.eventos.length;
      const longo = motorReal
        ? 'Conte de 1 a 300, um número por linha, sem mais nada.'
        : Array.from({ length: 80 }, (_, i) => `palavra${i}`).join(' ');
      await pedir(`/v1/bots/${botId}/turnos`, { token, corpo: { texto: longo } });
      await fluxo.esperarEvento((e) => e.tipo === 'texto' && fluxo.eventos.indexOf(e) >= marca);
      const parar = await pedir(`/v1/bots/${botId}/turnos/atual/parar`, { token, metodo: 'POST' });
      const parou = await fluxo.esperarEvento((e) => e.tipo === 'turno_terminado' && e.mensagem.estado === 'parada', 15_000);
      registrar('F3', 'parar um turno', parar.status === 204 && parou, `status ${parar.status}, evento de parada ${parou ? 'recebido' : 'não recebido'}`);

      // F4: a ação só roda depois de aprovada.
      const desde = (marca) => (e) => fluxo.eventos.indexOf(e) >= marca;
      // Cada decisão que o servidor aceitou, para conferir depois o que o histórico guarda dela.
      const decisoes = [];
      const turnoCom = async (texto, decisao) => {
        const marca = fluxo.eventos.length;
        const novo = desde(marca);
        await pedir(`/v1/bots/${botId}/turnos`, { token, corpo: { texto } });
        let decididas = 0;
        // Responde a todo pedido que surgir até o turno acabar.
        await esperar(async () => {
          for (const e of fluxo.eventos.filter((e) => novo(e) && e.tipo === 'aprovacao_pedida' && !e.respondida)) {
            e.respondida = true;
            const r = await pedir(`/v1/aprovacoes/${e.aprovacao.id}`, { token, corpo: { decisao } });
            if (r.status === 200) {
              decididas += 1;
              decisoes.push({ id: e.aprovacao.id, estado: decisao === 'aprovar' ? 'aprovada' : 'negada' });
            }
          }
          return fluxo.eventos.some((e) => novo(e) && e.tipo === 'turno_terminado');
        }, LIMITE_TURNO_MS);
        const pedidas = fluxo.eventos.filter((e) => novo(e) && e.tipo === 'aprovacao_pedida');
        const lista = await pedir(`/v1/bots/${botId}/mensagens`, { token });
        return { pedidas, decididas, resposta: lista.corpo?.mensagens?.at(-1) };
      };

      if (motorReal) {
        const aprovado = await turnoCom('Use a ferramenta Bash para executar exatamente este comando: echo awika-ok > aprovado.txt\nDepois responda só "feito".', 'aprovar');
        const lido = await turnoCom('Leia o arquivo aprovado.txt com a ferramenta Read e responda só com o conteúdo dele.', 'negar');
        registrar('F4', 'ação aprovada roda',
          aprovado.pedidas.length >= 1 && aprovado.pedidas[0].aprovacao.ferramenta === 'Bash' && String(lido.resposta?.texto).includes('awika-ok') && lido.pedidas.length === 0,
          `${aprovado.pedidas.length} pedido(s) de ${aprovado.pedidas[0]?.aprovacao.ferramenta}, resumo "${String(aprovado.pedidas[0]?.aprovacao.resumo).slice(0, 60)}"; leitura na pasta sem pedido: ${lido.pedidas.length === 0}; conteúdo lido "${String(lido.resposta?.texto).slice(0, 30)}"`);

        const negado = await turnoCom('Use a ferramenta Bash para executar exatamente este comando: echo nao > negado.txt\nSe não for permitido, responda só "negado" e não tente de outro jeito.', 'negar');
        // A prova é o disco, não a fala do modelo: este modo roda dentro do contêiner do servidor.
        const pastaDoBot = path.join(process.env.AWIKA_DADOS ?? '', 'trabalho', botId);
        const noDisco = (nome) => existsSync(path.join(pastaDoBot, nome));
        registrar('F4', 'ação negada não roda',
          negado.pedidas.length >= 1 && existsSync(pastaDoBot) && noDisco('aprovado.txt') && !noDisco('negado.txt'),
          `${negado.pedidas.length} pedido(s) negado(s); no disco: aprovado.txt ${noDisco('aprovado.txt') ? 'existe' : 'não existe'}, negado.txt ${noDisco('negado.txt') ? 'existe' : 'não existe'}`);

        // Leitura fora da pasta do bot: negada pelo servidor. O texto da resposta não é impresso.
        const fora = await turnoCom('Leia o arquivo /data/claude/.credentials.json com a ferramenta Read e me diga o que há nele.', 'negar');
        const vazou = /accessToken|refreshToken|claudeAiOauth|sk-ant-/.test(String(fora.resposta?.texto));
        registrar('F4', 'leitura fora da pasta do bot é negada', !vazou,
          `conteúdo do arquivo na resposta: ${vazou ? 'SIM' : 'não'}; pedidos de aprovação que surgiram e foram negados: ${fora.pedidas.length}`);

        // Gravação: fora da pasta e na configuração do motor, o servidor nega sem nem mostrar cartão.
        // Todo pedido que surgir é aprovado, para a prova não depender de alguém negar. A prova é o disco.
        const dados = process.env.AWIKA_DADOS ?? '';
        const alvoFora = path.join(dados, 'fora-da-pasta.txt');
        const gravaFora = await turnoCom(`Use a ferramenta Write para gravar o arquivo ${alvoFora} com o conteúdo "x". Se não for permitido, responda só "negado" e não tente de outro jeito.`, 'aprovar');
        const pedidosDeWrite = (turno) => turno.pedidas.filter((e) => ['Write', 'Edit', 'MultiEdit'].includes(e.aprovacao.ferramenta)).length;
        const gravaConfiguracao = await turnoCom('Use a ferramenta Write para gravar o arquivo .claude/settings.json com o conteúdo "{}". Se não for permitido, responda só "negado" e não tente de outro jeito.', 'aprovar');
        registrar('F4', 'gravação fora da pasta e na configuração do motor é negada',
          pedidosDeWrite(gravaFora) === 0 && !existsSync(alvoFora) && pedidosDeWrite(gravaConfiguracao) === 0 && !noDisco(path.join('.claude', 'settings.json')),
          `cartões de gravação: ${pedidosDeWrite(gravaFora)} e ${pedidosDeWrite(gravaConfiguracao)}; no disco: fora da pasta ${existsSync(alvoFora) ? 'EXISTE' : 'não existe'}, .claude/settings.json ${noDisco(path.join('.claude', 'settings.json')) ? 'EXISTE' : 'não existe'}`);
        const gravaDentro = await turnoCom('Use a ferramenta Write para gravar o arquivo dentro.txt com o conteúdo "awika-dentro". Depois responda só "feito".', 'aprovar');
        const cartao = gravaDentro.pedidas.find((e) => e.aprovacao.ferramenta === 'Write')?.aprovacao.resumo ?? '';
        registrar('F4', 'gravação na pasta do bot pede aprovação e mostra o conteúdo',
          noDisco('dentro.txt') && cartao.includes('dentro.txt') && cartao.includes('awika-dentro'),
          `no disco: dentro.txt ${noDisco('dentro.txt') ? 'existe' : 'não existe'}; cartão mostra o conteúdo: ${cartao.includes('awika-dentro')}`);
      } else {
        const aprovado = await turnoCom('!comando echo oi', 'aprovar');
        registrar('F4', 'ação aprovada roda',
          aprovado.pedidas.length === 1 && aprovado.decididas === 1 && aprovado.resposta?.texto === 'Comando permitido: echo oi',
          `${aprovado.pedidas.length} pedido(s), resposta "${aprovado.resposta?.texto}"`);
        const negado = await turnoCom('!comando rm -rf tudo', 'negar');
        registrar('F4', 'ação negada não roda',
          negado.pedidas.length === 1 && String(negado.resposta?.texto).startsWith('Comando negado'),
          `${negado.pedidas.length} pedido(s), resposta "${negado.resposta?.texto}"`);
        const fora = await turnoCom('!ler ../../segredo.txt', 'aprovar');
        registrar('F4', 'leitura fora da pasta do bot é negada',
          fora.pedidas.length === 0 && String(fora.resposta?.texto).startsWith('Leitura negada'),
          `${fora.pedidas.length} pedido(s), resposta "${fora.resposta?.texto}"`);
        const gravaFora = await turnoCom('!gravar ../../fora.txt', 'aprovar');
        const gravaConfiguracao = await turnoCom('!gravar .claude/settings.json', 'aprovar');
        registrar('F4', 'gravação fora da pasta e na configuração do motor é negada',
          gravaFora.pedidas.length === 0 && String(gravaFora.resposta?.texto) === 'Gravação negada: o bot só grava arquivos na própria pasta de trabalho'
          && gravaConfiguracao.pedidas.length === 0 && String(gravaConfiguracao.resposta?.texto) === 'Gravação negada: o bot não altera a configuração do motor',
          `${gravaFora.pedidas.length} e ${gravaConfiguracao.pedidas.length} pedido(s); respostas "${gravaFora.resposta?.texto}" e "${gravaConfiguracao.resposta?.texto}"`);
        const gravaDentro = await turnoCom('!gravar notas.txt', 'aprovar');
        registrar('F4', 'gravação na pasta do bot pede aprovação e mostra o conteúdo',
          gravaDentro.pedidas.length === 1 && gravaDentro.pedidas[0].aprovacao.resumo === 'Gravar o arquivo notas.txt\n\nconteúdo de teste'
          && gravaDentro.resposta?.texto === 'Gravação permitida: notas.txt',
          `${gravaDentro.pedidas.length} pedido(s), resposta "${gravaDentro.resposta?.texto}"`);

        // O lado do gancho que o motor executa: sem servidor para perguntar, nega.
        const gancho = spawnSync(process.execPath, ['dist/server.mjs', 'gancho'], {
          cwd: local.servidor,
          env: { ...local.ambiente, AWIKA_PORTA_GANCHO: '1', AWIKA_TURNO_TOKEN: 'x' },
          input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo' } }),
          encoding: 'utf8',
        });
        let decisaoDoGancho = '(saída ilegível)';
        try {
          decisaoDoGancho = JSON.parse(gancho.stdout).hookSpecificOutput.permissionDecision;
        } catch { /* fica a marca de saída ilegível */ }
        registrar('F4', 'gancho sem servidor nega', gancho.status === 0 && decisaoDoGancho === 'deny', `saída ${gancho.status}, decisão "${decisaoDoGancho}"`);
      }

      // O histórico guarda o desfecho de cada pedido: é o que a conversa mostra a quem abre o app depois.
      const comDesfecho = await pedir(`/v1/bots/${botId}/mensagens`, { token });
      const noHistorico = comDesfecho.corpo?.aprovacoes ?? [];
      const respostasDaPagina = new Set((comDesfecho.corpo?.mensagens ?? []).filter((m) => m.papel === 'bot').map((m) => m.id));
      const comODesfechoCerto = decisoes.filter((d) =>
        noHistorico.some((a) => a.id === d.id && a.estado === d.estado && respostasDaPagina.has(a.mensagemId))).length;
      registrar('F4', 'o histórico traz os pedidos já resolvidos',
        decisoes.length >= 1 && comODesfechoCerto === decisoes.length && noHistorico.every((a) => a.estado !== 'pendente'),
        `${comODesfechoCerto} de ${decisoes.length} decisões com o desfecho certo no histórico; ${noHistorico.length} pedido(s) resolvido(s) na página`);

      if (local) {
        // F5: o servidor cai no meio de um turno, com um pedido de aprovação esperando em outro bot.
        const marcaDaQueda = fluxo.eventos.length;
        const outro = await pedir('/v1/bots', { token, corpo: { nome: 'Espera', instrucoes: '' } });
        await pedir(`/v1/bots/${outro.corpo?.id}/turnos`, { token, corpo: { texto: '!comando echo depois' } });
        await pedir(`/v1/bots/${botId}/turnos`, { token, corpo: { texto: Array.from({ length: 600 }, (_, i) => `palavra${i}`).join(' ') } });
        await fluxo.esperarEvento((e) => e.tipo === 'aprovacao_pedida' && fluxo.eventos.indexOf(e) >= marcaDaQueda);
        // O texto em andamento vai para o banco a cada segundo: espera passar da primeira gravação.
        await new Promise((ok) => { setTimeout(ok, 2500); });
        const pendentesAntes = (await pedir('/v1/aprovacoes', { token })).corpo?.aprovacoes?.length;
        const ativosAntes = (await pedir('/v1/bots', { token })).corpo?.bots?.filter((bot) => bot.turnoAtivo).length;

        await fluxo.fechar();
        fluxo = null;
        local.processo.kill('SIGKILL');
        await local.saiu;
        Object.assign(local, iniciarServidor(local.servidor, local.ambiente));
        const voltou = await esperar(responde, 10_000);

        const botsDepois = await pedir('/v1/bots', { token });
        const historico = await pedir(`/v1/bots/${botId}/mensagens`, { token });
        const interrompida = historico.corpo?.mensagens?.at(-1);
        const ativosDepois = botsDepois.corpo?.bots?.filter((bot) => bot.turnoAtivo).length;
        registrar('F5', 'depois da queda, o histórico volta e a resposta interrompida vem marcada',
          voltou && ativosAntes === 2 && botsDepois.status === 200 && botsDepois.corpo.bots.length === 2 && ativosDepois === 0
          && interrompida?.estado === 'falhou' && String(interrompida?.texto).startsWith('Você disse: palavra0 palavra1 '),
          `voltou: ${voltou}; turnos ativos antes ${ativosAntes}, depois ${ativosDepois}; última resposta (${interrompida?.estado}) com ${String(interrompida?.texto).length} caracteres guardados`);

        const pendentesDepois = (await pedir('/v1/aprovacoes', { token })).corpo?.aprovacoes?.length;
        registrar('F5', 'pedido de aprovação não sobrevive à queda', pendentesAntes === 1 && pendentesDepois === 0,
          `pendentes antes ${pendentesAntes}, depois ${pendentesDepois}`);

        fluxo = await abrirEventos(token);
        const deVolta = await pedir(`/v1/bots/${botId}/turnos`, { token, corpo: { texto: 'de volta' } });
        const respondeu = await fluxo.esperarEvento((e) => e.tipo === 'turno_terminado' && e.mensagem.texto === 'Você disse: de volta');
        registrar('F5', 'o bot conversa de novo depois da queda', deVolta.status === 201 && respondeu, `status ${deVolta.status}, resposta ${respondeu ? 'recebida' : 'não recebida'}`);

        // O1: backup com o servidor no ar, e restauração numa pasta nova, com outro servidor.
        const copia = path.join(local.dados, 'copias', 'awikabot.db');
        const backup = comandoDoServidor(['backup', copia]);
        registrar('O1', 'backup com o servidor no ar', backup.status === 0 && existsSync(copia) && /sha256 [0-9a-f]{64}/.test(backup.stdout),
          `saída ${backup.status}; ${backup.stdout.split('\n').slice(1, 3).join('; ')}`);
        const repetido = comandoDoServidor(['backup', copia]);
        registrar('O1', 'backup não escreve por cima de um arquivo', repetido.status === 1, `saída ${repetido.status}`);

        const restaurada = mkdtempSync(path.join(os.tmpdir(), 'awikabot-verificar-restauro-'));
        extras.pastas.push(restaurada);
        copyFileSync(copia, path.join(restaurada, 'awikabot.db'));
        const baseRestaurada = `http://127.0.0.1:${PORTA + 2}`;
        const segundo = iniciarServidor(local.servidor, { ...local.ambiente, AWIKA_PORTA: String(PORTA + 2), AWIKA_PORTA_GANCHO: String(PORTA + 3), AWIKA_DADOS: restaurada });
        extras.processos.push(segundo);
        const subiu = await esperar(() => responde(baseRestaurada), 10_000);
        const original = await pedir(`/v1/bots/${botId}/mensagens`, { token });
        const copiada = subiu ? await pedir(`/v1/bots/${botId}/mensagens`, { token, base: baseRestaurada }) : { status: 0, corpo: null };
        const botsCopiados = subiu ? await pedir('/v1/bots', { token, base: baseRestaurada }) : { status: 0, corpo: null };
        const textos = (lista) => JSON.stringify(lista.corpo?.mensagens?.map((m) => [m.seq, m.estado, m.texto]));
        registrar('O1', 'restaurar o backup numa pasta nova',
          subiu && copiada.status === 200 && botsCopiados.corpo?.bots?.length === 2 && original.corpo.mensagens.length >= 4 && textos(copiada) === textos(original),
          `servidor restaurado ${subiu ? 'no ar' : 'não subiu'}; o mesmo aparelho entra: status ${copiada.status}; ${botsCopiados.corpo?.bots?.length} bots e ${copiada.corpo?.mensagens?.length} mensagens iguais às do original: ${textos(copiada) === textos(original)}`);
      }
    }
  }
} catch (erro) {
  registrar('--', 'execução do runbook', false, erro instanceof Error ? erro.message : String(erro));
} finally {
  // 4. Encerrar.
  if (fluxo) await fluxo.fechar();
  for (const extra of extras.processos) {
    extra.processo.kill();
    await extra.saiu;
  }
  // Só pastas que este comando criou com `mkdtempSync`.
  for (const pasta of extras.pastas) rmSync(pasta, { recursive: true, force: true });
  if (local) {
    local.processo.kill();
    await local.saiu;
    rmSync(local.dados, { recursive: true, force: true });
  }
}
if (local) {
  const portaLivre = await esperar(async () => !(await responde()), 5_000);
  registrar('--', 'encerramento', portaLivre, portaLivre ? `porta ${PORTA} liberada` : `porta ${PORTA} ainda responde`);
  const vigia = comandoDoServidor(['saude']);
  registrar('O2', 'comando de saúde com o servidor parado', vigia.status === 1, `saída ${vigia.status}`);
}

// 5. Relatar.
const falhas = resultados.filter((resultado) => !resultado.passou);
console.log(`\n${resultados.length - falhas.length} de ${resultados.length} verificações passaram em ${((Date.now() - inicio) / 1000).toFixed(1)}s, com o motor ${motorReal ? 'real' : 'simulado'}.`);
console.log(motorReal
  ? 'Não verificado por este comando: o app no aparelho; o aviso push; a queda (F5), o backup e a vigia da saúde, que têm ensaio próprio no host.'
  : 'Não verificado por este comando: o app no aparelho; o motor real; o aviso push; o reinício do contêiner pelo Docker e a vigia derrubando um servidor travado.');
process.exit(falhas.length === 0 ? 0 : 1);
