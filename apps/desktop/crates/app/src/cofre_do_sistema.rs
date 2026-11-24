//! A sessão no cofre de credenciais do sistema: Gerenciador de Credenciais no Windows, Chaves no
//! macOS. O token do computador nunca vai para um arquivo comum.

use awikabot_cliente::sessao::{Cofre, ErroDoCofre};

/// Nome do item dentro do serviço. Um computador guarda uma sessão só.
const ITEM: &str = "sessao";

pub struct CofreDoSistema {
    servico: String,
}

impl CofreDoSistema {
    /// O cofre do app. Em desenvolvimento o serviço tem outro nome, para um build de teste não
    /// mexer na sessão do app instalado. Ainda em desenvolvimento, `AWIKA_COFRE_DE_PROVA` troca
    /// o serviço por um só daquela execução: é o que a prova visual usa para não mexer na sessão
    /// de quem desenvolve. O build de release ignora a variável.
    pub fn do_app() -> Self {
        if !cfg!(debug_assertions) {
            return Self::com_servico("awikabot");
        }
        let de_prova = std::env::var("AWIKA_COFRE_DE_PROVA")
            .ok()
            .filter(|nome| !nome.is_empty() && nome.len() <= 40 && nome.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'));
        match de_prova {
            Some(nome) => Self::com_servico(&format!("awikabot (prova {nome})")),
            None => Self::com_servico("awikabot (desenvolvimento)"),
        }
    }

    pub fn com_servico(servico: &str) -> Self {
        Self { servico: servico.to_owned() }
    }

    fn item(&self) -> Result<keyring::Entry, ErroDoCofre> {
        keyring::Entry::new(&self.servico, ITEM).map_err(erro)
    }
}

/// A mensagem do sistema, sem o valor guardado: os erros do cofre não o carregam.
fn erro(erro: keyring::Error) -> ErroDoCofre {
    ErroDoCofre(erro.to_string())
}

impl Cofre for CofreDoSistema {
    fn ler(&self) -> Result<Option<String>, ErroDoCofre> {
        match self.item()?.get_password() {
            Ok(valor) => Ok(Some(valor)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(outro) => Err(erro(outro)),
        }
    }

    fn gravar(&self, valor: &str) -> Result<(), ErroDoCofre> {
        self.item()?.set_password(valor).map_err(erro)
    }

    fn apagar(&self) -> Result<(), ErroDoCofre> {
        match self.item()?.delete_credential() {
            // Apagar o que não existe já deixa o cofre como se queria.
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(outro) => Err(erro(outro)),
        }
    }
}

#[cfg(test)]
mod testes {
    use super::*;

    /// Grava, lê e apaga um item de teste no cofre de verdade deste computador, num serviço com o
    /// número do processo no nome. O item é apagado no fim, passe ou falhe.
    #[test]
    #[cfg_attr(target_os = "macos", ignore = "na CI do macOS o chaveiro pode pedir senha; conferir num Mac")]
    fn grava_le_e_apaga_no_cofre_de_verdade() {
        struct Limpeza<'a>(&'a CofreDoSistema);
        impl Drop for Limpeza<'_> {
            fn drop(&mut self) {
                let _ = self.0.apagar();
            }
        }

        let cofre = CofreDoSistema::com_servico(&format!("awikabot-teste-{}", std::process::id()));
        let _limpeza = Limpeza(&cofre);

        assert_eq!(cofre.ler(), Ok(None), "o serviço de teste começa vazio");
        assert_eq!(cofre.apagar(), Ok(()), "apagar o que não existe não é erro");

        let valor = r#"{"servidor":"https://bots.exemplo.com","token":"valor de teste, com acentuação"}"#;
        assert_eq!(cofre.gravar(valor), Ok(()));
        assert_eq!(cofre.ler().as_ref().map(|lido| lido.as_deref()), Ok(Some(valor)));

        assert_eq!(cofre.gravar("outro"), Ok(()));
        assert_eq!(cofre.ler().as_ref().map(|lido| lido.as_deref()), Ok(Some("outro")));

        assert_eq!(cofre.apagar(), Ok(()));
        assert_eq!(cofre.ler(), Ok(None));
    }
}
