//! Pedidos HTTP ao servidor. Bloqueiam a thread de quem chama: a interface os roda em segundo plano.

use std::time::Duration;

use serde::Serialize;
use serde::de::DeserializeOwned;
use ureq::tls::{RootCerts, TlsConfig};
use ureq::{Agent, Body, http};

use crate::contrato::{
    Aprovacao, Bot, BotEdicao, BotEntrada, DecisaoAprovacao, Erro, ListaAprovacoes, ListaBots, ListaMensagens, PedidoPareamento,
    PedidoTurno, RespostaPareamento, RespostaTurno, Saude,
};

/// Código que o servidor manda quando recusa o token do aparelho.
const NAO_AUTENTICADO: &str = "nao_autenticado";

/// O que o aparelho guarda depois de pareado: onde o servidor está e o token dele.
#[derive(Clone, PartialEq, Eq)]
pub struct Credencial {
    pub servidor: String,
    pub token: String,
}

// O token nunca aparece numa mensagem de depuração.
impl std::fmt::Debug for Credencial {
    fn fmt(&self, saida: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        saida.debug_struct("Credencial").field("servidor", &self.servidor).field("token", &"(oculto)").finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ErroApi {
    /// O servidor recusou o token: 401 com `nao_autenticado` no corpo. Só este erro desfaz o pareamento.
    NaoAutenticado,
    /// Resposta de erro do servidor, com o código do contrato.
    Servidor { status: u16, codigo: String },
    /// Status de erro com corpo fora do contrato: veio de um proxy ou do túnel, não do servidor.
    NoCaminho { status: u16 },
    /// Sem resposta: rede, prazo, certificado ou redirecionamento.
    Rede(String),
    /// Resposta de sucesso que não segue o contrato.
    RespostaInvalida,
    /// Identificador que não tem a forma dos ids do servidor.
    IdInvalido,
}

impl std::fmt::Display for ErroApi {
    fn fmt(&self, saida: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NaoAutenticado => write!(saida, "o servidor não reconhece mais este aparelho"),
            Self::Servidor { status, codigo } => write!(saida, "o servidor respondeu {status} ({codigo})"),
            Self::NoCaminho { status } => write!(saida, "resposta {status} no caminho até o servidor"),
            Self::Rede(motivo) => write!(saida, "sem resposta do servidor: {motivo}"),
            Self::RespostaInvalida => write!(saida, "o servidor respondeu algo fora do contrato"),
            Self::IdInvalido => write!(saida, "identificador inválido"),
        }
    }
}

impl std::error::Error for ErroApi {}

/// Os ids do servidor têm 16 letras minúsculas ou dígitos. Nada fora disso entra num caminho.
pub(crate) fn id_valido(id: &str) -> bool {
    id.len() == 16 && id.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
}

/// A configuração comum dos agentes: status de erro chega como resposta, para o corpo ser lido;
/// redirecionamento é erro; certificado conferido pelo sistema.
pub(crate) fn configurar_agente() -> ureq::config::ConfigBuilder<ureq::typestate::AgentScope> {
    Agent::config_builder()
        .http_status_as_error(false)
        .max_redirects(0)
        .max_redirects_will_error(true)
        .user_agent(concat!("awikabot-desktop/", env!("CARGO_PKG_VERSION")))
        .tls_config(TlsConfig::builder().root_certs(RootCerts::PlatformVerifier).build())
}

/// Lê o corpo de um status de erro e diz quem recusou: o servidor, pelo contrato, ou algo no caminho.
pub(crate) fn erro_do_status(status: u16, corpo: &str) -> ErroApi {
    match serde_json::from_str::<Erro>(corpo) {
        Ok(erro) if status == 401 && erro.erro == NAO_AUTENTICADO => ErroApi::NaoAutenticado,
        Ok(erro) => ErroApi::Servidor { status, codigo: erro.erro },
        Err(_) => ErroApi::NoCaminho { status },
    }
}

type Resposta = Result<http::Response<Body>, ureq::Error>;

fn ler_texto(resposta: Resposta) -> Result<(u16, String), ErroApi> {
    let mut resposta = resposta.map_err(|erro| ErroApi::Rede(erro.to_string()))?;
    let status = resposta.status().as_u16();
    let corpo = resposta.body_mut().read_to_string().map_err(|erro| ErroApi::Rede(erro.to_string()))?;
    Ok((status, corpo))
}

fn ler<T: DeserializeOwned>(resposta: Resposta) -> Result<T, ErroApi> {
    let (status, corpo) = ler_texto(resposta)?;
    if !(200..300).contains(&status) {
        return Err(erro_do_status(status, &corpo));
    }
    serde_json::from_str(&corpo).map_err(|_| ErroApi::RespostaInvalida)
}

fn ler_sem_corpo(resposta: Resposta) -> Result<(), ErroApi> {
    let (status, corpo) = ler_texto(resposta)?;
    if (200..300).contains(&status) { Ok(()) } else { Err(erro_do_status(status, &corpo)) }
}

fn portador(credencial: &Credencial) -> String {
    format!("Bearer {}", credencial.token)
}

/// Cliente dos pedidos comuns. Barato de clonar: o agente compartilha as conexões.
#[derive(Clone)]
pub struct Api {
    agente: Agent,
}

impl Default for Api {
    fn default() -> Self {
        Self::new()
    }
}

impl Api {
    pub fn new() -> Self {
        Self { agente: configurar_agente().timeout_global(Some(Duration::from_secs(15))).build().new_agent() }
    }

    fn obter<T: DeserializeOwned>(&self, credencial: &Credencial, caminho: &str) -> Result<T, ErroApi> {
        let url = format!("{}{caminho}", credencial.servidor);
        ler(self.agente.get(url).header("accept", "application/json").header("authorization", portador(credencial)).call())
    }

    fn enviar<T: DeserializeOwned>(
        &self,
        servidor: &str,
        token: Option<&str>,
        caminho: &str,
        corpo: &impl Serialize,
    ) -> Result<T, ErroApi> {
        let mut pedido = self.agente.post(format!("{servidor}{caminho}")).header("accept", "application/json");
        if let Some(token) = token {
            pedido = pedido.header("authorization", format!("Bearer {token}"));
        }
        ler(pedido.send_json(corpo))
    }

    /// `GET /healthz`: não pede token e só diz se o servidor está de pé.
    pub fn saude(&self, servidor: &str) -> Result<Saude, ErroApi> {
        ler(self.agente.get(format!("{servidor}/healthz")).header("accept", "application/json").call())
    }

    /// Troca o código de uso único pelo token deste aparelho. O código vai como a pessoa digitou.
    pub fn parear(&self, servidor: &str, pedido: &PedidoPareamento) -> Result<RespostaPareamento, ErroApi> {
        self.enviar(servidor, None, "/v1/parear", pedido)
    }

    /// "Desparear": o aparelho invalida o próprio token no servidor.
    pub fn revogar_dispositivo(&self, credencial: &Credencial) -> Result<(), ErroApi> {
        let url = format!("{}/v1/dispositivo", credencial.servidor);
        ler_sem_corpo(self.agente.delete(url).header("authorization", portador(credencial)).call())
    }

    pub fn listar_bots(&self, credencial: &Credencial) -> Result<ListaBots, ErroApi> {
        self.obter(credencial, "/v1/bots")
    }

    pub fn criar_bot(&self, credencial: &Credencial, entrada: &BotEntrada) -> Result<Bot, ErroApi> {
        self.enviar(&credencial.servidor, Some(&credencial.token), "/v1/bots", entrada)
    }

    /// `PATCH /v1/bots/:id`: só os campos presentes mudam. Modelo `Some(None)` vai como `null` e
    /// quer dizer "voltar ao padrão do motor".
    pub fn editar_bot(&self, credencial: &Credencial, bot_id: &str, edicao: &BotEdicao) -> Result<Bot, ErroApi> {
        if !id_valido(bot_id) {
            return Err(ErroApi::IdInvalido);
        }
        let url = format!("{}/v1/bots/{bot_id}", credencial.servidor);
        ler(self.agente.patch(url).header("accept", "application/json").header("authorization", portador(credencial)).send_json(edicao))
    }

    /// A página mais recente da conversa, em ordem crescente.
    pub fn listar_mensagens(&self, credencial: &Credencial, bot_id: &str) -> Result<ListaMensagens, ErroApi> {
        if !id_valido(bot_id) {
            return Err(ErroApi::IdInvalido);
        }
        self.obter(credencial, &format!("/v1/bots/{bot_id}/mensagens"))
    }

    pub fn enviar_turno(&self, credencial: &Credencial, bot_id: &str, pedido: &PedidoTurno) -> Result<RespostaTurno, ErroApi> {
        if !id_valido(bot_id) {
            return Err(ErroApi::IdInvalido);
        }
        self.enviar(&credencial.servidor, Some(&credencial.token), &format!("/v1/bots/{bot_id}/turnos"), pedido)
    }

    /// `POST /v1/bots/:id/turnos/atual/parar`: responde 204 sem corpo; sem turno ativo, 409
    /// `sem_turno_ativo`. A resposta parada chega pelo fluxo, em `turno_terminado`.
    pub fn parar_turno(&self, credencial: &Credencial, bot_id: &str) -> Result<(), ErroApi> {
        if !id_valido(bot_id) {
            return Err(ErroApi::IdInvalido);
        }
        let url = format!("{}/v1/bots/{bot_id}/turnos/atual/parar", credencial.servidor);
        ler_sem_corpo(self.agente.post(url).header("accept", "application/json").header("authorization", portador(credencial)).send_empty())
    }

    /// Os pedidos de aprovação pendentes, de todos os bots, do mais antigo para o mais novo.
    pub fn listar_aprovacoes(&self, credencial: &Credencial) -> Result<ListaAprovacoes, ErroApi> {
        self.obter(credencial, "/v1/aprovacoes")
    }

    /// Aprova ou nega um pedido. Só um aparelho pareado decide; o motor só pede.
    pub fn decidir_aprovacao(&self, credencial: &Credencial, aprovacao_id: &str, decisao: &DecisaoAprovacao) -> Result<Aprovacao, ErroApi> {
        if !id_valido(aprovacao_id) {
            return Err(ErroApi::IdInvalido);
        }
        self.enviar(&credencial.servidor, Some(&credencial.token), &format!("/v1/aprovacoes/{aprovacao_id}"), decisao)
    }
}

#[cfg(test)]
mod testes {
    use super::*;

    #[test]
    fn so_o_401_do_servidor_desfaz_o_pareamento() {
        assert_eq!(erro_do_status(401, r#"{"erro":"nao_autenticado"}"#), ErroApi::NaoAutenticado);
        // 401 com outro código, ou de outro status, é erro do servidor, não recusa do token.
        assert_eq!(
            erro_do_status(401, r#"{"erro":"codigo_invalido"}"#),
            ErroApi::Servidor { status: 401, codigo: "codigo_invalido".into() }
        );
        assert_eq!(
            erro_do_status(403, r#"{"erro":"nao_autenticado"}"#),
            ErroApi::Servidor { status: 403, codigo: "nao_autenticado".into() }
        );
        // 401 de proxy ou de túnel: corpo que não é do contrato.
        assert_eq!(erro_do_status(401, "<html>Unauthorized</html>"), ErroApi::NoCaminho { status: 401 });
        assert_eq!(erro_do_status(401, ""), ErroApi::NoCaminho { status: 401 });
        assert_eq!(erro_do_status(502, r#"{"mensagem":"bad gateway"}"#), ErroApi::NoCaminho { status: 502 });
    }

    #[test]
    fn so_ids_do_servidor_entram_num_caminho() {
        assert!(id_valido("abcdefgh12345678"));
        for ruim in ["", "abc", "abcdefgh1234567/", "../../../../etc/x", "ABCDEFGH12345678", "abcdefgh123456789"] {
            assert!(!id_valido(ruim), "{ruim}");
        }
    }

    #[test]
    fn a_credencial_nao_mostra_o_token() {
        let credencial = Credencial { servidor: "https://bots.exemplo.com".into(), token: "segredo-do-aparelho".into() };
        assert!(!format!("{credencial:?}").contains("segredo-do-aparelho"));
    }
}
