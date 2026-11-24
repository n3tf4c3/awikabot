//! O pouco que o app lembra entre uma abertura e outra e que não é segredo: se a pessoa quer ser
//! avisada de versão nova, e quando foi a última consulta. Fica num arquivo comum, na pasta de
//! dados do app. A sessão não entra aqui: ela vai no cofre do sistema.

use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

fn ligado() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Preferencias {
    /// Consultar uma vez por dia se há versão nova. Ligado até a pessoa desligar.
    #[serde(default = "ligado")]
    pub avisar_de_versao_nova: bool,
    /// Quando foi a última consulta que deu certo, em segundos desde 1970.
    #[serde(default)]
    pub ultima_consulta_s: Option<u64>,
}

impl Default for Preferencias {
    fn default() -> Self {
        Self { avisar_de_versao_nova: true, ultima_consulta_s: None }
    }
}

/// Lê as preferências. Arquivo que não existe, ilegível ou fora do formato dá no mesmo: as de fábrica.
pub fn carregar(arquivo: &Path) -> Preferencias {
    fs::read_to_string(arquivo).ok().and_then(|texto| serde_json::from_str(&texto).ok()).unwrap_or_default()
}

/// Grava as preferências. Escreve num arquivo ao lado e troca de nome no fim, para uma queda no
/// meio não deixar o arquivo pela metade.
pub fn salvar(arquivo: &Path, preferencias: &Preferencias) -> io::Result<()> {
    if let Some(pasta) = arquivo.parent() {
        fs::create_dir_all(pasta)?;
    }
    let provisorio = arquivo.with_extension("json.novo");
    // Uma estrutura só com um sim-ou-não e um número sempre vira JSON.
    fs::write(&provisorio, serde_json::to_string_pretty(preferencias).unwrap_or_default())?;
    fs::rename(&provisorio, arquivo)
}

#[cfg(test)]
mod testes {
    use super::*;

    fn pasta_de_teste(nome: &str) -> std::path::PathBuf {
        let pasta = std::env::temp_dir().join(format!("awikabot-teste-preferencias-{}-{nome}", std::process::id()));
        let _ = fs::remove_dir_all(&pasta);
        pasta
    }

    #[test]
    fn sem_arquivo_ou_com_lixo_valem_as_de_fabrica() {
        let pasta = pasta_de_teste("fabrica");
        let arquivo = pasta.join("preferencias.json");
        assert_eq!(carregar(&arquivo), Preferencias { avisar_de_versao_nova: true, ultima_consulta_s: None });
        fs::create_dir_all(&pasta).expect("criar");
        for lixo in ["", "isto não é JSON", "[]", "42", r#"{"avisar_de_versao_nova":"talvez"}"#] {
            fs::write(&arquivo, lixo).expect("gravar");
            assert_eq!(carregar(&arquivo), Preferencias::default(), "{lixo:?}");
        }
        let _ = fs::remove_dir_all(&pasta);
    }

    #[test]
    fn le_de_volta_o_que_gravou_e_cria_a_pasta_que_faltava() {
        let pasta = pasta_de_teste("gravar");
        let arquivo = pasta.join("dentro").join("preferencias.json");
        let desligado = Preferencias { avisar_de_versao_nova: false, ultima_consulta_s: Some(1_800_000_000) };
        salvar(&arquivo, &desligado).expect("salvar");
        assert_eq!(carregar(&arquivo), desligado);
        // Gravar de novo troca o conteúdo e não deixa o arquivo provisório para trás.
        salvar(&arquivo, &Preferencias::default()).expect("salvar de novo");
        assert_eq!(carregar(&arquivo), Preferencias::default());
        let nomes: Vec<_> =
            fs::read_dir(arquivo.parent().expect("pasta")).expect("listar").map(|item| item.expect("item").file_name()).collect();
        assert_eq!(nomes, vec![std::ffi::OsString::from("preferencias.json")]);
        let _ = fs::remove_dir_all(&pasta);
    }

    #[test]
    fn campo_que_falta_vale_o_de_fabrica_e_campo_a_mais_e_ignorado() {
        let pasta = pasta_de_teste("campos");
        let arquivo = pasta.join("preferencias.json");
        fs::create_dir_all(&pasta).expect("criar");
        // Um arquivo de versão mais antiga, sem a data da consulta, e um de versão mais nova, com um campo a mais.
        fs::write(&arquivo, r#"{"avisar_de_versao_nova":false}"#).expect("gravar");
        assert_eq!(carregar(&arquivo), Preferencias { avisar_de_versao_nova: false, ultima_consulta_s: None });
        fs::write(&arquivo, r#"{"ultima_consulta_s":7,"tema":"claro"}"#).expect("gravar");
        assert_eq!(carregar(&arquivo), Preferencias { avisar_de_versao_nova: true, ultima_consulta_s: Some(7) });
        let _ = fs::remove_dir_all(&pasta);
    }
}
