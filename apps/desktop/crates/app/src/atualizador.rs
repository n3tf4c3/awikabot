//! O painel de atualização do app: avisa que há versão nova, baixa quando a pessoa pede, confere
//! de quem é o pacote e chama o instalador.
//!
//! Cada passo só acontece a pedido: consultar não baixa, baixar não instala. A consulta é no
//! máximo uma por dia e pode ser desligada. O pacote só fica "pronto" depois de conferidos o
//! tamanho, o hash (`awikabot_cliente::atualizacao`) e a assinatura (`confianca`), e a assinatura
//! é conferida de novo na hora de instalar.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use awikabot_cliente::atualizacao::{self, Atualizador, ErroDeAtualizacao, Oferta, Origem, Versao};
use awikabot_cliente::preferencias::{self, Preferencias};
use gpui::{Context, SharedString, Window, div, prelude::*};

use crate::confianca::{self, Politica};
use crate::janela::{botao, texto_pequeno};
use crate::tema;

/// Como o instalador é chamado: em silêncio, só com a barra de progresso, fechando o app aberto
/// e reabrindo-o no fim.
const OPCOES_DO_INSTALADOR: [&str; 5] = ["/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CLOSEAPPLICATIONS", "/REABRIR=1"];
const AVISO_DE_ASSINATURA: &str = "O pacote baixado não tem a assinatura esperada e foi apagado.";

type Instalador = Arc<dyn Fn(&Path) -> std::io::Result<()> + Send + Sync>;

/// De onde vêm as versões e o que o painel precisa para trabalhar. Nos testes, tudo aponta para
/// um servidor de mentira e uma pasta temporária.
#[derive(Clone)]
pub struct Configuracao {
    pub origem: Origem,
    pub plataforma: String,
    pub atual: Versao,
    /// A pasta de dados do app: as preferências e os pacotes baixados.
    pub pasta: PathBuf,
    pub politica: Politica,
    /// Quanto esperar, depois de abrir, antes de consultar.
    pub espera: Duration,
    pub instalar: Instalador,
}

impl Configuracao {
    /// A do app de verdade. `None` onde não há pacote para baixar, e em build de desenvolvimento,
    /// que não se atualiza nem fala com a rede por conta própria.
    pub fn do_app() -> Option<Self> {
        if cfg!(debug_assertions) {
            return None;
        }
        let plataforma = atualizacao::plataforma()?;
        let pasta = PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("awikabot");
        Some(Self {
            origem: Origem::do_github(),
            plataforma: plataforma.to_owned(),
            atual: Versao::deste_app(),
            pasta,
            politica: Politica::do_app(),
            espera: Duration::from_secs(5),
            instalar: Arc::new(chamar_instalador),
        })
    }

    fn preferencias(&self) -> PathBuf {
        self.pasta.join("preferencias.json")
    }

    fn pacotes(&self) -> PathBuf {
        self.pasta.join("atualizacoes")
    }
}

fn chamar_instalador(arquivo: &Path) -> std::io::Result<()> {
    std::process::Command::new(arquivo).args(OPCOES_DO_INSTALADOR).spawn().map(|_| ())
}

fn agora_s() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |desde| desde.as_secs())
}

#[derive(Debug, Clone)]
enum Estado {
    Parado,
    Disponivel(Oferta),
    Baixando {
        oferta: Oferta,
        cancelar: Arc<AtomicBool>,
    },
    /// Baixado e conferido: tamanho, hash e assinatura.
    Pronta {
        oferta: Oferta,
        arquivo: PathBuf,
    },
    Instalando {
        oferta: Oferta,
    },
    Falhou {
        oferta: Oferta,
        motivo: SharedString,
    },
}

pub struct PainelDeAtualizacao {
    configuracao: Configuracao,
    preferencias: Preferencias,
    estado: Estado,
}

/// Baixa o pacote e confere de quem ele é. O que não passa na assinatura não fica no disco.
fn baixar_e_conferir(configuracao: &Configuracao, oferta: &Oferta, cancelar: &AtomicBool) -> Result<PathBuf, ErroNoDownload> {
    let arquivo = Atualizador::new(configuracao.origem.clone(), &configuracao.plataforma)
        .baixar(oferta, &configuracao.pacotes(), cancelar, &mut |_| {})
        .map_err(ErroNoDownload::Download)?;
    if confianca::conferir(&arquivo, &configuracao.politica).is_err() {
        let _ = std::fs::remove_file(&arquivo);
        return Err(ErroNoDownload::Assinatura);
    }
    Ok(arquivo)
}

enum ErroNoDownload {
    Download(ErroDeAtualizacao),
    Assinatura,
}

impl PainelDeAtualizacao {
    pub fn new(configuracao: Configuracao, cx: &mut Context<Self>) -> Self {
        let preferencias = preferencias::carregar(&configuracao.preferencias());
        // O que ficou de uma execução anterior não foi conferido por esta: começa do zero.
        let _ = std::fs::remove_dir_all(configuracao.pacotes());
        let mut painel = Self { configuracao, preferencias, estado: Estado::Parado };
        painel.consultar_se_for_hora(cx);
        painel
    }

    fn consultar_se_for_hora(&mut self, cx: &mut Context<Self>) {
        if !self.preferencias.avisar_de_versao_nova || !atualizacao::deve_consultar(self.preferencias.ultima_consulta_s, agora_s()) {
            return;
        }
        let configuracao = self.configuracao.clone();
        cx.spawn(async move |painel, cx| {
            cx.background_executor().timer(configuracao.espera).await;
            let resultado = cx
                .background_executor()
                .spawn(async move { Atualizador::new(configuracao.origem, &configuracao.plataforma).consultar(configuracao.atual) })
                .await;
            painel.update(cx, |painel, cx| painel.ao_consultar(resultado, cx)).ok();
        })
        .detach();
    }

    fn ao_consultar(&mut self, resultado: Result<Option<Oferta>, ErroDeAtualizacao>, cx: &mut Context<Self>) {
        // Sem resposta, não há o que avisar nem o que registrar: a próxima abertura tenta de novo.
        let Ok(oferta) = resultado else { return };
        self.preferencias.ultima_consulta_s = Some(agora_s());
        self.guardar_preferencias();
        // Só muda o que está na tela se a pessoa ainda não começou nada com outra oferta.
        if let (Some(oferta), Estado::Parado) = (oferta, &self.estado) {
            self.estado = Estado::Disponivel(oferta);
        }
        cx.notify();
    }

    fn guardar_preferencias(&self) {
        // Não conseguir gravar só custa uma consulta a mais na próxima abertura.
        let _ = preferencias::salvar(&self.configuracao.preferencias(), &self.preferencias);
    }

    fn alternar_aviso(&mut self, cx: &mut Context<Self>) {
        self.preferencias.avisar_de_versao_nova = !self.preferencias.avisar_de_versao_nova;
        self.guardar_preferencias();
        self.consultar_se_for_hora(cx);
        cx.notify();
    }

    fn baixar(&mut self, cx: &mut Context<Self>) {
        let (Estado::Disponivel(oferta) | Estado::Falhou { oferta, .. }) = &self.estado else { return };
        let (oferta, cancelar) = (oferta.clone(), Arc::new(AtomicBool::new(false)));
        self.estado = Estado::Baixando { oferta: oferta.clone(), cancelar: cancelar.clone() };
        cx.notify();
        let configuracao = self.configuracao.clone();
        // O download bloqueia enquanto durar e precisa poder ser cancelado no meio: vai numa thread
        // só dele, como o fluxo de eventos, e devolve o resultado por um canal.
        let (envio, recebimento) = futures::channel::oneshot::channel();
        let (da_tarefa, sinal) = (oferta.clone(), cancelar.clone());
        let iniciada = std::thread::Builder::new().name("awikabot-atualizacao".into()).spawn(move || {
            let _ = envio.send(baixar_e_conferir(&configuracao, &da_tarefa, &sinal));
        });
        cx.spawn(async move |painel, cx| {
            let resultado = match (iniciada, recebimento.await) {
                (Ok(_), Ok(resultado)) => resultado,
                // A thread não pôde ser criada, ou morreu sem responder.
                _ => Err(ErroNoDownload::Download(ErroDeAtualizacao::Disco("o download não pôde começar".into()))),
            };
            painel.update(cx, |painel, cx| painel.ao_baixar(oferta, &cancelar, resultado, cx)).ok();
        })
        .detach();
    }

    fn ao_baixar(&mut self, oferta: Oferta, cancelar: &AtomicBool, resultado: Result<PathBuf, ErroNoDownload>, cx: &mut Context<Self>) {
        self.estado = match resultado {
            // A pessoa cancelou: o que chegou depois disso não vale, tenha dado certo ou não.
            Ok(arquivo) if cancelar.load(Ordering::Relaxed) => {
                let _ = std::fs::remove_file(arquivo);
                Estado::Disponivel(oferta)
            }
            Err(_) if cancelar.load(Ordering::Relaxed) => Estado::Disponivel(oferta),
            Ok(arquivo) => Estado::Pronta { oferta, arquivo },
            Err(ErroNoDownload::Assinatura) => Estado::Falhou { oferta, motivo: AVISO_DE_ASSINATURA.into() },
            Err(ErroNoDownload::Download(erro)) => Estado::Falhou { oferta, motivo: format!("Não deu para baixar: {erro}.").into() },
        };
        cx.notify();
    }

    fn cancelar(&mut self, cx: &mut Context<Self>) {
        if let Estado::Baixando { cancelar, .. } = &self.estado {
            cancelar.store(true, Ordering::Relaxed);
            cx.notify();
        }
    }

    fn instalar(&mut self, cx: &mut Context<Self>) {
        let Estado::Pronta { oferta, arquivo } = &self.estado else { return };
        let (oferta, arquivo) = (oferta.clone(), arquivo.clone());
        self.estado = Estado::Instalando { oferta: oferta.clone() };
        cx.notify();
        let configuracao = self.configuracao.clone();
        cx.spawn(async move |painel, cx| {
            let chamado = cx
                .background_executor()
                .spawn(async move {
                    // O arquivo ficou no disco desde o download: a assinatura é conferida de novo antes de ele rodar.
                    if confianca::conferir(&arquivo, &configuracao.politica).is_err() {
                        let _ = std::fs::remove_file(&arquivo);
                        return Err(SharedString::from(AVISO_DE_ASSINATURA));
                    }
                    (configuracao.instalar)(&arquivo).map_err(|erro| format!("Não deu para abrir o instalador: {erro}.").into())
                })
                .await;
            painel
                .update(cx, |painel, cx| match chamado {
                    // O instalador fecha o app, troca o executável e o reabre; sair daqui é a parte do app.
                    Ok(()) => cx.quit(),
                    Err(motivo) => {
                        painel.estado = Estado::Falhou { oferta, motivo };
                        cx.notify();
                    }
                })
                .ok();
        })
        .detach();
    }
}

impl Render for PainelDeAtualizacao {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let linha = |texto: String, cor| texto_pequeno(texto, cor).w_full().min_w_0().whitespace_normal();
        let do_estado = match &self.estado {
            Estado::Parado => None,
            Estado::Disponivel(oferta) => Some(
                div().flex().flex_col().gap_1().child(linha(format!("Versão {} disponível", oferta.versao), tema::texto())).child(
                    botao("baixar-atualizacao", "Baixar", false)
                        .debug_selector(|| "baixar-atualizacao".into())
                        .on_click(cx.listener(|painel, _, _, cx| painel.baixar(cx))),
                ),
            ),
            Estado::Baixando { oferta, cancelar } => {
                let cancelando = cancelar.load(Ordering::Relaxed);
                let texto = if cancelando { "Cancelando…".to_owned() } else { format!("Baixando a versão {}…", oferta.versao) };
                Some(div().flex().flex_col().gap_1().child(linha(texto, tema::texto_secundario())).when(!cancelando, |bloco| {
                    bloco.child(
                        botao("cancelar-atualizacao", "Cancelar", false)
                            .debug_selector(|| "cancelar-atualizacao".into())
                            .on_click(cx.listener(|painel, _, _, cx| painel.cancelar(cx))),
                    )
                }))
            }
            Estado::Pronta { oferta, .. } => Some(
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(linha(format!("Versão {} baixada e conferida", oferta.versao), tema::estado_ok()))
                    .child(
                        botao("instalar-atualizacao", "Instalar e reabrir", true)
                            .debug_selector(|| "instalar-atualizacao".into())
                            .on_click(cx.listener(|painel, _, _, cx| painel.instalar(cx))),
                    ),
            ),
            Estado::Instalando { oferta } => Some(
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(linha(format!("Abrindo o instalador da versão {}…", oferta.versao), tema::texto_secundario())),
            ),
            Estado::Falhou { motivo, .. } => Some(
                div().flex().flex_col().gap_1().child(linha(motivo.to_string(), tema::estado_de_erro())).child(
                    botao("tentar-atualizacao", "Tentar de novo", false)
                        .debug_selector(|| "tentar-atualizacao".into())
                        .on_click(cx.listener(|painel, _, _, cx| painel.baixar(cx))),
                ),
            ),
        };
        let aviso = if self.preferencias.avisar_de_versao_nova { "Avisar de versão nova: sim" } else { "Avisar de versão nova: não" };
        div().flex().flex_col().gap_2().children(do_estado).child(
            texto_pequeno(aviso, tema::texto_apagado())
                .id("alternar-aviso-de-versao")
                .cursor_pointer()
                .hover(|estilo| estilo.text_color(tema::texto_secundario()))
                .debug_selector(|| "alternar-aviso-de-versao".into())
                .on_click(cx.listener(|painel, _, _, cx| painel.alternar_aviso(cx))),
        )
    }
}

#[cfg(test)]
mod testes {
    //! O painel sem tela, pelo apoio de testes da GPUI, com cliques nos botões de verdade, contra
    //! um servidor de mentira que faz o papel do GitHub.

    use std::sync::Mutex;
    use std::sync::atomic::AtomicUsize;
    use std::time::Instant;

    use awikabot_cliente::servidor_de_teste::{PedidoRecebido, RespostaFalsa, ServidorFalso};
    use gpui::{Entity, Modifiers, TestAppContext, VisualTestContext};
    use sha2::{Digest, Sha256};

    use super::*;

    const PLATAFORMA: &str = "windows-x64";
    const MANIFESTO: &str = "/dono/repositorio/releases/download/desktop-v0.2.0/awikabot-desktop-windows-x64.json";
    const PACOTE: &str = "/dono/repositorio/releases/download/desktop-v0.2.0/awikabot-0.2.0-windows-x64.exe";

    fn caminho(pedido: &PedidoRecebido) -> String {
        pedido.linha.split(' ').nth(1).unwrap_or_default().to_owned()
    }

    /// Publica a versão 0.2.0 com o pacote dado.
    fn publicar(pacote: RespostaFalsa, conteudo: &[u8]) -> ServidorFalso {
        let hash: String = Sha256::digest(conteudo).iter().map(|byte| format!("{byte:02x}")).collect();
        let manifesto = format!(
            r#"{{"versao":"0.2.0","plataforma":"{PLATAFORMA}","arquivo":"awikabot-0.2.0-{PLATAFORMA}.exe","tamanho":{},"sha256":"{hash}"}}"#,
            conteudo.len()
        );
        ServidorFalso::subir(move |_, pedido| match caminho(pedido).as_str() {
            "/repos/dono/repositorio/releases?per_page=30" => {
                RespostaFalsa::json(200, r#"[{"tag_name":"desktop-v0.2.0","assets":[{"name":"awikabot-desktop-windows-x64.json"}]}]"#)
            }
            MANIFESTO => RespostaFalsa::json(200, &manifesto),
            PACOTE => pacote.clone(),
            _ => RespostaFalsa::html(404),
        })
    }

    /// Uma pasta de dados só deste teste, apagada no fim.
    struct Pasta(PathBuf);

    impl Pasta {
        fn nova() -> Self {
            static CONTADOR: AtomicUsize = AtomicUsize::new(0);
            let nome = format!("awikabot-teste-atualizador-{}-{}", std::process::id(), CONTADOR.fetch_add(1, Ordering::Relaxed));
            let pasta = std::env::temp_dir().join(nome);
            let _ = std::fs::remove_dir_all(&pasta);
            Self(pasta)
        }

        fn pacotes(&self) -> Vec<String> {
            let Ok(itens) = std::fs::read_dir(self.0.join("atualizacoes")) else { return Vec::new() };
            itens.map(|item| item.expect("item").file_name().to_string_lossy().into_owned()).collect()
        }

        fn preferencias(&self) -> Preferencias {
            preferencias::carregar(&self.0.join("preferencias.json"))
        }
    }

    impl Drop for Pasta {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    type Chamadas = Arc<Mutex<Vec<PathBuf>>>;

    fn configurar(servidor: &ServidorFalso, pasta: &Pasta, politica: Politica) -> (Configuracao, Chamadas) {
        let chamadas: Chamadas = Arc::new(Mutex::new(Vec::new()));
        let registro = chamadas.clone();
        let configuracao = Configuracao {
            origem: Origem::de_teste(&servidor.base),
            plataforma: PLATAFORMA.to_owned(),
            atual: Versao { maior: 0, menor: 1, correcao: 0 },
            pasta: pasta.0.clone(),
            politica,
            espera: Duration::ZERO,
            instalar: Arc::new(move |arquivo| {
                registro.lock().expect("trava").push(arquivo.to_owned());
                Ok(())
            }),
        };
        (configuracao, chamadas)
    }

    fn de_ninguem() -> Politica {
        Politica { publicador: "Publicador de Teste".into(), emissor_contem: "Autoridade de Teste".into(), conferir_revogacao: false }
    }

    fn abrir(configuracao: Configuracao, cx: &mut TestAppContext) -> (Entity<PainelDeAtualizacao>, VisualTestContext) {
        cx.executor().allow_parking();
        let janela = cx.add_window(|_, cx| PainelDeAtualizacao::new(configuracao, cx));
        let mut cx = VisualTestContext::from_window(janela.into(), cx);
        let painel = janela.root(&mut cx).expect("raiz da janela");
        (painel, cx)
    }

    fn esperar(
        cx: &mut VisualTestContext,
        painel: &Entity<PainelDeAtualizacao>,
        o_que: &str,
        condicao: impl Fn(&PainelDeAtualizacao) -> bool,
    ) {
        let limite = Instant::now() + Duration::from_secs(20);
        loop {
            cx.run_until_parked();
            if painel.read_with(cx, |painel, _| condicao(painel)) {
                return;
            }
            assert!(
                Instant::now() < limite,
                "não aconteceu: {o_que}; estado: {:?}",
                painel.read_with(cx, |painel, _| painel.estado.clone())
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Dá tempo para um pedido que não devia sair, sair.
    fn assentar(cx: &mut VisualTestContext) {
        for _ in 0..15 {
            cx.run_until_parked();
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn clicar(cx: &mut VisualTestContext, seletor: &'static str) {
        cx.run_until_parked();
        let area = cx.debug_bounds(seletor).unwrap_or_else(|| panic!("não está na tela: {seletor}"));
        cx.simulate_click(area.center(), Modifiers::none());
    }

    fn na_tela(cx: &mut VisualTestContext, seletor: &'static str) -> bool {
        cx.run_until_parked();
        cx.debug_bounds(seletor).is_some()
    }

    fn disponivel(painel: &PainelDeAtualizacao) -> bool {
        matches!(&painel.estado, Estado::Disponivel(oferta) if oferta.versao.to_string() == "0.2.0")
    }

    #[gpui::test]
    fn ao_abrir_avisa_da_versao_nova_registra_a_consulta_e_nao_baixa_nada(cx: &mut TestAppContext) {
        let conteudo = b"pacote de teste";
        let servidor = publicar(RespostaFalsa::bytes(200, conteudo), conteudo);
        let pasta = Pasta::nova();
        let (configuracao, chamadas) = configurar(&servidor, &pasta, de_ninguem());
        let antes = agora_s();
        let (painel, mut cx) = abrir(configuracao.clone(), cx);
        esperar(&mut cx, &painel, "aviso da versão 0.2.0", disponivel);

        assert!(na_tela(&mut cx, "baixar-atualizacao") && !na_tela(&mut cx, "instalar-atualizacao"));
        assert!(pasta.preferencias().ultima_consulta_s.is_some_and(|quando| quando >= antes));
        assert!(servidor.pedidos().iter().all(|pedido| caminho(pedido) != PACOTE), "consultar não baixa o pacote");
        assert_eq!(pasta.pacotes(), Vec::<String>::new());
        assert!(chamadas.lock().expect("trava").is_empty());

        // Abrir de novo no mesmo dia não consulta outra vez.
        let pedidos = servidor.pedidos().len();
        let (segundo, mut cx) = abrir(configuracao, &mut cx);
        assentar(&mut cx);
        assert_eq!(servidor.pedidos().len(), pedidos, "a consulta é uma por dia");
        segundo.read_with(&cx, |painel, _| assert!(matches!(painel.estado, Estado::Parado), "{:?}", painel.estado));
    }

    #[gpui::test]
    fn versao_igual_nao_avisa_e_erro_na_consulta_nao_registra_nada(cx: &mut TestAppContext) {
        let conteudo = b"pacote de teste";
        let servidor = publicar(RespostaFalsa::bytes(200, conteudo), conteudo);
        let pasta = Pasta::nova();
        let (mut configuracao, _) = configurar(&servidor, &pasta, de_ninguem());
        configuracao.atual = Versao { maior: 0, menor: 2, correcao: 0 };
        let (painel, mut cx) = abrir(configuracao, cx);
        esperar(&mut cx, &painel, "consulta registrada", |painel| painel.preferencias.ultima_consulta_s.is_some());
        painel.read_with(&cx, |painel, _| assert!(matches!(painel.estado, Estado::Parado), "{:?}", painel.estado));
        assert!(!na_tela(&mut cx, "baixar-atualizacao"));

        // De onde as versões saem está fora do ar: nada aparece, e a próxima abertura tenta de novo.
        let fora_do_ar = ServidorFalso::subir(|_, _| RespostaFalsa::html(503));
        let outra = Pasta::nova();
        let (configuracao, _) = configurar(&fora_do_ar, &outra, de_ninguem());
        let (painel, mut cx) = abrir(configuracao, &mut cx);
        esperar(&mut cx, &painel, "a consulta saiu", |_| !fora_do_ar.pedidos().is_empty());
        assentar(&mut cx);
        painel.read_with(&cx, |painel, _| assert!(matches!(painel.estado, Estado::Parado), "{:?}", painel.estado));
        assert_eq!(outra.preferencias().ultima_consulta_s, None);
    }

    #[gpui::test]
    fn com_o_aviso_desligado_nada_sai_e_ligar_de_novo_consulta_na_hora(cx: &mut TestAppContext) {
        let conteudo = b"pacote de teste";
        let servidor = publicar(RespostaFalsa::bytes(200, conteudo), conteudo);
        let pasta = Pasta::nova();
        preferencias::salvar(&pasta.0.join("preferencias.json"), &Preferencias { avisar_de_versao_nova: false, ultima_consulta_s: None })
            .expect("gravar as preferências");
        let (configuracao, _) = configurar(&servidor, &pasta, de_ninguem());
        let (painel, mut cx) = abrir(configuracao, cx);
        assentar(&mut cx);
        assert_eq!(servidor.pedidos().len(), 0, "com o aviso desligado, o app não fala com ninguém");

        clicar(&mut cx, "alternar-aviso-de-versao");
        esperar(&mut cx, &painel, "aviso da versão 0.2.0", disponivel);
        assert!(pasta.preferencias().avisar_de_versao_nova);

        clicar(&mut cx, "alternar-aviso-de-versao");
        assert!(!pasta.preferencias().avisar_de_versao_nova, "desligar fica gravado");
    }

    #[gpui::test]
    fn pacote_sem_a_assinatura_esperada_e_apagado_e_nao_ha_como_instalar(cx: &mut TestAppContext) {
        // O pacote chega inteiro, com o tamanho e o hash publicados: quem publicou é que não é quem devia.
        let conteudo = b"um instalador que nao foi assinado por quem publica o app";
        let servidor = publicar(RespostaFalsa::bytes(200, conteudo), conteudo);
        let pasta = Pasta::nova();
        let (configuracao, chamadas) = configurar(&servidor, &pasta, de_ninguem());
        let (painel, mut cx) = abrir(configuracao, cx);
        esperar(&mut cx, &painel, "aviso da versão 0.2.0", disponivel);

        clicar(&mut cx, "baixar-atualizacao");
        esperar(&mut cx, &painel, "o download termina", |painel| !matches!(painel.estado, Estado::Baixando { .. }));
        painel.read_with(&cx, |painel, _| {
            assert!(
                matches!(&painel.estado, Estado::Falhou { motivo, .. } if motivo.as_ref() == AVISO_DE_ASSINATURA),
                "{:?}",
                painel.estado
            );
        });
        assert_eq!(pasta.pacotes(), Vec::<String>::new(), "o pacote recusado não fica no disco");
        assert!(!na_tela(&mut cx, "instalar-atualizacao"));
        assert!(chamadas.lock().expect("trava").is_empty(), "o instalador não foi chamado");
    }

    #[gpui::test]
    fn pacote_trocado_no_caminho_nao_fica_pronto(cx: &mut TestAppContext) {
        let publicado = b"o pacote que foi publicado";
        let servidor = publicar(RespostaFalsa::bytes(200, b"o pacote que chegou!!!!!!!"), publicado);
        let pasta = Pasta::nova();
        let (configuracao, chamadas) = configurar(&servidor, &pasta, de_ninguem());
        let (painel, mut cx) = abrir(configuracao, cx);
        esperar(&mut cx, &painel, "aviso da versão 0.2.0", disponivel);
        clicar(&mut cx, "baixar-atualizacao");
        esperar(&mut cx, &painel, "o download termina", |painel| !matches!(painel.estado, Estado::Baixando { .. }));
        painel.read_with(&cx, |painel, _| assert!(matches!(painel.estado, Estado::Falhou { .. }), "{:?}", painel.estado));
        assert_eq!(pasta.pacotes(), Vec::<String>::new());
        assert!(na_tela(&mut cx, "tentar-atualizacao") && !na_tela(&mut cx, "instalar-atualizacao"));
        assert!(chamadas.lock().expect("trava").is_empty());
    }

    #[gpui::test]
    fn cancelar_o_download_volta_ao_aviso_sem_deixar_arquivo(cx: &mut TestAppContext) {
        // O servidor manda só o começo do pacote e segura a conexão: o download fica em andamento.
        let conteudo = vec![7u8; 4096];
        let servidor = publicar(
            RespostaFalsa::bytes(200, &conteudo[..100]).declarando(conteudo.len()).segurando(Duration::from_millis(1500)),
            &conteudo,
        );
        let pasta = Pasta::nova();
        let (configuracao, chamadas) = configurar(&servidor, &pasta, de_ninguem());
        let (painel, mut cx) = abrir(configuracao, cx);
        esperar(&mut cx, &painel, "aviso da versão 0.2.0", disponivel);
        clicar(&mut cx, "baixar-atualizacao");
        esperar(&mut cx, &painel, "o pacote começou a ser pedido", |_| servidor.pedidos().iter().any(|pedido| caminho(pedido) == PACOTE));
        clicar(&mut cx, "cancelar-atualizacao");
        esperar(&mut cx, &painel, "de volta ao aviso", disponivel);
        assert_eq!(pasta.pacotes(), Vec::<String>::new());
        assert!(chamadas.lock().expect("trava").is_empty());
    }

    #[cfg(windows)]
    #[gpui::test]
    fn pacote_assinado_por_quem_a_regra_espera_fica_pronto_e_instalar_chama_o_instalador(cx: &mut TestAppContext) {
        // Faz o papel do pacote um executável pequeno com assinatura de verdade, e a regra do teste espera quem o assinou.
        let conteudo = std::fs::read(confianca::arquivo_assinado_de_teste()).expect("ler o arquivo assinado");
        let servidor = publicar(RespostaFalsa::bytes(200, &conteudo), &conteudo);
        let pasta = Pasta::nova();
        let da_microsoft =
            Politica { publicador: "Microsoft Corporation".into(), emissor_contem: "Microsoft".into(), conferir_revogacao: false };
        let (configuracao, chamadas) = configurar(&servidor, &pasta, da_microsoft);
        let (painel, mut cx) = abrir(configuracao, cx);
        esperar(&mut cx, &painel, "aviso da versão 0.2.0", disponivel);

        clicar(&mut cx, "baixar-atualizacao");
        esperar(&mut cx, &painel, "pacote pronto", |painel| matches!(painel.estado, Estado::Pronta { .. }));
        assert_eq!(pasta.pacotes(), vec!["awikabot-0.2.0-windows-x64.exe"]);
        assert!(chamadas.lock().expect("trava").is_empty(), "baixar não instala");

        clicar(&mut cx, "instalar-atualizacao");
        esperar(&mut cx, &painel, "o instalador é chamado", |_| !chamadas.lock().expect("trava").is_empty());
        let chamado = chamadas.lock().expect("trava").clone();
        assert_eq!(chamado, vec![pasta.0.join("atualizacoes").join("awikabot-0.2.0-windows-x64.exe")]);
        assert_eq!(std::fs::read(&chamado[0]).expect("ler"), conteudo, "o que roda é o que foi conferido");
    }

    #[cfg(windows)]
    #[gpui::test]
    fn pacote_alterado_no_disco_depois_de_conferido_nao_e_instalado(cx: &mut TestAppContext) {
        let conteudo = std::fs::read(confianca::arquivo_assinado_de_teste()).expect("ler o arquivo assinado");
        let servidor = publicar(RespostaFalsa::bytes(200, &conteudo), &conteudo);
        let pasta = Pasta::nova();
        let da_microsoft =
            Politica { publicador: "Microsoft Corporation".into(), emissor_contem: "Microsoft".into(), conferir_revogacao: false };
        let (configuracao, chamadas) = configurar(&servidor, &pasta, da_microsoft);
        let (painel, mut cx) = abrir(configuracao, cx);
        esperar(&mut cx, &painel, "aviso da versão 0.2.0", disponivel);
        clicar(&mut cx, "baixar-atualizacao");
        esperar(&mut cx, &painel, "pacote pronto", |painel| matches!(painel.estado, Estado::Pronta { .. }));

        // Entre o download e o clique, outro programa troca o arquivo que está no disco.
        let arquivo = pasta.0.join("atualizacoes").join("awikabot-0.2.0-windows-x64.exe");
        let mut alterado = conteudo.clone();
        let meio = alterado.len() / 2;
        alterado[meio] ^= 0xFF;
        std::fs::write(&arquivo, alterado).expect("trocar o arquivo");

        clicar(&mut cx, "instalar-atualizacao");
        esperar(&mut cx, &painel, "a instalação é recusada", |painel| matches!(painel.estado, Estado::Falhou { .. }));
        assert!(chamadas.lock().expect("trava").is_empty(), "o instalador não foi chamado");
        assert_eq!(pasta.pacotes(), Vec::<String>::new(), "o arquivo trocado foi apagado");
    }

    #[test]
    fn o_app_de_desenvolvimento_nao_se_atualiza() {
        // Os testes rodam em build de desenvolvimento: nele o painel nem existe.
        assert!(Configuracao::do_app().is_none());
    }

    #[test]
    fn o_instalador_e_chamado_em_silencio_fechando_e_reabrindo_o_app() {
        assert_eq!(OPCOES_DO_INSTALADOR, ["/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CLOSEAPPLICATIONS", "/REABRIR=1"]);
    }
}
