//! Atualização do app: descobrir se há versão nova e baixar o pacote dela, conferido.
//!
//! As versões são os releases públicos do repositório no GitHub cuja etiqueta começa por
//! `desktop-v`. Cada um traz um pequeno manifesto por plataforma, que diz o nome, o tamanho e o
//! SHA-256 do pacote. Nada aqui vai além do que a pessoa pediu: consultar não baixa, e baixar
//! não instala.
//!
//! O tamanho e o hash só pegam arquivo corrompido ou trocado no caminho. Quem publicou o hash
//! também publicou o pacote, então eles não dizem de quem o pacote é: isso é a conferência da
//! assinatura, feita pelo app antes de instalar.

use std::fmt;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use serde::Deserialize;
use sha2::{Digest, Sha256};
use ureq::Agent;

use crate::api::configurar_agente;

/// O repositório público de onde saem as versões.
const REPOSITORIO: &str = "n3tf4c3/awikabot";
/// Começo da etiqueta dos releases do app de desktop; o resto é a versão.
pub const PREFIXO_DA_ETIQUETA: &str = "desktop-v";
/// Um pacote maior que isto não é um instalador deste app.
const TAMANHO_MAXIMO_DO_PACOTE: u64 = 300 * 1024 * 1024;
/// O limite de cada página da lista de releases.
const TAMANHO_MAXIMO_DA_LISTA: u64 = 2 * 1024 * 1024;
const TAMANHO_MAXIMO_DO_MANIFESTO: u64 = 64 * 1024;
/// A lista de releases vem em páginas, e todas são lidas: os releases de outros produtos do
/// repositório podem encher a primeira. Os scripts de release leem estes dois valores daqui
/// (`Get-PaginacaoDosReleases`, em `comum.ps1`), para as duas pontas percorrerem a lista igual.
const RELEASES_POR_PAGINA: usize = 30;
/// Uma lista que não acaba, por defeito ou por malícia de quem responde, para aqui.
const TETO_DE_PAGINAS: usize = 20;
/// O app consulta no máximo uma vez por dia.
const INTERVALO_ENTRE_CONSULTAS_S: u64 = 24 * 60 * 60;

/// Uma versão `x.y.z`, só com números.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Versao {
    pub maior: u64,
    pub menor: u64,
    pub correcao: u64,
}

impl Versao {
    /// Lê `x.y.z`. Qualquer coisa além de três números separados por ponto não é versão.
    pub fn ler(texto: &str) -> Option<Self> {
        let mut partes = texto.split('.').map(|parte| {
            let so_digitos = !parte.is_empty() && parte.len() <= 9 && parte.bytes().all(|byte| byte.is_ascii_digit());
            // "01" e "1" seriam a mesma versão com dois nomes.
            let sem_zero_a_esquerda = parte == "0" || !parte.starts_with('0');
            (so_digitos && sem_zero_a_esquerda).then(|| parte.parse::<u64>().ok()).flatten()
        });
        let versao = Self { maior: partes.next()??, menor: partes.next()??, correcao: partes.next()?? };
        partes.next().is_none().then_some(versao)
    }

    /// A versão deste app, a mesma do `Cargo.toml` do workspace.
    pub fn deste_app() -> Self {
        // Uma versão ilegível valeria como a mais antiga possível; o teste abaixo garante que ela é legível.
        Self::ler(env!("CARGO_PKG_VERSION")).unwrap_or(Self { maior: 0, menor: 0, correcao: 0 })
    }
}

impl fmt::Display for Versao {
    fn fmt(&self, saida: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(saida, "{}.{}.{}", self.maior, self.menor, self.correcao)
    }
}

/// A plataforma deste build, como aparece no nome dos pacotes. `None` onde ainda não há pacote.
pub fn plataforma() -> Option<&'static str> {
    cfg!(all(windows, target_arch = "x86_64")).then_some("windows-x64")
}

/// Passou um dia desde a última consulta? Relógio que andou para trás também pede consulta.
pub fn deve_consultar(ultima_s: Option<u64>, agora_s: u64) -> bool {
    ultima_s.is_none_or(|ultima| agora_s < ultima || agora_s - ultima >= INTERVALO_ENTRE_CONSULTAS_S)
}

fn nome_do_manifesto(plataforma: &str) -> String {
    format!("awikabot-desktop-{plataforma}.json")
}

fn nome_do_pacote(versao: Versao, plataforma: &str) -> String {
    format!("awikabot-{versao}-{plataforma}.exe")
}

/// Uma versão nova que o app pode baixar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Oferta {
    pub versao: Versao,
    pub etiqueta: String,
    pub arquivo: String,
    pub tamanho: u64,
    /// Em hexadecimal minúsculo.
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ErroDeAtualizacao {
    /// Sem resposta, resposta de erro, redirecionamento recusado ou prazo estourado.
    Rede(String),
    /// A lista de versões ou o manifesto vieram fora do formato esperado.
    RespostaInvalida(&'static str),
    /// O que está publicado agora não é mais o que a consulta mostrou.
    OfertaMudou,
    TamanhoErrado {
        esperado: u64,
        recebido: u64,
    },
    HashErrado,
    Cancelado,
    Disco(String),
}

impl fmt::Display for ErroDeAtualizacao {
    fn fmt(&self, saida: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Rede(motivo) => write!(saida, "sem resposta de onde as versões são publicadas: {motivo}"),
            Self::RespostaInvalida(o_que) => write!(saida, "a resposta veio fora do esperado: {o_que}"),
            Self::OfertaMudou => write!(saida, "a versão publicada mudou desde a consulta"),
            Self::TamanhoErrado { esperado, recebido } => {
                write!(saida, "o pacote tem tamanho diferente do publicado ({recebido} em vez de {esperado} bytes)")
            }
            Self::HashErrado => write!(saida, "o pacote baixado não é o que foi publicado"),
            Self::Cancelado => write!(saida, "download cancelado"),
            Self::Disco(motivo) => write!(saida, "não foi possível gravar o pacote: {motivo}"),
        }
    }
}

impl std::error::Error for ErroDeAtualizacao {}

/// De onde as versões vêm.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Origem {
    /// A API que lista os releases.
    pub api: String,
    /// De onde os arquivos de um release são baixados.
    pub downloads: String,
    pub repositorio: String,
    /// Recusa qualquer endereço que não seja `https://`, inclusive num redirecionamento.
    pub so_https: bool,
}

impl Origem {
    pub fn do_github() -> Self {
        Self {
            api: "https://api.github.com".to_owned(),
            downloads: "https://github.com".to_owned(),
            repositorio: REPOSITORIO.to_owned(),
            so_https: true,
        }
    }

    /// Um servidor de mentira na própria máquina, para os testes.
    #[cfg(feature = "teste-suporte")]
    pub fn de_teste(base: &str) -> Self {
        Self { api: base.to_owned(), downloads: base.to_owned(), repositorio: "dono/repositorio".to_owned(), so_https: false }
    }
}

#[derive(Deserialize)]
struct Lancamento {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<Arquivo>,
}

#[derive(Deserialize)]
struct Arquivo {
    name: String,
}

#[derive(Deserialize)]
struct Manifesto {
    versao: String,
    plataforma: String,
    arquivo: String,
    tamanho: u64,
    sha256: String,
}

pub struct Atualizador {
    origem: Origem,
    plataforma: String,
    /// Para a lista de versões: não segue redirecionamento.
    consultas: Agent,
    /// Para os arquivos de um release, que o GitHub entrega por redirecionamento.
    downloads: Agent,
}

impl Atualizador {
    pub fn new(origem: Origem, plataforma: &str) -> Self {
        let consultas = configurar_agente().https_only(origem.so_https).timeout_global(Some(Duration::from_secs(20))).build().new_agent();
        let downloads = configurar_agente()
            .https_only(origem.so_https)
            .max_redirects(5)
            .timeout_resolve(Some(Duration::from_secs(15)))
            .timeout_connect(Some(Duration::from_secs(15)))
            .timeout_recv_response(Some(Duration::from_secs(30)))
            // O prazo do corpo é para o download inteiro, não por leitura.
            .timeout_recv_body(Some(Duration::from_secs(30 * 60)))
            .build()
            .new_agent();
        Self { origem, plataforma: plataforma.to_owned(), consultas, downloads }
    }

    fn endereco_do_arquivo(&self, etiqueta: &str, nome: &str) -> String {
        format!("{}/{}/releases/download/{etiqueta}/{nome}", self.origem.downloads, self.origem.repositorio)
    }

    fn obter_texto(agente: &Agent, endereco: &str, aceita: &str, limite: u64) -> Result<String, ErroDeAtualizacao> {
        let mut resposta =
            agente.get(endereco).header("accept", aceita).call().map_err(|erro| ErroDeAtualizacao::Rede(erro.to_string()))?;
        let status = resposta.status().as_u16();
        if status != 200 {
            return Err(ErroDeAtualizacao::Rede(format!("resposta {status}")));
        }
        resposta.body_mut().with_config().limit(limite).read_to_string().map_err(|erro| ErroDeAtualizacao::Rede(erro.to_string()))
    }

    /// Consulta as versões publicadas. Devolve a mais nova, se for maior que `atual`.
    ///
    /// A lista vem em páginas, e a versão mais nova pode estar em qualquer uma. O número da página
    /// é montado aqui: o cabeçalho `Link` da resposta não é seguido, porque nada do que a rede
    /// respondeu vira parte de um endereço. A última página é a que vem com menos que uma página
    /// cheia. Erro em qualquer página é erro da consulta: lista pela metade não vira oferta.
    pub fn consultar(&self, atual: Versao) -> Result<Option<Oferta>, ErroDeAtualizacao> {
        let manifesto = nome_do_manifesto(&self.plataforma);
        let mut mais_nova: Option<Versao> = None;
        // Passar do teto não é erro: vale a maior versão achada até ali.
        for pagina in 1..=TETO_DE_PAGINAS {
            let endereco =
                format!("{}/repos/{}/releases?per_page={RELEASES_POR_PAGINA}&page={pagina}", self.origem.api, self.origem.repositorio);
            let texto = Self::obter_texto(&self.consultas, &endereco, "application/vnd.github+json", TAMANHO_MAXIMO_DA_LISTA)?;
            let lancamentos: Vec<Lancamento> =
                serde_json::from_str(&texto).map_err(|_| ErroDeAtualizacao::RespostaInvalida("a lista de versões não é a esperada"))?;
            let da_pagina = lancamentos
                .iter()
                .filter(|lancamento| !lancamento.draft && !lancamento.prerelease)
                .filter_map(|lancamento| {
                    let versao = Versao::ler(lancamento.tag_name.strip_prefix(PREFIXO_DA_ETIQUETA)?)?;
                    // Só vale um release que tenha pacote para esta plataforma.
                    lancamento.assets.iter().any(|arquivo| arquivo.name == manifesto).then_some(versao)
                })
                .max();
            mais_nova = mais_nova.max(da_pagina);
            if lancamentos.len() < RELEASES_POR_PAGINA {
                break;
            }
        }
        match mais_nova {
            Some(versao) if versao > atual => self.ler_manifesto(versao).map(Some),
            _ => Ok(None),
        }
    }

    /// Baixa e confere o manifesto de uma versão. A etiqueta e os nomes dos arquivos são montados
    /// aqui, a partir da versão: nada do que a rede respondeu vira parte de um endereço.
    fn ler_manifesto(&self, versao: Versao) -> Result<Oferta, ErroDeAtualizacao> {
        let etiqueta = format!("{PREFIXO_DA_ETIQUETA}{versao}");
        let endereco = self.endereco_do_arquivo(&etiqueta, &nome_do_manifesto(&self.plataforma));
        let texto = Self::obter_texto(&self.downloads, &endereco, "application/json", TAMANHO_MAXIMO_DO_MANIFESTO)?;
        let lido: Manifesto =
            serde_json::from_str(&texto).map_err(|_| ErroDeAtualizacao::RespostaInvalida("o manifesto da versão não é o esperado"))?;

        let arquivo = nome_do_pacote(versao, &self.plataforma);
        if Versao::ler(&lido.versao) != Some(versao) {
            return Err(ErroDeAtualizacao::RespostaInvalida("o manifesto é de outra versão"));
        }
        if lido.plataforma != self.plataforma {
            return Err(ErroDeAtualizacao::RespostaInvalida("o manifesto é de outra plataforma"));
        }
        if lido.arquivo != arquivo {
            return Err(ErroDeAtualizacao::RespostaInvalida("o manifesto aponta para um arquivo com outro nome"));
        }
        if lido.tamanho == 0 || lido.tamanho > TAMANHO_MAXIMO_DO_PACOTE {
            return Err(ErroDeAtualizacao::RespostaInvalida("o tamanho do pacote no manifesto não faz sentido"));
        }
        if lido.sha256.len() != 64 || !lido.sha256.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')) {
            return Err(ErroDeAtualizacao::RespostaInvalida("o hash do pacote no manifesto não faz sentido"));
        }
        Ok(Oferta { versao, etiqueta, arquivo, tamanho: lido.tamanho, sha256: lido.sha256 })
    }

    /// Baixa o pacote de uma oferta para `pasta` e devolve o caminho dele. O arquivo só ganha o
    /// nome final depois de conferidos o tamanho e o hash; em qualquer falha, nada fica na pasta.
    pub fn baixar(
        &self,
        oferta: &Oferta,
        pasta: &Path,
        cancelar: &AtomicBool,
        progresso: &mut dyn FnMut(u64),
    ) -> Result<PathBuf, ErroDeAtualizacao> {
        // Entre o aviso e o clique pode ter passado um dia: o que está publicado tem de ser o que foi mostrado.
        if &self.ler_manifesto(oferta.versao)? != oferta {
            return Err(ErroDeAtualizacao::OfertaMudou);
        }
        let do_disco = |erro: std::io::Error| ErroDeAtualizacao::Disco(erro.to_string());
        fs::create_dir_all(pasta).map_err(do_disco)?;
        let destino = pasta.join(&oferta.arquivo);
        let parcial = pasta.join(nome_do_parcial(&oferta.arquivo));

        let baixado = self.baixar_para(oferta, &parcial, cancelar, progresso).and_then(|()| {
            // Um pacote de uma tentativa anterior com o mesmo nome dá lugar ao que acabou de ser conferido.
            match fs::remove_file(&destino) {
                Err(erro) if erro.kind() != std::io::ErrorKind::NotFound => return Err(do_disco(erro)),
                _ => {}
            }
            fs::rename(&parcial, &destino).map_err(do_disco)
        });
        match baixado {
            Ok(()) => Ok(destino),
            Err(erro) => {
                let _ = fs::remove_file(&parcial);
                Err(erro)
            }
        }
    }

    fn baixar_para(
        &self,
        oferta: &Oferta,
        parcial: &Path,
        cancelar: &AtomicBool,
        progresso: &mut dyn FnMut(u64),
    ) -> Result<(), ErroDeAtualizacao> {
        let do_disco = |erro: std::io::Error| ErroDeAtualizacao::Disco(erro.to_string());
        let da_rede = |erro: ureq::Error| ErroDeAtualizacao::Rede(erro.to_string());
        let endereco = self.endereco_do_arquivo(&oferta.etiqueta, &oferta.arquivo);
        let mut resposta = self.downloads.get(&endereco).header("accept", "application/octet-stream").call().map_err(da_rede)?;
        let status = resposta.status().as_u16();
        if status != 200 {
            return Err(ErroDeAtualizacao::Rede(format!("resposta {status}")));
        }

        let mut arquivo = fs::File::create(parcial).map_err(do_disco)?;
        let mut corpo = resposta.body_mut().as_reader();
        let mut hash = Sha256::new();
        let mut recebidos = 0u64;
        let mut pedaco = vec![0u8; 64 * 1024];
        loop {
            if cancelar.load(Ordering::Relaxed) {
                return Err(ErroDeAtualizacao::Cancelado);
            }
            let lidos = corpo.read(&mut pedaco).map_err(|erro| ErroDeAtualizacao::Rede(erro.to_string()))?;
            if lidos == 0 {
                break;
            }
            recebidos += lidos as u64;
            // Para de gravar assim que passa do tamanho publicado, em vez de encher o disco.
            if recebidos > oferta.tamanho {
                return Err(ErroDeAtualizacao::TamanhoErrado { esperado: oferta.tamanho, recebido: recebidos });
            }
            hash.update(&pedaco[..lidos]);
            arquivo.write_all(&pedaco[..lidos]).map_err(do_disco)?;
            progresso(recebidos);
        }
        if recebidos != oferta.tamanho {
            return Err(ErroDeAtualizacao::TamanhoErrado { esperado: oferta.tamanho, recebido: recebidos });
        }
        let calculado: String = hash.finalize().iter().map(|byte| format!("{byte:02x}")).collect();
        if calculado != oferta.sha256 {
            return Err(ErroDeAtualizacao::HashErrado);
        }
        arquivo.sync_all().map_err(do_disco)
    }
}

/// O uso da pasta de pacotes por uma instância do app. Enquanto este valor existir, nenhuma
/// outra instância esvazia a pasta.
#[derive(Debug)]
pub struct UsoDaPastaDePacotes {
    /// A trava é do sistema e dura enquanto o arquivo estiver aberto: some quando o app fecha,
    /// mesmo que ele morra sem avisar.
    _trava: Option<fs::File>,
}

/// Marca a pasta de pacotes como em uso por esta instância do app e, se nenhuma outra a estiver
/// usando, a esvazia: o que ficou de uma execução anterior não foi conferido por esta. Com outra
/// instância aberta nada é apagado, porque o pacote que está lá pode ser o que ela mostra como pronto.
///
/// A marca é uma trava do sistema num arquivo ao lado da pasta. Cada instância aberta segura a
/// trava compartilhada; só quem a consegue sozinho, por um instante, limpa. Sem conseguir criar
/// ou pegar a trava, nada é apagado: um pacote que sobra não é usado por ninguém, e um pacote
/// apagado de outra instância faz falta a ela.
pub fn ocupar_pasta_de_pacotes(pasta: &Path) -> UsoDaPastaDePacotes {
    let Some(trava) = abrir_trava(pasta) else { return UsoDaPastaDePacotes { _trava: None } };
    if trava.try_lock().is_ok() {
        let _ = fs::remove_dir_all(pasta);
        let _ = trava.unlock();
    }
    // Entre soltar a trava de quem limpa e pegar a de quem usa, outra instância pode limpar a
    // pasta: não faz mal, esta ainda não baixou nada. Se ela estiver no meio da limpeza, a espera
    // é curta e tem fim.
    for _ in 0..50 {
        if trava.try_lock_shared().is_ok() {
            return UsoDaPastaDePacotes { _trava: Some(trava) };
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    UsoDaPastaDePacotes { _trava: None }
}

/// O arquivo da trava: ao lado da pasta de pacotes, com o nome dela. Fica fora da pasta para
/// que nela só haja pacotes, e para a limpeza não o apagar.
fn abrir_trava(pasta: &Path) -> Option<fs::File> {
    let mut nome = pasta.file_name()?.to_owned();
    nome.push(".trava");
    let arquivo = pasta.with_file_name(nome);
    fs::create_dir_all(arquivo.parent()?).ok()?;
    fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(arquivo).ok()
}

/// O nome do arquivo provisório de um download. Cada download tem o dele: duas instâncias do app
/// baixando a mesma versão ao mesmo tempo não gravam uma por cima da outra.
fn nome_do_parcial(arquivo: &str) -> String {
    static DOWNLOADS: AtomicU64 = AtomicU64::new(0);
    format!("{arquivo}.{}-{}.part", std::process::id(), DOWNLOADS.fetch_add(1, Ordering::Relaxed))
}

#[cfg(test)]
mod testes {
    use super::*;

    fn v(maior: u64, menor: u64, correcao: u64) -> Versao {
        Versao { maior, menor, correcao }
    }

    #[test]
    fn le_so_tres_numeros_separados_por_ponto() {
        assert_eq!(Versao::ler("0.1.0"), Some(v(0, 1, 0)));
        assert_eq!(Versao::ler("12.0.345"), Some(v(12, 0, 345)));
        for ruim in [
            "",
            "1",
            "1.2",
            "1.2.3.4",
            "1.2.x",
            "1.2.3-beta",
            "1.2.3+build",
            "v1.2.3",
            " 1.2.3",
            "1.2.3 ",
            "1..3",
            "1.2.",
            "01.2.3",
            "1.02.3",
            "+1.2.3",
            "-1.2.3",
            "1.2.3/../x",
            "1.2.99999999999999999999",
            "１.2.3",
        ] {
            assert_eq!(Versao::ler(ruim), None, "{ruim:?}");
        }
    }

    #[test]
    fn compara_por_numero_e_nao_por_texto() {
        assert!(v(0, 10, 0) > v(0, 9, 9));
        assert!(v(1, 0, 0) > v(0, 99, 99));
        assert!(v(0, 1, 10) > v(0, 1, 9));
        assert_eq!(v(0, 1, 0).to_string(), "0.1.0");
        assert_eq!(Versao::ler(&v(3, 20, 1).to_string()), Some(v(3, 20, 1)));
    }

    #[test]
    fn a_versao_deste_app_e_legivel() {
        assert_eq!(Some(Versao::deste_app()), Versao::ler(env!("CARGO_PKG_VERSION")));
        assert!(Versao::deste_app() > v(0, 0, 0));
    }

    #[test]
    fn consulta_no_maximo_uma_vez_por_dia() {
        let dia = INTERVALO_ENTRE_CONSULTAS_S;
        assert!(deve_consultar(None, 1_000));
        assert!(!deve_consultar(Some(1_000), 1_000));
        assert!(!deve_consultar(Some(1_000), 1_000 + dia - 1));
        assert!(deve_consultar(Some(1_000), 1_000 + dia));
        // O relógio andou para trás: melhor consultar do que nunca mais consultar.
        assert!(deve_consultar(Some(1_000_000), 1_000));
    }

    #[test]
    fn os_nomes_dos_arquivos_saem_da_versao_e_da_plataforma() {
        assert_eq!(nome_do_manifesto("windows-x64"), "awikabot-desktop-windows-x64.json");
        assert_eq!(nome_do_pacote(v(0, 2, 0), "windows-x64"), "awikabot-0.2.0-windows-x64.exe");
    }

    #[test]
    fn cada_download_tem_o_arquivo_provisorio_dele() {
        let (um, outro) = (nome_do_parcial("awikabot-0.2.0-windows-x64.exe"), nome_do_parcial("awikabot-0.2.0-windows-x64.exe"));
        assert_ne!(um, outro);
        for nome in [um, outro] {
            // O nome continua dizendo de que pacote é, e que ainda não é o pacote.
            assert!(nome.starts_with("awikabot-0.2.0-windows-x64.exe.") && nome.ends_with(".part"), "{nome}");
        }
    }

    #[test]
    fn a_origem_de_verdade_so_fala_https() {
        let origem = Origem::do_github();
        assert!(origem.so_https);
        assert!(origem.api.starts_with("https://") && origem.downloads.starts_with("https://"));
        // Com essa regra, um endereço sem cifra nem chega a sair.
        let sem_cifra = Origem { api: "http://127.0.0.1:9".into(), downloads: "http://127.0.0.1:9".into(), ..origem };
        let erro = Atualizador::new(sem_cifra, "windows-x64").consultar(v(0, 1, 0));
        assert!(matches!(erro, Err(ErroDeAtualizacao::Rede(_))), "{erro:?}");
    }
}
