//! O cliente em Rust falando com o servidor de verdade, pela rede.
//!
//! É o par de `apps/server/src/contrato-app.test.ts`: os testes de unidade usam respostas
//! escritas à mão; este prova que os dois lados concordam. Sobe o pacote de produção do
//! servidor (`pnpm server:build`) com o motor simulado e um banco descartável.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, channel};
use std::time::{Duration, Instant};

use awikabot_cliente::api::{Api, Credencial, ErroApi};
use awikabot_cliente::aprovacoes::{Aprovacoes, Situacao, situacao_do_bot};
use awikabot_cliente::catalogo::{Opcao, modelo_marcado, motores_para_criar, opcoes_de_esforco, opcoes_de_modelo};
use awikabot_cliente::contrato::{
    Aprovacao, AprovacaoEstado, Bot, BotEdicao, BotEntrada, DecisaoAprovacao, DecisaoAprovacaoDecisao, Evento, MOTOR_PADRAO, Mensagem,
    MensagemEstado, MensagemPapel, MotorDoCatalogoFamilia, MotorDoCatalogoPapeis, PedidoPareamento, PedidoTurno, SaudeStatus,
    VERSAO_PROTOCOLO,
};
use awikabot_cliente::fluxo::{Conexao, FimDoFluxo, Sinal, seguir};
use awikabot_cliente::formulario_bot::{CamposBot, campos_do_bot, edicao_do_bot, validar_bot};
use awikabot_cliente::servidor_de_teste::ServidorDeTeste;

/// Espera o próximo sinal que satisfaz a condição, descartando os outros.
fn esperar<T>(sinais: &Receiver<Sinal>, o_que: &str, mut condicao: impl FnMut(&Sinal) -> Option<T>) -> T {
    let limite = Instant::now() + Duration::from_secs(10);
    loop {
        let resta = limite.checked_duration_since(Instant::now()).unwrap_or_else(|| panic!("não chegou: {o_que}"));
        let sinal = sinais.recv_timeout(resta).unwrap_or_else(|_| panic!("não chegou: {o_que}"));
        if let Some(valor) = condicao(&sinal) {
            return valor;
        }
    }
}

#[test]
fn cliente_em_rust_contra_o_servidor() {
    let servidor = ServidorDeTeste::subir();
    let api = Api::new();

    // Saúde: sem token, só o estado.
    assert_eq!(api.saude(&servidor.base).expect("saúde").status, SaudeStatus::Ok);

    // Pareamento: o código vai como a pessoa digitaria, e só vale uma vez.
    let codigo = servidor.codigo_de_pareamento();
    let pedido = PedidoPareamento { codigo: format!("  {}  ", codigo.to_lowercase()), nome: "Desktop de teste".into() };
    let pareado = api.parear(&servidor.base, &pedido).expect("parear");
    assert!(pareado.token.len() >= 43);
    assert_eq!(pareado.servidor.protocolo, VERSAO_PROTOCOLO);
    assert_eq!(pareado.dispositivo.nome, "Desktop de teste");
    assert_eq!(api.parear(&servidor.base, &pedido), Err(ErroApi::Servidor { status: 401, codigo: "codigo_invalido".into() }));

    let credencial = Credencial { servidor: servidor.base.clone(), token: pareado.token.clone() };
    let token_errado = Credencial { servidor: servidor.base.clone(), token: "x".repeat(43) };
    assert_eq!(api.listar_bots(&token_errado), Err(ErroApi::NaoAutenticado));

    // Fluxo de eventos numa thread, como a interface fará em segundo plano.
    let parar = Arc::new(AtomicBool::new(false));
    let (envio, sinais) = channel();
    let fluxo = {
        let (credencial, parar) = (credencial.clone(), parar.clone());
        std::thread::spawn(move || {
            seguir(&credencial, &parar, &mut |sinal| {
                let _ = envio.send(sinal);
            })
        })
    };
    esperar(&sinais, "conexão aberta", |sinal| (*sinal == Sinal::Conexao(Conexao::Conectada)).then_some(()));
    // Conexão sem ponto de retomada: o cliente pede uma carga inicial a si mesmo.
    esperar(&sinais, "pedido de carga inicial", |sinal| (*sinal == Sinal::Evento(Evento::Ressincronizar)).then_some(()));

    // Bots.
    assert!(api.listar_bots(&credencial).expect("lista vazia").bots.is_empty());
    let bot = api
        .criar_bot(
            &credencial,
            &BotEntrada { nome: "Scout".into(), instrucoes: Some("Seja breve.".into()), modelo: None, motor: None, esforco: None },
        )
        .expect("criar bot");
    assert_eq!((bot.nome.as_str(), bot.instrucoes.as_str(), bot.modelo.as_deref(), bot.turno_ativo), ("Scout", "Seja breve.", None, false));
    let salvo = esperar(&sinais, "evento do bot salvo", |sinal| match sinal {
        Sinal::Evento(Evento::BotSalvo { bot }) => Some(bot.clone()),
        _ => None,
    });
    assert_eq!(salvo, bot);
    assert_eq!(api.listar_bots(&credencial).expect("lista").bots, vec![bot.clone()]);
    assert_eq!(api.listar_mensagens(&credencial, "id-que-nao-e-id"), Err(ErroApi::IdInvalido));

    // Conversa com resposta aos poucos.
    let turno = api.enviar_turno(&credencial, &bot.id, &PedidoTurno { texto: "olá mundo".into() }).expect("turno");
    assert_eq!(
        (turno.usuario.papel, turno.bot.papel, turno.bot.estado),
        (MensagemPapel::Usuario, MensagemPapel::Bot, MensagemEstado::EmAndamento)
    );
    let mut juntado = String::new();
    let terminada = esperar(&sinais, "fim do turno", |sinal| match sinal {
        Sinal::Evento(Evento::Texto { mensagem_id, posicao, trecho, .. }) => {
            assert_eq!(mensagem_id, &turno.bot.id);
            // A posição conta como o servidor conta: em unidades UTF-16 do texto já recebido.
            assert_eq!(*posicao as usize, juntado.encode_utf16().count());
            juntado.push_str(trecho);
            None
        }
        Sinal::Evento(Evento::TurnoTerminado { mensagem, .. }) => Some(mensagem.clone()),
        _ => None,
    });
    assert_eq!(juntado, "Você disse: olá mundo");
    assert_eq!(
        (terminada.id.as_str(), terminada.texto.as_str(), terminada.estado),
        (turno.bot.id.as_str(), "Você disse: olá mundo", MensagemEstado::Completa)
    );

    let conversa = api.listar_mensagens(&credencial, &bot.id).expect("mensagens");
    assert!(!conversa.tem_mais);
    let resumo: Vec<_> = conversa.mensagens.iter().map(|m| (m.seq, m.papel, m.estado, m.texto.as_str())).collect();
    assert_eq!(
        resumo,
        vec![
            (1, MensagemPapel::Usuario, MensagemEstado::Completa, "olá mundo"),
            (2, MensagemPapel::Bot, MensagemEstado::Completa, "Você disse: olá mundo"),
        ]
    );

    // Aprovação: o pedido chega pelo fluxo, a decisão vai pela API, e a segunda decisão é recusada.
    api.enviar_turno(&credencial, &bot.id, &PedidoTurno { texto: "!comando echo oi".into() }).expect("turno com comando");
    let pedida = esperar(&sinais, "pedido de aprovação", |sinal| match sinal {
        Sinal::Evento(Evento::AprovacaoPedida { aprovacao }) => Some(aprovacao.clone()),
        _ => None,
    });
    assert_eq!(
        (pedida.ferramenta.as_str(), pedida.resumo.as_str(), pedida.estado, pedida.resolvida_em),
        ("Bash", "echo oi", AprovacaoEstado::Pendente, None)
    );
    assert_eq!(api.listar_aprovacoes(&credencial).expect("pendentes").aprovacoes, vec![pedida.clone()]);

    let aprovar = DecisaoAprovacao { decisao: DecisaoAprovacaoDecisao::Aprovar };
    let decidida = api.decidir_aprovacao(&credencial, &pedida.id, &aprovar).expect("aprovar");
    assert_eq!(decidida.estado, AprovacaoEstado::Aprovada);
    assert!(decidida.resolvida_em.is_some());
    let permitido = esperar(&sinais, "fim do turno aprovado", |sinal| match sinal {
        Sinal::Evento(Evento::TurnoTerminado { mensagem, .. }) => Some(mensagem.texto.clone()),
        _ => None,
    });
    assert_eq!(permitido, "Comando permitido: echo oi");
    assert_eq!(
        api.decidir_aprovacao(&credencial, &pedida.id, &DecisaoAprovacao { decisao: DecisaoAprovacaoDecisao::Negar }),
        Err(ErroApi::Servidor { status: 409, codigo: "ja_resolvida".into() })
    );

    // Desparear: a API passa a recusar o token, e o fluxo para sozinho, sem tentar de novo.
    api.revogar_dispositivo(&credencial).expect("desparear");
    assert_eq!(api.listar_bots(&credencial), Err(ErroApi::NaoAutenticado));
    let limite = Instant::now() + Duration::from_secs(40);
    while !fluxo.is_finished() {
        assert!(Instant::now() < limite, "o fluxo não parou depois da revogação");
        std::thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(fluxo.join().expect("thread do fluxo"), FimDoFluxo::NaoAutenticado);
    assert!(!parar.load(Ordering::Relaxed));
}

// --- Passo 3: editar bot, parar turno e decidir aprovações ----------------------------------

/// Um aparelho pareado, com o fluxo de eventos correndo numa thread.
struct Aparelho {
    api: Api,
    credencial: Credencial,
    sinais: Receiver<Sinal>,
    parar: Arc<AtomicBool>,
}

impl Aparelho {
    fn parear(servidor: &ServidorDeTeste) -> Self {
        let api = Api::new();
        let pedido = PedidoPareamento { codigo: servidor.codigo_de_pareamento(), nome: "Desktop de teste".into() };
        let token = api.parear(&servidor.base, &pedido).expect("parear").token;
        let credencial = Credencial { servidor: servidor.base.clone(), token };

        let parar = Arc::new(AtomicBool::new(false));
        let (envio, sinais) = channel();
        {
            let (credencial, parar) = (credencial.clone(), parar.clone());
            std::thread::spawn(move || {
                seguir(&credencial, &parar, &mut |sinal| {
                    let _ = envio.send(sinal);
                })
            });
        }
        esperar(&sinais, "conexão aberta", |sinal| (*sinal == Sinal::Conexao(Conexao::Conectada)).then_some(()));
        esperar(&sinais, "pedido de carga inicial", |sinal| (*sinal == Sinal::Evento(Evento::Ressincronizar)).then_some(()));
        Self { api, credencial, sinais, parar }
    }

    fn token_errado(&self) -> Credencial {
        Credencial { servidor: self.credencial.servidor.clone(), token: "x".repeat(43) }
    }

    fn criar_bot(&self, nome: &str) -> Bot {
        let entrada = BotEntrada { nome: nome.into(), instrucoes: Some("Seja breve.".into()), modelo: None, motor: None, esforco: None };
        let bot = self.api.criar_bot(&self.credencial, &entrada).expect("criar bot");
        assert_eq!(self.bot_salvo(), bot);
        bot
    }

    /// Manda a mensagem e devolve a resposta do bot, ainda em andamento.
    fn enviar(&self, bot: &Bot, texto: &str) -> Mensagem {
        self.api.enviar_turno(&self.credencial, &bot.id, &PedidoTurno { texto: texto.into() }).expect("turno").bot
    }

    fn bot_salvo(&self) -> Bot {
        esperar(&self.sinais, "evento do bot salvo", |sinal| match sinal {
            Sinal::Evento(Evento::BotSalvo { bot }) => Some(bot.clone()),
            _ => None,
        })
    }

    fn aprovacao_pedida(&self) -> Aprovacao {
        esperar(&self.sinais, "pedido de aprovação", |sinal| match sinal {
            Sinal::Evento(Evento::AprovacaoPedida { aprovacao }) => Some(aprovacao.clone()),
            _ => None,
        })
    }

    fn aprovacao_resolvida(&self) -> Aprovacao {
        esperar(&self.sinais, "aprovação resolvida", |sinal| match sinal {
            Sinal::Evento(Evento::AprovacaoResolvida { aprovacao }) => Some(aprovacao.clone()),
            _ => None,
        })
    }

    fn turno_terminado(&self) -> Mensagem {
        esperar(&self.sinais, "fim do turno", |sinal| match sinal {
            Sinal::Evento(Evento::TurnoTerminado { mensagem, .. }) => Some(mensagem.clone()),
            _ => None,
        })
    }
}

impl Drop for Aparelho {
    fn drop(&mut self) {
        // O fluxo vê o pedido de parada quando a conexão cair, junto com o servidor de teste.
        self.parar.store(true, Ordering::Relaxed);
    }
}

fn recusa(status: u16, codigo: &str) -> ErroApi {
    ErroApi::Servidor { status, codigo: codigo.into() }
}

/// Tem a forma de um id do servidor, mas nenhum bot nem pedido com ele.
const ID_QUE_NAO_EXISTE: &str = "naoexiste0000000";
const NEGAR: DecisaoAprovacao = DecisaoAprovacao { decisao: DecisaoAprovacaoDecisao::Negar };
const APROVAR: DecisaoAprovacao = DecisaoAprovacao { decisao: DecisaoAprovacaoDecisao::Aprovar };

#[test]
fn editar_bot_contra_o_servidor() {
    let servidor = ServidorDeTeste::subir();
    let aparelho = Aparelho::parear(&servidor);
    let (api, credencial) = (&aparelho.api, &aparelho.credencial);
    let bot = aparelho.criar_bot("Scout");
    let campos = |bot: &Bot| (bot.nome.clone(), bot.instrucoes.clone(), bot.modelo.clone());

    // Só o nome: o resto fica como estava, e o evento do fluxo traz o bot como a resposta.
    let so_o_nome = BotEdicao { nome: Some("Batedor".into()), instrucoes: None, modelo: None, esforco: None };
    let renomeado = api.editar_bot(credencial, &bot.id, &so_o_nome).expect("editar o nome");
    assert_eq!(campos(&renomeado), ("Batedor".into(), "Seja breve.".into(), None));
    assert_eq!((renomeado.id.as_str(), renomeado.criado_em, renomeado.turno_ativo), (bot.id.as_str(), bot.criado_em, false));
    assert!(renomeado.atualizado_em >= bot.atualizado_em);
    assert_eq!(aparelho.bot_salvo(), renomeado);

    // Instruções e modelo juntos.
    let com_modelo =
        BotEdicao { nome: None, instrucoes: Some("Responda em uma linha.".into()), modelo: Some(Some("modelo-x".into())), esforco: None };
    let editado = api.editar_bot(credencial, &bot.id, &com_modelo).expect("editar instruções e modelo");
    assert_eq!(campos(&editado), ("Batedor".into(), "Responda em uma linha.".into(), Some("modelo-x".into())));
    assert_eq!(aparelho.bot_salvo(), editado);

    // `Some(None)` vai como `null`: o bot volta ao modelo padrão do motor.
    let sem_modelo = BotEdicao { nome: None, instrucoes: None, modelo: Some(None), esforco: None };
    let no_padrao = api.editar_bot(credencial, &bot.id, &sem_modelo).expect("tirar o modelo");
    assert_eq!(campos(&no_padrao), ("Batedor".into(), "Responda em uma linha.".into(), None));
    assert_eq!(aparelho.bot_salvo(), no_padrao);
    assert_eq!(api.listar_bots(credencial).expect("lista").bots, vec![no_padrao.clone()]);

    // O caminho da janela: o formulário aberto com o bot, mexido, validado e reduzido ao que mudou.
    assert_eq!(edicao_do_bot(&no_padrao, &validar_bot(&campos_do_bot(&no_padrao)).expect("o bot do servidor é válido")), None);
    let digitado = CamposBot {
        nome: "  Scout 😀 ".into(),
        instrucoes: String::new(),
        modelo: " familia.modelo:4.5[1m] ".into(),
        ..CamposBot::default()
    };
    let entrada = validar_bot(&digitado).expect("formulário válido");
    let edicao = edicao_do_bot(&no_padrao, &entrada).expect("os três campos mudaram");
    let do_formulario = api.editar_bot(credencial, &bot.id, &edicao).expect("editar pelo formulário");
    assert_eq!(campos(&do_formulario), ("Scout 😀".into(), String::new(), Some("familia.modelo:4.5[1m]".into())));
    assert_eq!(aparelho.bot_salvo(), do_formulario);
    // O servidor guardou o que o formulário entregou: aberto de novo, não há o que salvar.
    assert_eq!(edicao_do_bot(&do_formulario, &entrada), None);

    // O limite do nome é o mesmo dos dois lados: 60 emojis passam; 61, o formulário barra e o servidor também.
    let no_limite = CamposBot { nome: "😀".repeat(60), ..campos_do_bot(&do_formulario) };
    let edicao = edicao_do_bot(&do_formulario, &validar_bot(&no_limite).expect("nome no limite")).expect("o nome mudou");
    assert_eq!(api.editar_bot(credencial, &bot.id, &edicao).expect("nome no limite").nome, "😀".repeat(60));
    assert!(validar_bot(&CamposBot { nome: "😀".repeat(61), ..no_limite }).is_err());
    let acima = BotEdicao { nome: Some("😀".repeat(61)), instrucoes: None, modelo: None, esforco: None };
    assert_eq!(api.editar_bot(credencial, &bot.id, &acima), Err(recusa(400, "dados_invalidos")));

    // Recusas: o que o servidor não aceita, e o que nem sai do cliente.
    let opcao_de_linha_de_comando = BotEdicao { nome: None, instrucoes: None, modelo: Some(Some("--flag".into())), esforco: None };
    assert_eq!(api.editar_bot(credencial, &bot.id, &opcao_de_linha_de_comando), Err(recusa(400, "dados_invalidos")));
    let vazia = BotEdicao { nome: None, instrucoes: None, modelo: None, esforco: None };
    assert_eq!(api.editar_bot(credencial, &bot.id, &vazia), Err(recusa(400, "dados_invalidos")));
    assert_eq!(api.editar_bot(credencial, ID_QUE_NAO_EXISTE, &so_o_nome), Err(recusa(404, "nao_encontrado")));
    assert_eq!(api.editar_bot(credencial, "../dispositivo", &so_o_nome), Err(ErroApi::IdInvalido));
    assert_eq!(api.editar_bot(&aparelho.token_errado(), &bot.id, &so_o_nome), Err(ErroApi::NaoAutenticado));
}

#[test]
fn catalogo_e_motor_do_bot_contra_o_servidor() {
    let servidor = ServidorDeTeste::subir();
    let aparelho = Aparelho::parear(&servidor);
    let (api, credencial) = (&aparelho.api, &aparelho.credencial);

    // O catálogo que o formulário usa: o Claude Code pronto, com "Auto" no topo dos modelos.
    let catalogo = api.catalogo(credencial).expect("catálogo");
    let claude = catalogo.motores.iter().find(|motor| motor.id == MOTOR_PADRAO).expect("o motor padrão está no catálogo");
    assert_eq!(
        (claude.familia, claude.pronto, claude.papeis.as_slice()),
        (MotorDoCatalogoFamilia::Agente, true, &[MotorDoCatalogoPapeis::Worker][..])
    );
    // O Codex entrou pronto na etapa 7: os dois motores vão para a lista de criar.
    assert_eq!(
        motores_para_criar(Some(&catalogo)),
        vec![Opcao { valor: MOTOR_PADRAO.into(), rotulo: "Claude Code".into() }, Opcao { valor: "codex".into(), rotulo: "Codex".into() }]
    );
    let modelos: Vec<String> = opcoes_de_modelo(Some(&catalogo), MOTOR_PADRAO).into_iter().map(|opcao| opcao.valor).collect();
    assert_eq!(modelos, ["", "fable", "opus", "sonnet", "haiku"]);
    let esforcos: Vec<String> = opcoes_de_esforco(Some(&catalogo), MOTOR_PADRAO, "").into_iter().map(|opcao| opcao.valor).collect();
    assert_eq!(esforcos, ["", "low", "medium", "high", "xhigh", "max"]);
    assert_eq!(api.catalogo(&aparelho.token_errado()), Err(ErroApi::NaoAutenticado));

    // Criado pelas listas: o motor, um modelo sugerido e um esforço chegam ao servidor como foram escolhidos.
    let campos = CamposBot { nome: "Scout".into(), modelo: "opus".into(), esforco: "high".into(), ..CamposBot::default() };
    let bot = api.criar_bot(credencial, &validar_bot(&campos).expect("formulário válido")).expect("criar pelas listas");
    assert_eq!((bot.motor.as_str(), bot.modelo.as_deref(), bot.esforco.as_deref()), (MOTOR_PADRAO, Some("opus"), Some("high")));
    assert_eq!(aparelho.bot_salvo(), bot);
    assert_eq!(modelo_marcado(&campos_do_bot(&bot).modelo, &opcoes_de_modelo(Some(&catalogo), &bot.motor)), Some("opus"));

    // Um modelo fora da lista é aceito, se passar no formato; na lista, ele é o "Outro".
    let fora = CamposBot { nome: "Outro".into(), modelo: "claude-modelo-novo[1m]".into(), ..CamposBot::default() };
    let outro = api.criar_bot(credencial, &validar_bot(&fora).expect("formulário válido")).expect("modelo fora da lista");
    assert_eq!(outro.modelo.as_deref(), Some("claude-modelo-novo[1m]"));
    assert_eq!(modelo_marcado(&campos_do_bot(&outro).modelo, &opcoes_de_modelo(Some(&catalogo), &outro.motor)), None);
    aparelho.bot_salvo();

    // O pedido de um cliente anterior ao motor, sem os campos novos: o motor padrão e o esforço padrão.
    let antigo = api
        .criar_bot(credencial, &BotEntrada { nome: "Antigo".into(), instrucoes: None, modelo: None, motor: None, esforco: None })
        .expect("criar sem motor");
    assert_eq!((antigo.motor.as_str(), antigo.esforco.as_deref()), (MOTOR_PADRAO, None));
    aparelho.bot_salvo();

    // Motor que o servidor não roda e esforço que o motor não lista são recusados.
    let antigravity = BotEntrada { motor: Some("antigravity".into()), ..validar_bot(&campos).expect("válido") };
    assert_eq!(api.criar_bot(credencial, &antigravity), Err(recusa(400, "dados_invalidos")));
    let turbo = BotEntrada { esforco: Some("turbo".into()), ..validar_bot(&campos).expect("válido") };
    assert_eq!(api.criar_bot(credencial, &turbo), Err(recusa(400, "dados_invalidos")));

    // A edição muda o esforço e volta ao padrão com nulo; o motor fica o da criação.
    let baixo = BotEdicao { nome: None, instrucoes: None, modelo: None, esforco: Some(Some("low".into())) };
    assert_eq!(api.editar_bot(credencial, &bot.id, &baixo).expect("esforço baixo").esforco.as_deref(), Some("low"));
    aparelho.bot_salvo();
    let padrao = BotEdicao { nome: None, instrucoes: None, modelo: None, esforco: Some(None) };
    let no_padrao = api.editar_bot(credencial, &bot.id, &padrao).expect("esforço padrão");
    assert_eq!((no_padrao.esforco.as_deref(), no_padrao.motor.as_str()), (None, MOTOR_PADRAO));
    let invalido = BotEdicao { nome: None, instrucoes: None, modelo: None, esforco: Some(Some("turbo".into())) };
    assert_eq!(api.editar_bot(credencial, &bot.id, &invalido), Err(recusa(400, "dados_invalidos")));
}

#[test]
fn parar_turno_contra_o_servidor() {
    let servidor = ServidorDeTeste::subir();
    let aparelho = Aparelho::parear(&servidor);
    let (api, credencial) = (&aparelho.api, &aparelho.credencial);
    let bot = aparelho.criar_bot("Scout");

    // Sem turno, não há o que parar.
    assert_eq!(api.parar_turno(credencial, &bot.id), Err(recusa(409, "sem_turno_ativo")));
    assert_eq!(api.parar_turno(credencial, ID_QUE_NAO_EXISTE), Err(recusa(404, "nao_encontrado")));
    assert_eq!(api.parar_turno(credencial, "id-que-nao-e-id"), Err(ErroApi::IdInvalido));
    assert_eq!(api.parar_turno(&aparelho.token_errado(), &bot.id), Err(ErroApi::NaoAutenticado));

    // O motor simulado devolve o texto palavra por palavra: com 600 palavras, a resposta leva segundos.
    let pergunta = "palavra ".repeat(600);
    let resposta = aparelho.enviar(&bot, &pergunta);
    assert_eq!(resposta.estado, MensagemEstado::EmAndamento);
    esperar(&aparelho.sinais, "primeiro trecho da resposta", |sinal| matches!(sinal, Sinal::Evento(Evento::Texto { .. })).then_some(()));
    assert!(api.listar_bots(credencial).expect("lista").bots[0].turno_ativo);

    api.parar_turno(credencial, &bot.id).expect("parar o turno");
    let parada = aparelho.turno_terminado();
    assert_eq!((parada.id.as_str(), parada.estado), (resposta.id.as_str(), MensagemEstado::Parada));
    // Ficou o que já tinha chegado, e só isso.
    let inteira = format!("Você disse: {}", pergunta.trim_end());
    assert!(!parada.texto.is_empty() && parada.texto.len() < inteira.len() && inteira.starts_with(&parada.texto), "{:?}", parada.texto);

    let conversa = api.listar_mensagens(credencial, &bot.id).expect("mensagens");
    assert_eq!(conversa.mensagens.last(), Some(&parada));
    assert!(!api.listar_bots(credencial).expect("lista").bots[0].turno_ativo);
    // Parado, o turno acabou: parar de novo é recusado, e o bot aceita outra mensagem.
    assert_eq!(api.parar_turno(credencial, &bot.id), Err(recusa(409, "sem_turno_ativo")));
    aparelho.enviar(&bot, "olá");
    assert_eq!(aparelho.turno_terminado().texto, "Você disse: olá");

    // Parar com um pedido de aprovação à espera: o pedido expira e a ação não roda.
    let resposta = aparelho.enviar(&bot, "!comando echo oi");
    let pedida = aparelho.aprovacao_pedida();
    assert_eq!((pedida.mensagem_id.as_str(), pedida.estado), (resposta.id.as_str(), AprovacaoEstado::Pendente));
    api.parar_turno(credencial, &bot.id).expect("parar com aprovação pendente");
    let expirada = aparelho.aprovacao_resolvida();
    assert_eq!((expirada.id.as_str(), expirada.estado), (pedida.id.as_str(), AprovacaoEstado::Expirada));
    let parada = aparelho.turno_terminado();
    assert_eq!((parada.id.as_str(), parada.estado, parada.texto.as_str()), (resposta.id.as_str(), MensagemEstado::Parada, ""));
    assert!(api.listar_aprovacoes(credencial).expect("pendentes").aprovacoes.is_empty());
    assert_eq!(api.decidir_aprovacao(credencial, &pedida.id, &APROVAR), Err(recusa(409, "ja_resolvida")));
}

#[test]
fn negar_aprovacao_contra_o_servidor() {
    let servidor = ServidorDeTeste::subir();
    let aparelho = Aparelho::parear(&servidor);
    let (api, credencial) = (&aparelho.api, &aparelho.credencial);
    let bot = aparelho.criar_bot("Scout");
    // O que a janela guarda: o que chega pelo fluxo, pela lista e pela resposta da decisão.
    let mut aprovacoes = Aprovacoes::default();

    let revisao = aprovacoes.revisao();
    assert!(aprovacoes.aplicar_pendentes(api.listar_aprovacoes(credencial).expect("nenhum pendente").aprovacoes, revisao));
    assert_eq!(situacao_do_bot(&bot, &aprovacoes), None);

    let resposta = aparelho.enviar(&bot, "!comando echo oi");
    let pedida = aparelho.aprovacao_pedida();
    assert_eq!(
        (pedida.bot_id.as_str(), pedida.mensagem_id.as_str(), pedida.ferramenta.as_str(), pedida.resumo.as_str(), pedida.estado),
        (bot.id.as_str(), resposta.id.as_str(), "Bash", "echo oi", AprovacaoEstado::Pendente)
    );

    // Enquanto pendente, o pedido vem na lista. Aqui a lista foi pedida antes de o evento ser
    // aplicado: ela acrescenta o pedido, mas não está em dia; a busca seguinte está.
    let revisao = aprovacoes.revisao();
    let pendentes = api.listar_aprovacoes(credencial).expect("pendentes").aprovacoes;
    assert_eq!(pendentes, vec![pedida.clone()]);
    aprovacoes.aplicar_evento(pedida.clone());
    assert!(!aprovacoes.aplicar_pendentes(pendentes.clone(), revisao));
    let revisao = aprovacoes.revisao();
    assert!(aprovacoes.aplicar_pendentes(pendentes, revisao));
    assert_eq!(aprovacoes.obter(&pedida.id), Some(&pedida));
    assert_eq!(situacao_do_bot(&bot, &aprovacoes), Some(Situacao::AguardandoAprovacao));

    // Negar: a resposta traz o pedido resolvido, o fluxo repete, e a ação não roda.
    let negada = api.decidir_aprovacao(credencial, &pedida.id, &NEGAR).expect("negar");
    assert_eq!((negada.id.as_str(), negada.estado), (pedida.id.as_str(), AprovacaoEstado::Negada));
    assert!(negada.resolvida_em.is_some_and(|instante| instante >= pedida.criada_em));
    assert_eq!(Aprovacao { estado: AprovacaoEstado::Pendente, resolvida_em: None, ..negada.clone() }, pedida);
    aprovacoes.aplicar_decisao(negada.clone());
    assert_eq!(aparelho.aprovacao_resolvida(), negada);
    aprovacoes.aplicar_evento(negada.clone());
    let terminada = aparelho.turno_terminado();
    assert_eq!((terminada.id.as_str(), terminada.estado), (resposta.id.as_str(), MensagemEstado::Completa));
    assert!(terminada.texto.starts_with("Comando negado: "), "{:?}", terminada.texto);

    // A segunda decisão é recusada, seja qual for, e a primeira continua valendo.
    assert_eq!(api.decidir_aprovacao(credencial, &pedida.id, &APROVAR), Err(recusa(409, "ja_resolvida")));
    assert_eq!(api.decidir_aprovacao(credencial, &pedida.id, &NEGAR), Err(recusa(409, "ja_resolvida")));
    assert_eq!(api.decidir_aprovacao(credencial, ID_QUE_NAO_EXISTE, &NEGAR), Err(recusa(404, "nao_encontrado")));
    assert_eq!(api.decidir_aprovacao(credencial, "id-que-nao-e-id", &NEGAR), Err(ErroApi::IdInvalido));

    // Resolvido, o pedido deixa de vir na lista; o app fica com o desfecho, e uma cópia pendente
    // que chegasse atrasada não o desfaria.
    let pendentes = api.listar_aprovacoes(credencial).expect("pendentes").aprovacoes;
    assert!(pendentes.is_empty());
    let revisao = aprovacoes.revisao();
    assert!(aprovacoes.aplicar_pendentes(pendentes, revisao));
    aprovacoes.aplicar_evento(pedida.clone());
    assert_eq!(aprovacoes.obter(&pedida.id), Some(&negada));
    assert_eq!(aprovacoes.do_bot(&bot.id), vec![&negada]);
    assert_eq!(situacao_do_bot(&bot, &aprovacoes), None);

    // Quem abre o app depois não viu nada disso pelo fluxo: a página da conversa traz o pedido já
    // resolvido, preso à resposta em que ele surgiu.
    let pagina = api.listar_mensagens(credencial, &bot.id).expect("mensagens");
    assert_eq!(pagina.aprovacoes, Some(vec![negada.clone()]));
    assert_eq!(pagina.mensagens.last().map(|ultima| ultima.id.as_str()), Some(negada.mensagem_id.as_str()));
    let mut reaberto = Aprovacoes::default();
    reaberto.aplicar_resolvidas(pagina.aprovacoes.unwrap_or_default());
    assert_eq!(reaberto.do_bot(&bot.id), vec![&negada]);
    assert_eq!(situacao_do_bot(&bot, &reaberto), None);
}
