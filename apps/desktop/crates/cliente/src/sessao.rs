//! A sessão que o computador guarda depois de pareado, e o cofre onde ela fica.
//!
//! Mesmas regras de `apps/mobile/src/lib/sessao.ts`: o que volta do cofre fora do formato não é
//! sessão; o endereço guardado tem de ser igual à própria forma normal; e quando não dá para
//! apagar, grava-se um valor que não é sessão, para a próxima abertura cair no pareamento.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::api::Credencial;
use crate::contrato::Dispositivo;
use crate::endereco::normalizar_endereco;

#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct Sessao {
    /// URL base do servidor, já normalizada, sem barra no fim.
    pub servidor: String,
    pub token: String,
    pub dispositivo: Dispositivo,
}

// O token nunca aparece numa mensagem de depuração.
impl std::fmt::Debug for Sessao {
    fn fmt(&self, saida: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        saida
            .debug_struct("Sessao")
            .field("servidor", &self.servidor)
            .field("token", &"(oculto)")
            .field("dispositivo", &self.dispositivo)
            .finish()
    }
}

impl Sessao {
    pub fn credencial(&self) -> Credencial {
        Credencial { servidor: self.servidor.clone(), token: self.token.clone() }
    }
}

pub fn serializar(sessao: &Sessao) -> String {
    // Uma estrutura só com textos e números sempre vira JSON.
    serde_json::to_string(sessao).unwrap_or_default()
}

/// Lê o que estava no cofre. Qualquer coisa fora do formato vira `None`.
pub fn ler_guardada(texto: Option<&str>) -> Option<Sessao> {
    let sessao: Sessao = serde_json::from_str(texto?).ok()?;
    // O endereço guardado passa pela mesma regra de quando foi digitado: um cofre adulterado
    // não consegue apontar o app para `http://` fora da rede local.
    let endereco_normal = normalizar_endereco(&sessao.servidor).is_ok_and(|normal| normal == sessao.servidor);
    // O token vai num cabeçalho: só caracteres visíveis, sem espaço.
    let token_cabe = !sessao.token.is_empty() && sessao.token.bytes().all(|byte| (0x21..=0x7e).contains(&byte));
    (endereco_normal && token_cabe).then_some(sessao)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ErroDoCofre(pub String);

impl std::fmt::Display for ErroDoCofre {
    fn fmt(&self, saida: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(saida, "cofre do sistema: {}", self.0)
    }
}

impl std::error::Error for ErroDoCofre {}

/// Onde a sessão fica guardada no computador. No app, o cofre de credenciais do sistema.
pub trait Cofre: Send + Sync {
    fn ler(&self) -> Result<Option<String>, ErroDoCofre>;
    fn gravar(&self, valor: &str) -> Result<(), ErroDoCofre>;
    fn apagar(&self) -> Result<(), ErroDoCofre>;
}

/// Lê a sessão na partida do app. Cofre vazio, ilegível ou com falha dá no mesmo: sem sessão.
pub fn carregar(cofre: &dyn Cofre) -> Option<Sessao> {
    ler_guardada(cofre.ler().ok().flatten().as_deref())
}

/// Guarda a sessão nova. Quem chama só passa a usá-la se isto der certo.
pub fn guardar(cofre: &dyn Cofre, sessao: &Sessao) -> Result<(), ErroDoCofre> {
    cofre.gravar(&serializar(sessao))
}

/// Esquece a sessão. Sem conseguir apagar, grava um valor que não é sessão.
pub fn esquecer(cofre: &dyn Cofre) -> Result<(), ErroDoCofre> {
    cofre.apagar().or_else(|_| cofre.gravar(""))
}

/// Cofre que vive só na memória: para os testes, e para um sistema sem cofre de credenciais.
#[derive(Default)]
pub struct CofreEmMemoria {
    estado: Mutex<EstadoDoCofre>,
}

#[derive(Default)]
struct EstadoDoCofre {
    valor: Option<String>,
    falha_ao_ler: bool,
    falha_ao_gravar: bool,
    falha_ao_apagar: bool,
    tentativas_de_gravar: Vec<String>,
}

impl CofreEmMemoria {
    pub fn com(valor: &str) -> Self {
        let cofre = Self::default();
        cofre.travado().valor = Some(valor.to_owned());
        cofre
    }

    fn travado(&self) -> std::sync::MutexGuard<'_, EstadoDoCofre> {
        // Um teste que entrou em pânico com a trava na mão não deve esconder a falha original atrás desta.
        self.estado.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn valor(&self) -> Option<String> {
        self.travado().valor.clone()
    }

    /// Tudo o que alguém tentou gravar, tenha dado certo ou não.
    pub fn tentativas_de_gravar(&self) -> Vec<String> {
        self.travado().tentativas_de_gravar.clone()
    }

    pub fn falhar_ao_ler(&self, falha: bool) {
        self.travado().falha_ao_ler = falha;
    }

    pub fn falhar_ao_gravar(&self, falha: bool) {
        self.travado().falha_ao_gravar = falha;
    }

    pub fn falhar_ao_apagar(&self, falha: bool) {
        self.travado().falha_ao_apagar = falha;
    }
}

impl Cofre for CofreEmMemoria {
    fn ler(&self) -> Result<Option<String>, ErroDoCofre> {
        let estado = self.travado();
        if estado.falha_ao_ler { Err(ErroDoCofre("leitura recusada".into())) } else { Ok(estado.valor.clone()) }
    }

    fn gravar(&self, valor: &str) -> Result<(), ErroDoCofre> {
        let mut estado = self.travado();
        estado.tentativas_de_gravar.push(valor.to_owned());
        if estado.falha_ao_gravar {
            return Err(ErroDoCofre("gravação recusada".into()));
        }
        estado.valor = Some(valor.to_owned());
        Ok(())
    }

    fn apagar(&self) -> Result<(), ErroDoCofre> {
        let mut estado = self.travado();
        if estado.falha_ao_apagar {
            return Err(ErroDoCofre("remoção recusada".into()));
        }
        estado.valor = None;
        Ok(())
    }
}

#[cfg(test)]
mod testes {
    use super::*;

    fn sessao(servidor: &str, token: &str) -> Sessao {
        Sessao {
            servidor: servidor.into(),
            token: token.into(),
            dispositivo: Dispositivo { id: "abcdefgh12345678".into(), nome: "Computador de teste".into(), criado_em: 1 },
        }
    }

    fn padrao() -> Sessao {
        sessao("https://bots.exemplo.com", &"t".repeat(43))
    }

    #[test]
    fn le_de_volta_o_que_serializar_gravou() {
        assert_eq!(ler_guardada(Some(&serializar(&padrao()))), Some(padrao()));
        let local = sessao("http://192.168.0.10:8790", &"u".repeat(43));
        assert_eq!(ler_guardada(Some(&serializar(&local))), Some(local));
    }

    #[test]
    fn o_que_esta_fora_do_formato_nao_e_sessao() {
        let ruins = [
            String::new(),
            "isto não é JSON".to_owned(),
            "null".to_owned(),
            "42".to_owned(),
            r#"{"servidor":"https://bots.exemplo.com"}"#.to_owned(),
            r#"{"servidor":42,"token":"x","dispositivo":{"id":"a","nome":"b","criadoEm":1}}"#.to_owned(),
            r#"{"servidor":"https://bots.exemplo.com","token":"tttt"}"#.to_owned(),
            // Endereço que não é a própria forma normal: barra no fim, maiúsculas, porta padrão.
            serializar(&sessao("https://bots.exemplo.com/", &"t".repeat(43))),
            serializar(&sessao("https://Bots.Exemplo.com", &"t".repeat(43))),
            serializar(&sessao("https://bots.exemplo.com:443", &"t".repeat(43))),
            // Cofre adulterado para mandar o token em claro para fora da rede local.
            serializar(&sessao("http://bots.exemplo.com", &"t".repeat(43))),
            serializar(&sessao("ftp://bots.exemplo.com", &"t".repeat(43))),
            // Token que não cabe num cabeçalho.
            serializar(&sessao("https://bots.exemplo.com", "")),
            serializar(&sessao("https://bots.exemplo.com", "com espaço")),
            serializar(&sessao("https://bots.exemplo.com", "com\r\nquebra: injetada")),
        ];
        for ruim in ruins {
            assert_eq!(ler_guardada(Some(&ruim)), None, "{ruim:?}");
        }
        assert_eq!(ler_guardada(None), None);
    }

    #[test]
    fn a_sessao_nao_mostra_o_token_na_depuracao() {
        let texto = format!("{:?}", sessao("https://bots.exemplo.com", "segredo-do-computador"));
        assert!(!texto.contains("segredo-do-computador"));
    }

    #[test]
    fn carrega_a_sessao_guardada_e_fica_sem_sessao_com_cofre_vazio_ou_com_falha() {
        assert_eq!(carregar(&CofreEmMemoria::default()), None);
        let cofre = CofreEmMemoria::com(&serializar(&padrao()));
        assert_eq!(carregar(&cofre), Some(padrao()));
        cofre.falhar_ao_ler(true);
        assert_eq!(carregar(&cofre), None);
    }

    #[test]
    fn guardar_grava_no_cofre_e_avisa_quando_o_cofre_recusa() {
        let cofre = CofreEmMemoria::default();
        assert_eq!(guardar(&cofre, &padrao()), Ok(()));
        assert_eq!(carregar(&cofre), Some(padrao()));

        cofre.falhar_ao_gravar(true);
        let outra = sessao("https://outro.exemplo.com", &"o".repeat(43));
        assert!(guardar(&cofre, &outra).is_err());
        // A sessão anterior continua lá: quem chamou não passa a usar a nova.
        assert_eq!(carregar(&cofre), Some(padrao()));
    }

    #[test]
    fn esquecer_apaga_o_cofre() {
        let cofre = CofreEmMemoria::com(&serializar(&padrao()));
        assert_eq!(esquecer(&cofre), Ok(()));
        assert_eq!(cofre.valor(), None);
        assert_eq!(carregar(&cofre), None);
    }

    #[test]
    fn esquecer_grava_um_valor_inutil_quando_nao_consegue_apagar() {
        let cofre = CofreEmMemoria::com(&serializar(&padrao()));
        cofre.falhar_ao_apagar(true);
        assert_eq!(esquecer(&cofre), Ok(()));
        assert_eq!(cofre.valor().as_deref(), Some(""));
        assert_eq!(carregar(&cofre), None);
    }

    #[test]
    fn esquecer_avisa_quando_nao_consegue_nem_apagar_nem_gravar() {
        let cofre = CofreEmMemoria::com(&serializar(&padrao()));
        cofre.falhar_ao_apagar(true);
        cofre.falhar_ao_gravar(true);
        assert!(esquecer(&cofre).is_err());
        // Nada mudou: a próxima abertura ainda encontra a sessão, e o servidor é quem a recusa.
        assert_eq!(carregar(&cofre), Some(padrao()));
    }

    #[test]
    fn desparear_e_parear_em_seguida_termina_com_a_sessao_nova_no_cofre() {
        let cofre = CofreEmMemoria::com(&serializar(&padrao()));
        let nova = sessao("https://novo.exemplo.com", &"n".repeat(43));
        assert_eq!(esquecer(&cofre), Ok(()));
        assert_eq!(guardar(&cofre, &nova), Ok(()));
        assert_eq!(carregar(&cofre), Some(nova));
    }
}
