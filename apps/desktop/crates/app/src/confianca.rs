//! De quem é o pacote de atualização que o app baixou: a conferência da assinatura antes de instalar.
//!
//! O tamanho e o hash do pacote vêm do mesmo lugar que o pacote, então só pegam arquivo trocado
//! ou corrompido no caminho. A assinatura é a âncora: o Windows confere que ela vale e que a
//! cadeia chega a uma autoridade em que ele confia, e aqui se exige que quem assinou seja o
//! publicador do app. Quem tomar a conta de onde as versões são publicadas não passa daqui sem a
//! chave do certificado.
//!
//! Só há pacote, e portanto só há conferência, no Windows. Nos outros sistemas tudo é recusado.

use std::path::Path;

/// Quem assina os pacotes do app, como está escrito no certificado.
const PUBLICADOR_DO_APP: &str = "Paulo Engels Palma Gomes";
/// A autoridade que emitiu o certificado. Trocar de autoridade ou de titular pede antes uma
/// versão que aceite os dois: sem ela, quem já instalou recusa a atualização.
const EMISSOR_DO_APP: &str = "Certum";

/// O que a assinatura de um pacote precisa ter para ele ser aceito.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Politica {
    /// O nome de quem assinou, igual, letra por letra.
    pub publicador: String,
    /// Um trecho que o nome de quem emitiu o certificado precisa conter.
    pub emissor_contem: String,
    /// Perguntar à autoridade se algum certificado da cadeia foi revogado. Pede rede.
    pub conferir_revogacao: bool,
}

impl Politica {
    /// A regra do app de verdade.
    pub fn do_app() -> Self {
        Self { publicador: PUBLICADOR_DO_APP.to_owned(), emissor_contem: EMISSOR_DO_APP.to_owned(), conferir_revogacao: true }
    }
}

// Cada sistema só produz parte destes motivos: os três que vêm da conferência do Windows não
// aparecem fora dele, e o último não aparece nele. Por isso a marcação em cada um, e não no tipo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Recusa {
    #[cfg_attr(not(windows), allow(dead_code))]
    SemAssinatura,
    /// O Windows não aceitou a assinatura: arquivo alterado, certificado vencido sem carimbo de
    /// tempo, revogado, de autoridade desconhecida, ou revogação que não pôde ser consultada.
    #[cfg_attr(not(windows), allow(dead_code))]
    AssinaturaInvalida(u32),
    /// A assinatura vale, mas é de outra pessoa ou de outra autoridade.
    OutroPublicador { publicador: String, emissor: String },
    /// Não foi possível ler quem assinou.
    #[cfg_attr(not(windows), allow(dead_code))]
    SemAssinante,
    /// Este sistema não tem pacote de atualização para conferir.
    #[cfg_attr(windows, allow(dead_code))]
    NaoSuportado,
}

impl std::fmt::Display for Recusa {
    fn fmt(&self, saida: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SemAssinatura => write!(saida, "o pacote não está assinado"),
            Self::AssinaturaInvalida(codigo) => write!(saida, "o Windows não aceitou a assinatura do pacote (código {codigo:#010x})"),
            Self::OutroPublicador { publicador, emissor } => {
                write!(saida, "o pacote foi assinado por outro publicador ({publicador}, certificado emitido por {emissor})")
            }
            Self::SemAssinante => write!(saida, "não foi possível ler quem assinou o pacote"),
            Self::NaoSuportado => write!(saida, "este sistema não tem pacote de atualização para conferir"),
        }
    }
}

/// Decide se quem assinou é quem a regra espera.
fn aceitar(politica: &Politica, publicador: &str, emissor: &str) -> Result<(), Recusa> {
    if publicador == politica.publicador && emissor.contains(&politica.emissor_contem) {
        Ok(())
    } else {
        Err(Recusa::OutroPublicador { publicador: publicador.to_owned(), emissor: emissor.to_owned() })
    }
}

/// Confere a assinatura de um arquivo contra a regra. Só `Ok` autoriza instalar.
pub fn conferir(arquivo: &Path, politica: &Politica) -> Result<(), Recusa> {
    let (publicador, emissor) = assinante(arquivo, politica.conferir_revogacao)?;
    aceitar(politica, &publicador, &emissor)
}

/// Quem assinou o arquivo e quem emitiu o certificado, se o Windows aceita a assinatura.
#[cfg(windows)]
pub fn assinante(arquivo: &Path, conferir_revogacao: bool) -> Result<(String, String), Recusa> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Foundation::{INVALID_HANDLE_VALUE, TRUST_E_NOSIGNATURE};
    use windows_sys::Win32::Security::Cryptography::{
        CERT_CONTEXT, CERT_NAME_ISSUER_FLAG, CERT_NAME_SIMPLE_DISPLAY_TYPE, CertGetNameStringW,
    };
    use windows_sys::Win32::Security::WinTrust::{
        WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_DATA_0, WINTRUST_FILE_INFO, WTD_CHOICE_FILE,
        WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT, WTD_REVOCATION_CHECK_NONE, WTD_REVOKE_NONE, WTD_REVOKE_WHOLECHAIN, WTD_STATEACTION_CLOSE,
        WTD_STATEACTION_VERIFY, WTD_UI_NONE, WTHelperGetProvCertFromChain, WTHelperGetProvSignerFromChain, WTHelperProvDataFromStateData,
        WinVerifyTrust,
    };

    /// Lê um dos nomes do certificado: o de quem assinou, ou o de quem o emitiu.
    ///
    /// # Safety
    /// `certificado` tem de apontar para um certificado válido durante a chamada.
    unsafe fn nome(certificado: *const CERT_CONTEXT, do_emissor: bool) -> String {
        let opcoes = if do_emissor { CERT_NAME_ISSUER_FLAG } else { 0 };
        let mut texto = [0u16; 512];
        // SAFETY: quem chama garante o certificado; o destino é um vetor nosso, com o tamanho informado.
        let escritos = unsafe {
            CertGetNameStringW(certificado, CERT_NAME_SIMPLE_DISPLAY_TYPE, opcoes, std::ptr::null(), texto.as_mut_ptr(), texto.len() as u32)
        };
        // O tamanho devolvido conta o zero do fim.
        String::from_utf16_lossy(&texto[..(escritos as usize).saturating_sub(1)])
    }

    let caminho: Vec<u16> = arquivo.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut do_arquivo = WINTRUST_FILE_INFO {
        cbStruct: size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: caminho.as_ptr(),
        hFile: std::ptr::null_mut(),
        pgKnownSubject: std::ptr::null_mut(),
    };
    // SAFETY: a estrutura é só de números e ponteiros, e tudo zerado é o estado "sem opções" que a API documenta.
    let mut pedido: WINTRUST_DATA = unsafe { std::mem::zeroed() };
    pedido.cbStruct = size_of::<WINTRUST_DATA>() as u32;
    pedido.dwUIChoice = WTD_UI_NONE;
    pedido.dwUnionChoice = WTD_CHOICE_FILE;
    pedido.Anonymous = WINTRUST_DATA_0 { pFile: &mut do_arquivo };
    pedido.dwStateAction = WTD_STATEACTION_VERIFY;
    (pedido.fdwRevocationChecks, pedido.dwProvFlags) = if conferir_revogacao {
        (WTD_REVOKE_WHOLECHAIN, WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT)
    } else {
        (WTD_REVOKE_NONE, WTD_REVOCATION_CHECK_NONE)
    };
    let mut acao = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    // Daqui em diante o pedido só é tocado por este ponteiro, que é por onde a API também o lê e escreve.
    let do_pedido = &raw mut pedido;

    // SAFETY: `pedido`, `do_arquivo`, `caminho` e `acao` vivem até o fim desta função, e o
    // identificador de janela inválido é o valor que a API documenta para "sem interface".
    let situacao = unsafe { WinVerifyTrust(INVALID_HANDLE_VALUE, &mut acao, do_pedido.cast::<c_void>()) };

    let resultado = if situacao == 0 {
        // SAFETY: a conferência deu certo, então o estado guardado em `pedido` é válido até ser
        // fechado, logo abaixo. Cada ponteiro devolvido é conferido antes de ser usado, e os
        // nomes são copiados para textos nossos antes do fechamento.
        unsafe {
            let dados = WTHelperProvDataFromStateData((*do_pedido).hWVTStateData);
            let de_quem_assinou = if dados.is_null() { std::ptr::null_mut() } else { WTHelperGetProvSignerFromChain(dados, 0, 0, 0) };
            let da_cadeia = if de_quem_assinou.is_null() { std::ptr::null_mut() } else { WTHelperGetProvCertFromChain(de_quem_assinou, 0) };
            if da_cadeia.is_null() || (*da_cadeia).pCert.is_null() {
                Err(Recusa::SemAssinante)
            } else {
                Ok((nome((*da_cadeia).pCert, false), nome((*da_cadeia).pCert, true)))
            }
        }
    } else if situacao == TRUST_E_NOSIGNATURE {
        Err(Recusa::SemAssinatura)
    } else {
        Err(Recusa::AssinaturaInvalida(situacao as u32))
    };

    // O estado da conferência é solto sempre, tenha dado certo ou não.
    // SAFETY: os mesmos argumentos da chamada acima, ainda vivos; o ponteiro é o do pedido desta função.
    unsafe {
        (*do_pedido).dwStateAction = WTD_STATEACTION_CLOSE;
        WinVerifyTrust(INVALID_HANDLE_VALUE, &mut acao, do_pedido.cast::<c_void>());
    }
    resultado
}

#[cfg(not(windows))]
pub fn assinante(_arquivo: &Path, _conferir_revogacao: bool) -> Result<(String, String), Recusa> {
    Err(Recusa::NaoSuportado)
}

/// Um executável pequeno com assinatura embutida que existe em qualquer Windows de desenvolvimento
/// e na CI: o `signtool` do Windows SDK, assinado pela Microsoft. Serve de pacote nos testes.
#[cfg(all(test, windows))]
pub fn arquivo_assinado_de_teste() -> std::path::PathBuf {
    use std::path::PathBuf;

    let kits = PathBuf::from(std::env::var("ProgramFiles(x86)").expect("pasta de programas")).join("Windows Kits").join("10").join("bin");
    let mut versoes: Vec<PathBuf> = std::fs::read_dir(&kits)
        .expect("o Windows SDK está instalado")
        .filter_map(|item| Some(item.ok()?.path().join("x64").join("signtool.exe")))
        .filter(|candidato| candidato.is_file())
        .collect();
    versoes.sort();
    versoes.pop().expect("o signtool do Windows SDK")
}

#[cfg(test)]
mod testes {
    use super::*;

    fn regra(publicador: &str, emissor: &str) -> Politica {
        Politica { publicador: publicador.into(), emissor_contem: emissor.into(), conferir_revogacao: false }
    }

    #[test]
    fn so_o_publicador_e_o_emissor_esperados_passam() {
        let do_app = regra("Fulana de Tal", "Autoridade Certa");
        assert_eq!(aceitar(&do_app, "Fulana de Tal", "Autoridade Certa Code Signing 2021 CA"), Ok(()));
        for (publicador, emissor) in [
            ("Fulana de Tal", "Outra Autoridade CA"),
            ("fulana de tal", "Autoridade Certa Code Signing 2021 CA"),
            ("Fulana de Tal Ltda", "Autoridade Certa Code Signing 2021 CA"),
            ("Outra Pessoa", "Autoridade Certa Code Signing 2021 CA"),
            ("", "Autoridade Certa Code Signing 2021 CA"),
            ("Fulana de Tal", ""),
        ] {
            assert!(matches!(aceitar(&do_app, publicador, emissor), Err(Recusa::OutroPublicador { .. })), "{publicador:?} / {emissor:?}");
        }
    }

    #[test]
    fn a_regra_do_app_confere_a_revogacao() {
        let do_app = Politica::do_app();
        assert!(do_app.conferir_revogacao);
        assert!(!do_app.publicador.is_empty() && !do_app.emissor_contem.is_empty());
    }

    #[cfg(not(windows))]
    #[test]
    fn fora_do_windows_tudo_e_recusado() {
        let este = std::env::current_exe().expect("o executável do teste");
        assert_eq!(conferir(&este, &Politica::do_app()), Err(Recusa::NaoSuportado));
    }

    #[cfg(windows)]
    mod no_windows {
        use std::path::PathBuf;

        use super::*;

        fn copia(nome: &str, bytes: &[u8]) -> PathBuf {
            let arquivo = std::env::temp_dir().join(format!("awikabot-teste-confianca-{}-{nome}.exe", std::process::id()));
            std::fs::write(&arquivo, bytes).expect("gravar a cópia");
            arquivo
        }

        #[test]
        fn le_quem_assinou_um_arquivo_assinado_e_aceita_com_a_regra_certa() {
            let assinado = arquivo_assinado_de_teste();
            let (publicador, emissor) = assinante(&assinado, false).expect("assinatura válida");
            assert_eq!(publicador, "Microsoft Corporation");
            assert!(emissor.contains("Microsoft"), "{emissor}");
            assert_eq!(conferir(&assinado, &regra("Microsoft Corporation", "Microsoft")), Ok(()));
        }

        #[test]
        fn assinatura_valida_de_outro_publicador_e_recusada() {
            let assinado = arquivo_assinado_de_teste();
            // A regra do app de verdade: um arquivo da Microsoft, por mais válido que seja, não é um pacote do app.
            let recusa = conferir(&assinado, &Politica { conferir_revogacao: false, ..Politica::do_app() });
            assert!(matches!(recusa, Err(Recusa::OutroPublicador { .. })), "{recusa:?}");
            let recusa = conferir(&assinado, &regra("Microsoft Corporation", "Outra Autoridade"));
            assert!(matches!(recusa, Err(Recusa::OutroPublicador { .. })), "{recusa:?}");
        }

        #[test]
        fn arquivo_alterado_depois_de_assinado_e_recusado() {
            let mut bytes = std::fs::read(arquivo_assinado_de_teste()).expect("ler");
            // Um byte trocado no meio do programa: a assinatura continua lá, mas não é mais deste conteúdo.
            let meio = bytes.len() / 2;
            bytes[meio] ^= 0xFF;
            let alterado = copia("alterado", &bytes);
            let recusa = conferir(&alterado, &regra("Microsoft Corporation", "Microsoft"));
            let _ = std::fs::remove_file(&alterado);
            assert!(matches!(recusa, Err(Recusa::AssinaturaInvalida(_))), "{recusa:?}");
        }

        #[test]
        fn arquivo_sem_assinatura_e_recusado() {
            let este = std::env::current_exe().expect("o executável do teste");
            assert_eq!(conferir(&este, &regra("Microsoft Corporation", "Microsoft")), Err(Recusa::SemAssinatura));
            let texto = copia("texto", b"isto nem e um programa");
            let recusa = conferir(&texto, &regra("Microsoft Corporation", "Microsoft"));
            let _ = std::fs::remove_file(&texto);
            assert!(matches!(recusa, Err(Recusa::SemAssinatura | Recusa::AssinaturaInvalida(_))), "{recusa:?}");
        }

        #[test]
        fn arquivo_que_nao_existe_e_recusado() {
            let ausente = std::env::temp_dir().join("awikabot-teste-confianca-nao-existe.exe");
            assert!(conferir(&ausente, &regra("Microsoft Corporation", "Microsoft")).is_err());
        }
    }
}
