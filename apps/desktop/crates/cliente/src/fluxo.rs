//! O fluxo de eventos (`GET /v1/eventos`), com retomada de onde parou.
//!
//! `seguir` bloqueia a thread de quem chama até mandarem parar ou o servidor recusar o token.
//! Cada conexão dura no máximo `duracao_da_conexao` e é refeita do último `id` recebido: o
//! cliente HTTP não tem prazo por leitura, e este teto é o que impede uma conexão que morreu
//! em silêncio de ficar aberta para sempre.

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use ureq::Agent;

use crate::api::{Credencial, ErroApi, configurar_agente, erro_do_status};
use crate::contrato::{Evento, INTERVALO_PING_MS};
use crate::sse::AnalisadorSse;

/// Os tempos do fluxo. Só os testes usam outros valores.
#[derive(Debug, Clone, Copy)]
pub struct TemposDoFluxo {
    /// Espera antes de cada nova tentativa seguida; a última vale para todas as seguintes.
    pub esperas: [Duration; 4],
    /// Teto de cada conexão.
    pub duracao_da_conexao: Duration,
    /// Só a conexão que durou isto zera a contagem de falhas.
    pub conexao_estavel: Duration,
}

impl Default for TemposDoFluxo {
    fn default() -> Self {
        Self {
            esperas: [Duration::from_secs(1), Duration::from_secs(2), Duration::from_secs(5), Duration::from_secs(15)],
            // Quatro sinais de vida.
            duracao_da_conexao: Duration::from_millis(4 * INTERVALO_PING_MS),
            // Um sinal de vida inteiro.
            conexao_estavel: Duration::from_millis(INTERVALO_PING_MS),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Conexao {
    Conectada,
    Reconectando,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Sinal {
    Evento(Evento),
    Conexao(Conexao),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FimDoFluxo {
    /// Quem chamou mandou parar.
    Parado,
    /// O servidor recusou o token. O fluxo não tenta de novo.
    NaoAutenticado,
}

enum FimDaConexao {
    /// A conexão acabou (teto, rede, servidor fora): tentar de novo.
    Refazer {
        durou: Duration,
    },
    Parado,
    NaoAutenticado,
}

fn agente(tempos: &TemposDoFluxo) -> Agent {
    configurar_agente()
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_recv_response(Some(Duration::from_secs(15)))
        .timeout_recv_body(Some(tempos.duracao_da_conexao))
        .build()
        .new_agent()
}

/// Só vai no cabeçalho um id que cabe num cabeçalho.
fn cabe_no_cabecalho(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
}

fn uma_conexao(
    agente: &Agent,
    credencial: &Credencial,
    ultimo_id: &mut Option<String>,
    parar: &AtomicBool,
    ao_sinal: &mut dyn FnMut(Sinal),
) -> FimDaConexao {
    let inicio = Instant::now();
    let refazer = || FimDaConexao::Refazer { durou: inicio.elapsed() };

    let retomando = ultimo_id.as_deref().filter(|id| cabe_no_cabecalho(id)).map(str::to_owned);
    let mut pedido = agente
        .get(format!("{}/v1/eventos", credencial.servidor))
        .header("accept", "text/event-stream")
        .header("authorization", format!("Bearer {}", credencial.token));
    if let Some(id) = &retomando {
        pedido = pedido.header("last-event-id", id);
    }
    let Ok(mut resposta) = pedido.call() else { return refazer() };

    let status = resposta.status().as_u16();
    if status != 200 {
        // Um 401 só desfaz o pareamento se foi o servidor que recusou o token. O de um proxy
        // ou do túnel é falha passageira.
        let corpo = resposta.body_mut().read_to_string().unwrap_or_default();
        return match erro_do_status(status, &corpo) {
            ErroApi::NaoAutenticado => FimDaConexao::NaoAutenticado,
            _ => refazer(),
        };
    }

    let mut leitor = resposta.into_body().into_reader();
    let mut analisador = AnalisadorSse::new();
    let mut pedaco = [0u8; 8192];
    let mut recebeu = false;
    loop {
        let lidos = match leitor.read(&mut pedaco) {
            Ok(0) | Err(_) => return refazer(),
            Ok(lidos) => lidos,
        };
        // Depois de mandarem parar, nada do pedaço que estava em leitura é entregue.
        if parar.load(Ordering::Relaxed) {
            return FimDaConexao::Parado;
        }
        if !recebeu {
            recebeu = true;
            ao_sinal(Sinal::Conexao(Conexao::Conectada));
            // Sem `Last-Event-ID` o servidor não repõe nada nem avisa: o que foi buscado antes de a
            // conexão abrir pode ter mudado sem evento, então vale o mesmo que um `ressincronizar`.
            if retomando.is_none() {
                ao_sinal(Sinal::Evento(Evento::Ressincronizar));
            }
        }
        for bruto in analisador.alimentar(&pedaco[..lidos]) {
            // O id vale como ponto de retomada venha de onde vier: de um evento ou do sinal de vida.
            if let Some(id) = bruto.id {
                *ultimo_id = Some(id);
            }
            if bruto.evento != "evento" {
                continue;
            }
            if let Ok(evento) = serde_json::from_str::<Evento>(&bruto.dados) {
                ao_sinal(Sinal::Evento(evento));
            }
        }
    }
}

/// Dorme em passos curtos, para um pedido de parada não esperar a espera inteira.
fn esperar(duracao: Duration, parar: &AtomicBool) {
    let fim = Instant::now() + duracao;
    while Instant::now() < fim && !parar.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(5).min(duracao));
    }
}

/// Segue o fluxo de eventos até `parar` virar verdadeiro ou o servidor recusar o token.
/// Erro de rede nunca encerra: só faz tentar de novo, com espera crescente.
pub fn seguir(credencial: &Credencial, parar: &AtomicBool, ao_sinal: &mut dyn FnMut(Sinal)) -> FimDoFluxo {
    seguir_com(credencial, parar, &TemposDoFluxo::default(), ao_sinal)
}

/// `seguir`, com os tempos dados.
pub fn seguir_com(credencial: &Credencial, parar: &AtomicBool, tempos: &TemposDoFluxo, ao_sinal: &mut dyn FnMut(Sinal)) -> FimDoFluxo {
    let agente = agente(tempos);
    let mut ultimo_id: Option<String> = None;
    let mut falhas = 0usize;
    loop {
        if parar.load(Ordering::Relaxed) {
            return FimDoFluxo::Parado;
        }
        match uma_conexao(&agente, credencial, &mut ultimo_id, parar, ao_sinal) {
            FimDaConexao::Parado => return FimDoFluxo::Parado,
            FimDaConexao::NaoAutenticado => return FimDoFluxo::NaoAutenticado,
            FimDaConexao::Refazer { durou } if durou >= tempos.conexao_estavel => falhas = 0,
            FimDaConexao::Refazer { .. } => {
                if !parar.load(Ordering::Relaxed) {
                    ao_sinal(Sinal::Conexao(Conexao::Reconectando));
                }
                esperar(tempos.esperas[falhas.min(tempos.esperas.len() - 1)], parar);
                falhas += 1;
            }
        }
    }
}

#[cfg(test)]
mod testes {
    use super::*;

    #[test]
    fn so_id_imprimivel_vai_no_cabecalho() {
        assert!(cabe_no_cabecalho("a1b2-17"));
        for ruim in ["", "com\nquebra", "acentuação", "nulo\0"] {
            assert!(!cabe_no_cabecalho(ruim), "{ruim:?}");
        }
    }

    #[test]
    fn os_tempos_de_producao_sao_os_do_app_de_celular() {
        let tempos = TemposDoFluxo::default();
        assert_eq!(tempos.esperas.map(|espera| espera.as_secs()), [1, 2, 5, 15]);
        assert_eq!(tempos.conexao_estavel, Duration::from_millis(INTERVALO_PING_MS));
        assert!(tempos.duracao_da_conexao > tempos.conexao_estavel);
    }
}
