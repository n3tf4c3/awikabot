//! O fluxo de eventos contra um servidor de mentira, que faz o que o de verdade não faz a pedido:
//! cair no meio, responder como um proxy, recusar o token. São os casos de
//! `apps/mobile/src/lib/fluxo-eventos.test.ts` que valem para este cliente.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, channel};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use awikabot_cliente::api::Credencial;
use awikabot_cliente::contrato::Evento;
use awikabot_cliente::fluxo::{Conexao, FimDoFluxo, Sinal, TemposDoFluxo, seguir_com};
use awikabot_cliente::servidor_de_teste::{RespostaFalsa, ServidorFalso};

const TOKEN: &str = "token-do-computador-de-teste-0123456789abcde";
const RECUSA: &str = r#"{"erro":"nao_autenticado"}"#;

fn ms(valor: u64) -> Duration {
    Duration::from_millis(valor)
}

/// Esperas curtas, e uma conexão nunca dura o bastante para zerar a contagem de falhas.
fn rapido() -> TemposDoFluxo {
    TemposDoFluxo { esperas: [ms(20), ms(40), ms(80), ms(160)], duracao_da_conexao: ms(3000), conexao_estavel: ms(60_000) }
}

fn ping(id: &str) -> String {
    format!("id: {id}\nevent: ping\ndata: \n\n")
}

fn inicio_de_turno(id: &str, mensagem: &str) -> String {
    format!(
        "id: {id}\nevent: evento\ndata: {{\"tipo\":\"turno_iniciado\",\"botId\":\"botbotbotbotbot1\",\"mensagemId\":\"{mensagem}\"}}\n\n"
    )
}

fn turno_iniciado(mensagem: &str) -> Sinal {
    Sinal::Evento(Evento::TurnoIniciado { bot_id: "botbotbotbotbot1".into(), mensagem_id: mensagem.into() })
}

struct Rodando {
    parar: Arc<AtomicBool>,
    sinais: Receiver<Sinal>,
    vistos: Vec<Sinal>,
    thread: Option<JoinHandle<FimDoFluxo>>,
}

fn seguir_em_thread(servidor: &ServidorFalso, tempos: TemposDoFluxo) -> Rodando {
    let credencial = Credencial { servidor: servidor.base.clone(), token: TOKEN.into() };
    let parar = Arc::new(AtomicBool::new(false));
    let (envio, sinais) = channel();
    let de_parar = parar.clone();
    let thread = std::thread::spawn(move || {
        seguir_com(&credencial, &de_parar, &tempos, &mut |sinal| {
            let _ = envio.send(sinal);
        })
    });
    Rodando { parar, sinais, vistos: Vec::new(), thread: Some(thread) }
}

impl Rodando {
    fn recolher(&mut self) {
        while let Ok(sinal) = self.sinais.try_recv() {
            self.vistos.push(sinal);
        }
    }

    /// Espera uma condição sobre o que o fluxo já entregou.
    fn ate(&mut self, o_que: &str, condicao: impl Fn(&[Sinal]) -> bool) {
        let limite = Instant::now() + Duration::from_secs(8);
        loop {
            self.recolher();
            if condicao(&self.vistos) {
                return;
            }
            assert!(Instant::now() < limite, "não aconteceu: {o_que}; sinais: {:?}", self.vistos);
            std::thread::sleep(ms(5));
        }
    }

    /// Espera o fluxo acabar sozinho e devolve como acabou.
    fn fim(&mut self) -> FimDoFluxo {
        let thread = self.thread.take().expect("fluxo ainda rodando");
        let limite = Instant::now() + Duration::from_secs(8);
        while !thread.is_finished() {
            assert!(Instant::now() < limite, "o fluxo não acabou; sinais: {:?}", self.vistos);
            std::thread::sleep(ms(5));
        }
        self.recolher();
        thread.join().expect("thread do fluxo")
    }

    fn pedidos_de_carga(&self) -> usize {
        self.vistos.iter().filter(|sinal| **sinal == Sinal::Evento(Evento::Ressincronizar)).count()
    }
}

impl Drop for Rodando {
    fn drop(&mut self) {
        self.parar.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn conectou(vezes: usize) -> impl Fn(&[Sinal]) -> bool {
    move |sinais| sinais.iter().filter(|sinal| **sinal == Sinal::Conexao(Conexao::Conectada)).count() >= vezes
}

#[test]
fn a_primeira_conexao_leva_o_token_nao_leva_ponto_de_retomada_e_pede_carga_inicial() {
    let servidor = ServidorFalso::subir(|_, _| RespostaFalsa::fluxo(&ping("a-0")).segurando(ms(400)));
    let mut fluxo = seguir_em_thread(&servidor, rapido());
    fluxo.ate("carga inicial", |sinais| sinais.len() >= 2);

    assert_eq!(fluxo.vistos[..2], [Sinal::Conexao(Conexao::Conectada), Sinal::Evento(Evento::Ressincronizar)]);
    let pedido = &servidor.pedidos()[0];
    assert_eq!(pedido.linha, "GET /v1/eventos HTTP/1.1");
    assert_eq!(pedido.cabecalho("authorization"), Some(format!("Bearer {TOKEN}").as_str()));
    assert_eq!(pedido.cabecalho("accept"), Some("text/event-stream"));
    assert_eq!(pedido.cabecalho("last-event-id"), None);
}

#[test]
fn reconecta_do_ultimo_id_recebido_sem_pedir_carga_de_novo() {
    let servidor = ServidorFalso::subir(|numero, _| match numero {
        0 => RespostaFalsa::fluxo(&(ping("a-0") + &inicio_de_turno("a-1", "msgmsgmsgmsgmsg1"))),
        1 => RespostaFalsa::fluxo(&inicio_de_turno("a-2", "msgmsgmsgmsgmsg2")),
        _ => RespostaFalsa::json(401, RECUSA),
    });
    let mut fluxo = seguir_em_thread(&servidor, rapido());
    assert_eq!(fluxo.fim(), FimDoFluxo::NaoAutenticado);

    let pedidos = servidor.pedidos();
    assert_eq!(pedidos.len(), 3, "depois da recusa do token não há nova tentativa");
    assert_eq!(pedidos[1].cabecalho("last-event-id"), Some("a-1"));
    assert_eq!(pedidos[2].cabecalho("last-event-id"), Some("a-2"));
    // A carga inicial foi pedida uma vez só: a retomada não inventa outra.
    assert_eq!(fluxo.pedidos_de_carga(), 1);
    let eventos: Vec<_> =
        fluxo.vistos.iter().filter(|sinal| matches!(sinal, Sinal::Evento(Evento::TurnoIniciado { .. }))).cloned().collect();
    assert_eq!(eventos, vec![turno_iniciado("msgmsgmsgmsgmsg1"), turno_iniciado("msgmsgmsgmsgmsg2")]);
}

#[test]
fn o_id_do_sinal_de_vida_tambem_vale_como_ponto_de_retomada() {
    let servidor = ServidorFalso::subir(|numero, _| match numero {
        0 => RespostaFalsa::fluxo(&ping("p-7")),
        _ => RespostaFalsa::fluxo(&ping("p-7")).segurando(ms(400)),
    });
    let mut fluxo = seguir_em_thread(&servidor, rapido());
    fluxo.ate("segunda conexão", conectou(2));
    assert_eq!(servidor.pedidos()[1].cabecalho("last-event-id"), Some("p-7"));
    assert_eq!(fluxo.pedidos_de_carga(), 1);
}

#[test]
fn id_que_nao_cabe_num_cabecalho_nao_e_mandado_e_a_carga_e_pedida_de_novo() {
    let servidor = ServidorFalso::subir(|numero, _| match numero {
        0 => RespostaFalsa::fluxo(&ping("ação-1")),
        _ => RespostaFalsa::fluxo(&ping("ação-1")).segurando(ms(400)),
    });
    let mut fluxo = seguir_em_thread(&servidor, rapido());
    fluxo.ate("segunda conexão", conectou(2));
    fluxo.ate("segunda carga", |sinais| sinais.iter().filter(|sinal| **sinal == Sinal::Evento(Evento::Ressincronizar)).count() == 2);
    assert_eq!(servidor.pedidos()[1].cabecalho("last-event-id"), None);
}

#[test]
fn evento_fora_do_contrato_e_ignorado_mas_o_id_dele_vale() {
    let corpo = ping("x-0")
        + "id: x-1\nevent: evento\ndata: isto não é JSON\n\n"
        + "id: x-2\nevent: evento\ndata: {\"tipo\":\"evento_do_futuro\"}\n\n"
        + &inicio_de_turno("x-3", "msgmsgmsgmsgmsg3")
        + "id: x-4\nevent: evento\ndata: {\"tipo\":\"texto\",\"botId\":42}\n\n";
    let servidor = ServidorFalso::subir(move |numero, _| match numero {
        0 => RespostaFalsa::fluxo(&corpo),
        _ => RespostaFalsa::fluxo(&ping("x-4")).segurando(ms(400)),
    });
    let mut fluxo = seguir_em_thread(&servidor, rapido());
    fluxo.ate("segunda conexão", conectou(2));

    assert_eq!(servidor.pedidos()[1].cabecalho("last-event-id"), Some("x-4"));
    let eventos: Vec<_> = fluxo.vistos.iter().filter(|sinal| matches!(sinal, Sinal::Evento(_))).cloned().collect();
    assert_eq!(eventos, vec![Sinal::Evento(Evento::Ressincronizar), turno_iniciado("msgmsgmsgmsgmsg3")]);
}

#[test]
fn a_recusa_do_token_pelo_servidor_encerra_o_fluxo_sem_nova_tentativa() {
    let servidor = ServidorFalso::subir(|_, _| RespostaFalsa::json(401, RECUSA));
    let mut fluxo = seguir_em_thread(&servidor, rapido());
    assert_eq!(fluxo.fim(), FimDoFluxo::NaoAutenticado);
    std::thread::sleep(ms(150));
    assert_eq!(servidor.pedidos().len(), 1);
    assert!(fluxo.vistos.is_empty(), "nada é entregue antes de a conexão abrir: {:?}", fluxo.vistos);
}

#[test]
fn erro_no_caminho_so_faz_tentar_de_novo_e_a_conexao_seguinte_funciona() {
    let passageiros = [
        ("401 de proxy, com HTML", RespostaFalsa::html(401)),
        ("401 com outro código do contrato", RespostaFalsa::json(401, r#"{"erro":"codigo_invalido"}"#)),
        ("401 com JSON que não é do contrato", RespostaFalsa::json(401, r#"{"message":"unauthorized"}"#)),
        ("403", RespostaFalsa::json(403, RECUSA)),
        ("404", RespostaFalsa::html(404)),
        ("500", RespostaFalsa::json(500, r#"{"erro":"erro_interno"}"#)),
        ("503", RespostaFalsa::html(503)),
    ];
    for (caso, resposta) in passageiros {
        let servidor = ServidorFalso::subir(move |numero, _| match numero {
            0 => resposta.clone(),
            _ => RespostaFalsa::fluxo(&ping("b-0")).segurando(ms(400)),
        });
        let mut fluxo = seguir_em_thread(&servidor, rapido());
        fluxo.ate(caso, conectou(1));
        assert_eq!(fluxo.vistos[0], Sinal::Conexao(Conexao::Reconectando), "{caso}");
        assert!(!fluxo.thread.as_ref().is_some_and(JoinHandle::is_finished), "{caso}: o fluxo não devia ter acabado");
    }
}

#[test]
fn a_espera_cresce_a_cada_falha_seguida_e_a_ultima_se_repete() {
    let servidor = ServidorFalso::subir(|_, _| RespostaFalsa::html(503));
    let tempos = TemposDoFluxo { esperas: [ms(30), ms(70), ms(140), ms(260)], ..rapido() };
    let mut fluxo = seguir_em_thread(&servidor, tempos);
    let limite = Instant::now() + Duration::from_secs(8);
    while servidor.pedidos().len() < 6 {
        assert!(Instant::now() < limite, "só {} tentativas", servidor.pedidos().len());
        std::thread::sleep(ms(5));
    }
    fluxo.recolher();

    let momentos: Vec<_> = servidor.pedidos().iter().map(|pedido| pedido.recebido_em).collect();
    let intervalos: Vec<_> = momentos.windows(2).map(|par| par[1].duration_since(par[0])).collect();
    // Cada intervalo é, no mínimo, a espera daquela vez; a quinta repete a quarta.
    for (indice, minimo) in [30, 70, 140, 260, 260].into_iter().enumerate() {
        assert!(intervalos[indice] >= ms(minimo), "intervalo {indice}: {:?} < {minimo} ms; todos: {intervalos:?}", intervalos[indice]);
    }
    assert!(intervalos[0] < ms(70) + ms(250), "a primeira espera devia ser a curta: {intervalos:?}");
}

#[test]
fn conexao_que_durou_o_bastante_zera_a_espera() {
    // Estável, falha, estável, falha: se a contagem não zerasse, a segunda falha esperaria 3 s.
    let servidor = ServidorFalso::subir(|numero, _| match numero {
        0 | 2 => RespostaFalsa::fluxo(&ping("c-0")).segurando(ms(200)),
        1 | 3 => RespostaFalsa::html(503),
        _ => RespostaFalsa::fluxo(&ping("c-0")).segurando(ms(400)),
    });
    let tempos = TemposDoFluxo { esperas: [ms(20), ms(3000), ms(3000), ms(3000)], conexao_estavel: ms(120), ..rapido() };
    let inicio = Instant::now();
    let mut fluxo = seguir_em_thread(&servidor, tempos);
    fluxo.ate("terceira conexão aberta", conectou(3));
    assert!(inicio.elapsed() < ms(2000), "levou {:?}: a espera não foi zerada", inicio.elapsed());
}

#[test]
fn conexao_que_passa_do_teto_e_refeita_do_ponto_em_que_parou() {
    let servidor = ServidorFalso::subir(|_, _| RespostaFalsa::fluxo(&ping("d-0")).segurando(ms(4000)));
    let tempos = TemposDoFluxo { duracao_da_conexao: ms(200), conexao_estavel: ms(100), ..rapido() };
    let inicio = Instant::now();
    let mut fluxo = seguir_em_thread(&servidor, tempos);
    fluxo.ate("segunda conexão", conectou(2));
    assert!(inicio.elapsed() < ms(2500), "levou {:?}: o teto não cortou a conexão parada", inicio.elapsed());
    assert_eq!(servidor.pedidos()[1].cabecalho("last-event-id"), Some("d-0"));
    assert_eq!(fluxo.pedidos_de_carga(), 1);
}

#[test]
fn mandar_parar_durante_a_espera_encerra_logo_e_sem_nova_tentativa() {
    let servidor = ServidorFalso::subir(|_, _| RespostaFalsa::html(503));
    let tempos = TemposDoFluxo { esperas: [ms(5000); 4], ..rapido() };
    let mut fluxo = seguir_em_thread(&servidor, tempos);
    fluxo.ate("primeira falha", |sinais| sinais.contains(&Sinal::Conexao(Conexao::Reconectando)));

    let inicio = Instant::now();
    fluxo.parar.store(true, Ordering::Relaxed);
    assert_eq!(fluxo.fim(), FimDoFluxo::Parado);
    assert!(inicio.elapsed() < ms(1000), "levou {:?} para parar", inicio.elapsed());
    assert_eq!(servidor.pedidos().len(), 1);
}

#[test]
fn mandar_parar_com_a_conexao_aberta_nao_entrega_o_que_chega_depois() {
    // O servidor manda um evento, espera, e manda outro só depois de o fluxo ter sido parado.
    let servidor =
        ServidorFalso::subir(|_, _| RespostaFalsa::fluxo(&(ping("e-0") + &inicio_de_turno("e-1", "msgmsgmsgmsgmsg1"))).segurando(ms(300)));
    let mut fluxo = seguir_em_thread(&servidor, TemposDoFluxo { duracao_da_conexao: ms(600), ..rapido() });
    fluxo.ate("primeiro evento", |sinais| sinais.contains(&turno_iniciado("msgmsgmsgmsgmsg1")));
    fluxo.parar.store(true, Ordering::Relaxed);
    assert_eq!(fluxo.fim(), FimDoFluxo::Parado);
    assert_eq!(servidor.pedidos().len(), 1, "parado, o fluxo não reconecta");
}

/// O servidor de mentira só responde depois de receber o corpo inteiro do pedido. Se respondesse e
/// fechasse a conexão com o corpo por ler, o sistema mandaria um RST, e um POST cujo corpo chega
/// depois dos cabeçalhos perdia a resposta de vez em quando: foi o que reprovou um teste da janela na CI.
#[test]
fn o_servidor_de_mentira_espera_o_corpo_do_pedido_antes_de_responder() {
    use std::io::{Read, Write};
    use std::net::TcpStream;

    let servidor = ServidorFalso::subir(|_, _| RespostaFalsa::json(200, r#"{"ok":true}"#));
    let endereco = servidor.base.trim_start_matches("http://");
    let mut conexao = TcpStream::connect(endereco).expect("conexão com o servidor de mentira");
    let corpo = br#"{"decisao":"negar"}"#;
    let cabecalhos =
        format!("POST /v1/aprovacoes/aprovacao0000002 HTTP/1.1\r\nhost: {endereco}\r\ncontent-length: {}\r\n\r\n", corpo.len());
    conexao.write_all(cabecalhos.as_bytes()).expect("cabeçalhos enviados");
    conexao.flush().expect("cabeçalhos entregues");

    // Com o corpo ainda por vir, nada de resposta.
    conexao.set_read_timeout(Some(ms(300))).expect("prazo de leitura");
    let mut antes_do_corpo = [0u8; 16];
    let lido = conexao.read(&mut antes_do_corpo);
    assert!(
        matches!(&lido, Err(erro) if matches!(erro.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut)),
        "o servidor respondeu antes de receber o corpo: {lido:?}"
    );

    // Chegou o corpo: a resposta vem inteira.
    conexao.write_all(corpo).expect("corpo enviado");
    conexao.set_read_timeout(Some(ms(5000))).expect("prazo de leitura");
    let mut resposta = String::new();
    conexao.read_to_string(&mut resposta).expect("resposta lida até o fim");
    assert!(resposta.starts_with("HTTP/1.1 200 "), "resposta: {resposta}");
    assert!(resposta.ends_with(r#"{"ok":true}"#), "resposta: {resposta}");
    assert_eq!(servidor.pedidos().len(), 1);
}
