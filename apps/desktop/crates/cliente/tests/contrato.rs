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
use awikabot_cliente::contrato::{
    AprovacaoEstado, BotEntrada, DecisaoAprovacao, DecisaoAprovacaoDecisao, Evento, MensagemEstado, MensagemPapel, PedidoPareamento,
    PedidoTurno, SaudeStatus, VERSAO_PROTOCOLO,
};
use awikabot_cliente::fluxo::{Conexao, FimDoFluxo, Sinal, seguir};
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
        .criar_bot(&credencial, &BotEntrada { nome: "Scout".into(), instrucoes: Some("Seja breve.".into()), modelo: None })
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
