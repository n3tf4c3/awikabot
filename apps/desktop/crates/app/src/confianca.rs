//! De quem é o pacote de atualização que o app baixou: a conferência da assinatura antes de instalar.
//!
//! O tamanho e o hash do pacote vêm do mesmo lugar que o pacote, então só pegam arquivo trocado
//! ou corrompido no caminho. A assinatura é a âncora: o Windows confere que ela vale e que a
//! cadeia chega a uma autoridade em que ele confia, e aqui se exige que quem assinou seja o
//! publicador do app. Quem tomar a conta de onde as versões são publicadas não passa daqui sem a
//! chave do certificado.
//!
//! A assinatura diz de quem é o arquivo, não qual arquivo é: um instalador antigo do app, ou outro
//! programa do mesmo publicador, tem assinatura tão boa quanto a do pacote oferecido. Por isso,
//! depois dela, confere-se o nome do produto e a versão que o próprio pacote traz gravados, e que
//! a assinatura cobre: têm de ser os deste app e os da versão oferecida.
//!
//! Só há pacote, e portanto só há conferência, no Windows. Nos outros sistemas tudo é recusado.

use std::path::Path;

use awikabot_cliente::atualizacao::Versao;

/// Quem assina os pacotes do app, como está escrito no certificado.
const PUBLICADOR_DO_APP: &str = "Paulo Engels Palma Gomes";
/// A autoridade que emitiu o certificado. Trocar de autoridade ou de titular pede antes uma
/// versão que aceite os dois: sem ela, quem já instalou recusa a atualização.
const EMISSOR_DO_APP: &str = "Certum";
/// O nome do produto gravado no executável e no instalador: o de `build.rs` e o de `instalador.iss`.
const PRODUTO_DO_APP: &str = "awikabot";

/// A opção de linha de comando que confere um arquivo pela regra do app:
/// `--conferir-pacote <arquivo> <versão>`.
pub const OPCAO_DE_CONFERIR: &str = "--conferir-pacote";

/// O que a assinatura de um pacote precisa ter para ele ser aceito.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Politica {
    /// O nome de quem assinou, igual, letra por letra.
    pub publicador: String,
    /// Um trecho que o nome de quem emitiu o certificado precisa conter.
    pub emissor_contem: String,
    /// Perguntar à autoridade se algum certificado da cadeia foi revogado. Pede rede.
    pub conferir_revogacao: bool,
    /// O nome do produto que o pacote traz gravado, igual, letra por letra.
    pub produto: String,
}

impl Politica {
    /// A regra do app de verdade.
    pub fn do_app() -> Self {
        Self {
            publicador: PUBLICADOR_DO_APP.to_owned(),
            emissor_contem: EMISSOR_DO_APP.to_owned(),
            conferir_revogacao: true,
            produto: PRODUTO_DO_APP.to_owned(),
        }
    }
}

/// O que um pacote diz de si mesmo: o nome do produto e a versão gravados nos recursos do arquivo.
/// A assinatura cobre esses recursos, então eles só valem depois de ela ser conferida.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identidade {
    pub produto: String,
    /// As quatro partes da versão do produto. Nos pacotes do app a quarta é sempre zero.
    pub versao: [u16; 4],
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
    /// A assinatura é de quem devia, mas o arquivo não é o pacote da versão oferecida: é outro
    /// produto do mesmo publicador, ou outra versão do app.
    OutroPacote { produto: String, versao: String },
    /// Não foi possível ler o nome do produto e a versão gravados no pacote.
    #[cfg_attr(not(windows), allow(dead_code))]
    SemIdentidade,
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
            Self::OutroPacote { produto, versao } => {
                write!(saida, "o arquivo assinado não é o pacote da versão esperada (ele se apresenta como {produto} {versao})")
            }
            Self::SemIdentidade => write!(saida, "não foi possível ler o nome do produto e a versão gravados no pacote"),
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

/// Decide se o arquivo é o pacote da versão esperada, e não outro programa ou outra versão que o
/// mesmo publicador assinou.
fn aceitar_identidade(politica: &Politica, esperada: Versao, lida: &Identidade) -> Result<(), Recusa> {
    // A quarta parte não existe na versão do app; os pacotes dele saem com zero nela.
    let [maior, menor, correcao, _] = lida.versao.map(u64::from);
    // O Inno Setup completa o nome do produto com espaços.
    let produto = lida.produto.trim();
    if produto == politica.produto && (Versao { maior, menor, correcao }) == esperada {
        Ok(())
    } else {
        Err(Recusa::OutroPacote { produto: produto.to_owned(), versao: format!("{maior}.{menor}.{correcao}") })
    }
}

/// Confere um arquivo contra a regra: a assinatura, e que ele é o pacote da versão `versao`.
/// Só `Ok` autoriza instalar.
pub fn conferir(arquivo: &Path, politica: &Politica, versao: Versao) -> Result<(), Recusa> {
    let (publicador, emissor) = assinante(arquivo, politica.conferir_revogacao)?;
    aceitar(politica, &publicador, &emissor)?;
    // Só depois de a assinatura valer: é ela que garante que o nome e a versão não foram trocados.
    aceitar_identidade(politica, versao, &identidade(arquivo)?)
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

/// O nome do produto e a versão que o arquivo traz nos recursos de versão.
#[cfg(windows)]
pub fn identidade(arquivo: &Path) -> Result<Identidade, Recusa> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VS_FIXEDFILEINFO, VerQueryValueW};

    /// A marca que o Windows grava no começo dos números de versão.
    const MARCA_DA_VERSAO: u32 = 0xFEEF_04BD;

    /// Acha um valor dentro do bloco de versão: onde ele começa e o tamanho que a API informa (em
    /// bytes para os números e para a lista de idiomas, em unidades UTF-16 para os textos).
    ///
    /// # Safety
    /// `bloco` tem de ser um bloco de versão preenchido por `GetFileVersionInfoW`.
    unsafe fn consultar(bloco: &[u32], chave: &str) -> Option<(*const u8, usize)> {
        let chave: Vec<u16> = chave.encode_utf16().chain(std::iter::once(0)).collect();
        let mut valor: *mut c_void = std::ptr::null_mut();
        let mut tamanho = 0u32;
        // SAFETY: quem chama garante o bloco; a chave termina em zero e vive até o fim da chamada;
        // os dois destinos são variáveis nossas.
        let achou = unsafe { VerQueryValueW(bloco.as_ptr().cast(), chave.as_ptr(), &mut valor, &mut tamanho) };
        (achou != 0 && !valor.is_null() && tamanho > 0).then_some((valor.cast::<u8>().cast_const(), tamanho as usize))
    }

    /// Lê uma unidade de 16 bits de dentro do bloco, sem presumir alinhamento.
    ///
    /// # Safety
    /// `inicio` mais `indice` unidades tem de cair dentro de um valor devolvido por `consultar`.
    unsafe fn unidade(inicio: *const u8, indice: usize) -> u16 {
        // SAFETY: quem chama garante que a posição está dentro do valor.
        unsafe { inicio.cast::<u16>().add(indice).read_unaligned() }
    }

    let caminho: Vec<u16> = arquivo.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut sem_uso = 0u32;
    // SAFETY: `caminho` termina em zero e vive até o fim da função; o segundo argumento é uma variável nossa.
    let tamanho = unsafe { GetFileVersionInfoSizeW(caminho.as_ptr(), &mut sem_uso) };
    if tamanho == 0 {
        return Err(Recusa::SemIdentidade);
    }
    // Em palavras de 32 bits, que é o alinhamento dos recursos de versão.
    let mut bloco = vec![0u32; (tamanho as usize).div_ceil(4)];
    // SAFETY: o destino tem pelo menos `tamanho` bytes, que é o que a chamada anterior pediu.
    if unsafe { GetFileVersionInfoW(caminho.as_ptr(), 0, tamanho, bloco.as_mut_ptr().cast()) } == 0 {
        return Err(Recusa::SemIdentidade);
    }

    // SAFETY: `bloco` acabou de ser preenchido por `GetFileVersionInfoW`. Cada valor é lido dentro
    // do tamanho que a API devolveu para ele, e copiado para dados nossos antes de o bloco sair de cena.
    unsafe {
        let (numeros, bytes) = consultar(&bloco, "\\").ok_or(Recusa::SemIdentidade)?;
        if bytes < size_of::<VS_FIXEDFILEINFO>() {
            return Err(Recusa::SemIdentidade);
        }
        let numeros = numeros.cast::<VS_FIXEDFILEINFO>().read_unaligned();
        if numeros.dwSignature != MARCA_DA_VERSAO {
            return Err(Recusa::SemIdentidade);
        }
        let (alta, baixa) = (numeros.dwProductVersionMS, numeros.dwProductVersionLS);
        let versao = [(alta >> 16) as u16, alta as u16, (baixa >> 16) as u16, baixa as u16];

        // Os textos ficam separados por idioma: vale o primeiro idioma que tiver o nome do produto.
        let (idiomas, bytes) = consultar(&bloco, "\\VarFileInfo\\Translation").ok_or(Recusa::SemIdentidade)?;
        let produto = (0..bytes / 4)
            .find_map(|qual| {
                let (idioma, pagina) = (unidade(idiomas, qual * 2), unidade(idiomas, qual * 2 + 1));
                let (texto, unidades) = consultar(&bloco, &format!("\\StringFileInfo\\{idioma:04x}{pagina:04x}\\ProductName"))?;
                let lido: Vec<u16> = (0..unidades).map(|indice| unidade(texto, indice)).collect();
                Some(String::from_utf16_lossy(&lido).trim_end_matches('\0').to_owned())
            })
            .ok_or(Recusa::SemIdentidade)?;
        Ok(Identidade { produto, versao })
    }
}

#[cfg(not(windows))]
pub fn identidade(_arquivo: &Path) -> Result<Identidade, Recusa> {
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

/// O arquivo assinado de teste, a regra que o aceita e a versão que ele traz gravada: o que um
/// teste precisa para fazer dele o pacote de uma versão.
#[cfg(all(test, windows))]
pub fn pacote_de_teste() -> (std::path::PathBuf, Politica, Versao) {
    let arquivo = arquivo_assinado_de_teste();
    let lida = identidade(&arquivo).expect("o signtool traz nome e versão gravados");
    let [maior, menor, correcao, _] = lida.versao.map(u64::from);
    let politica = Politica {
        publicador: "Microsoft Corporation".into(),
        emissor_contem: "Microsoft".into(),
        conferir_revogacao: false,
        produto: lida.produto.trim().to_owned(),
    };
    (arquivo, politica, Versao { maior, menor, correcao })
}

#[cfg(test)]
mod testes {
    use super::*;

    const V: Versao = Versao { maior: 0, menor: 2, correcao: 0 };

    fn regra(publicador: &str, emissor: &str) -> Politica {
        Politica {
            publicador: publicador.into(),
            emissor_contem: emissor.into(),
            conferir_revogacao: false,
            produto: "Produto de Teste".into(),
        }
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
    fn so_o_pacote_do_produto_e_da_versao_esperados_passa() {
        let do_app = regra("Fulana de Tal", "Autoridade Certa");
        let pacote = |produto: &str, versao: [u16; 4]| Identidade { produto: produto.into(), versao };
        assert_eq!(aceitar_identidade(&do_app, V, &pacote("Produto de Teste", [0, 2, 0, 0])), Ok(()));
        // O Inno Setup grava o nome completado com espaços; a quarta parte da versão não conta.
        assert_eq!(aceitar_identidade(&do_app, V, &pacote("Produto de Teste          ", [0, 2, 0, 0])), Ok(()));
        assert_eq!(aceitar_identidade(&do_app, V, &pacote("Produto de Teste", [0, 2, 0, 7])), Ok(()));
        for (produto, versao) in [
            // Um instalador antigo do mesmo produto, oferecido como se fosse a versão nova.
            ("Produto de Teste", [0, 1, 0, 0]),
            ("Produto de Teste", [0, 1, 9, 0]),
            // Uma versão que não é a oferecida, mesmo sendo maior.
            ("Produto de Teste", [0, 2, 1, 0]),
            ("Produto de Teste", [1, 2, 0, 0]),
            // Outro programa do mesmo publicador, com o mesmo número de versão.
            ("Outro Produto", [0, 2, 0, 0]),
            ("produto de teste", [0, 2, 0, 0]),
            ("Produto de Teste 2", [0, 2, 0, 0]),
            ("", [0, 2, 0, 0]),
        ] {
            let recusa = aceitar_identidade(&do_app, V, &pacote(produto, versao));
            assert!(matches!(recusa, Err(Recusa::OutroPacote { .. })), "{produto:?} {versao:?}: {recusa:?}");
        }
        // Uma parte da versão esperada que nem cabe no que o arquivo consegue gravar.
        let grande = Versao { maior: 0, menor: 70_000, correcao: 0 };
        assert!(aceitar_identidade(&do_app, grande, &pacote("Produto de Teste", [0, 4464, 0, 0])).is_err());
    }

    #[test]
    fn a_recusa_por_outro_pacote_diz_o_que_o_arquivo_e() {
        let do_app = regra("Fulana de Tal", "Autoridade Certa");
        let antigo = Identidade { produto: "Produto de Teste   ".into(), versao: [0, 1, 0, 0] };
        let recusa = aceitar_identidade(&do_app, V, &antigo).expect_err("outra versão");
        assert_eq!(recusa, Recusa::OutroPacote { produto: "Produto de Teste".into(), versao: "0.1.0".into() });
        assert!(recusa.to_string().contains("Produto de Teste 0.1.0"), "{recusa}");
    }

    #[test]
    fn a_regra_do_app_confere_a_revogacao_e_o_produto() {
        let do_app = Politica::do_app();
        assert!(do_app.conferir_revogacao);
        assert!(!do_app.publicador.is_empty() && !do_app.emissor_contem.is_empty());
        assert_eq!(do_app.produto, "awikabot");
    }

    #[cfg(not(windows))]
    #[test]
    fn fora_do_windows_tudo_e_recusado() {
        let este = std::env::current_exe().expect("o executável do teste");
        assert_eq!(conferir(&este, &Politica::do_app(), V), Err(Recusa::NaoSuportado));
        assert_eq!(identidade(&este), Err(Recusa::NaoSuportado));
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
            let (assinado, da_microsoft, versao) = pacote_de_teste();
            let (publicador, emissor) = assinante(&assinado, false).expect("assinatura válida");
            assert_eq!(publicador, "Microsoft Corporation");
            assert!(emissor.contains("Microsoft"), "{emissor}");
            assert_eq!(conferir(&assinado, &da_microsoft, versao), Ok(()));
        }

        #[test]
        fn le_o_nome_do_produto_e_a_versao_gravados_no_arquivo() {
            // O que se sabe do signtool sem perguntar a ele: é do Windows, na linha 10.
            let lida = identidade(&arquivo_assinado_de_teste()).expect("nome e versão");
            assert!(lida.produto.contains("Windows"), "{lida:?}");
            assert_eq!(lida.versao[0], 10, "{lida:?}");
            assert!(lida.versao[2] > 0, "{lida:?}");

            let texto = copia("sem-versao", b"isto nem e um programa");
            let sem_versao = identidade(&texto);
            let _ = std::fs::remove_file(&texto);
            assert_eq!(sem_versao, Err(Recusa::SemIdentidade));
            let ausente = std::env::temp_dir().join("awikabot-teste-confianca-nao-existe.exe");
            assert_eq!(identidade(&ausente), Err(Recusa::SemIdentidade));
        }

        #[test]
        fn assinatura_valida_de_outro_publicador_e_recusada() {
            let (assinado, da_microsoft, versao) = pacote_de_teste();
            // A regra do app de verdade: um arquivo da Microsoft, por mais válido que seja, não é um pacote do app.
            let recusa = conferir(&assinado, &Politica { conferir_revogacao: false, ..Politica::do_app() }, versao);
            assert!(matches!(recusa, Err(Recusa::OutroPublicador { .. })), "{recusa:?}");
            let recusa = conferir(&assinado, &Politica { emissor_contem: "Outra Autoridade".into(), ..da_microsoft }, versao);
            assert!(matches!(recusa, Err(Recusa::OutroPublicador { .. })), "{recusa:?}");
        }

        #[test]
        fn arquivo_do_publicador_certo_que_nao_e_o_pacote_da_versao_esperada_e_recusado() {
            let (assinado, da_microsoft, versao) = pacote_de_teste();
            // A assinatura vale e é de quem a regra espera. O arquivo é que é outro: outra versão...
            for outra in [
                Versao { correcao: versao.correcao + 1, ..versao },
                Versao { correcao: versao.correcao - 1, ..versao },
                Versao { maior: versao.maior + 1, ..versao },
                V,
            ] {
                let recusa = conferir(&assinado, &da_microsoft, outra);
                assert!(matches!(recusa, Err(Recusa::OutroPacote { .. })), "{outra}: {recusa:?}");
            }
            // ... ou outro produto do mesmo publicador, com o número de versão certo.
            let recusa = conferir(&assinado, &Politica { produto: "awikabot".into(), ..da_microsoft }, versao);
            assert!(matches!(recusa, Err(Recusa::OutroPacote { .. })), "{recusa:?}");
        }

        #[test]
        fn arquivo_alterado_depois_de_assinado_e_recusado() {
            let (assinado, da_microsoft, versao) = pacote_de_teste();
            let mut bytes = std::fs::read(assinado).expect("ler");
            // Um byte trocado no meio do programa: a assinatura continua lá, mas não é mais deste conteúdo.
            let meio = bytes.len() / 2;
            bytes[meio] ^= 0xFF;
            let alterado = copia("alterado", &bytes);
            let recusa = conferir(&alterado, &da_microsoft, versao);
            let _ = std::fs::remove_file(&alterado);
            assert!(matches!(recusa, Err(Recusa::AssinaturaInvalida(_))), "{recusa:?}");
        }

        #[test]
        fn arquivo_sem_assinatura_e_recusado() {
            let este = std::env::current_exe().expect("o executável do teste");
            assert_eq!(conferir(&este, &regra("Microsoft Corporation", "Microsoft"), V), Err(Recusa::SemAssinatura));
            let texto = copia("texto", b"isto nem e um programa");
            let recusa = conferir(&texto, &regra("Microsoft Corporation", "Microsoft"), V);
            let _ = std::fs::remove_file(&texto);
            assert!(matches!(recusa, Err(Recusa::SemAssinatura | Recusa::AssinaturaInvalida(_))), "{recusa:?}");
        }

        #[test]
        fn arquivo_que_nao_existe_e_recusado() {
            let ausente = std::env::temp_dir().join("awikabot-teste-confianca-nao-existe.exe");
            assert!(conferir(&ausente, &regra("Microsoft Corporation", "Microsoft"), V).is_err());
        }
    }
}
