//! A janela do app: a tela de pareamento e a de conversa.
//!
//! Todo pedido ao servidor roda em segundo plano e volta para cá com a credencial que o fez. O
//! resultado só é usado se essa credencial ainda for a da sessão atual, e só a recusa do token
//! pelo próprio servidor desfaz o pareamento: a mesma regra do app de celular.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use awikabot_cliente::api::{Api, Credencial, ErroApi};
use awikabot_cliente::contrato::{
    Bot, BotEntrada, Evento, Mensagem, MensagemEstado, MensagemPapel, PedidoPareamento, PedidoTurno, RespostaPareamento, VERSAO_PROTOCOLO,
    limites,
};
use awikabot_cliente::conversa::{Conversa, Efeito};
use awikabot_cliente::endereco::normalizar_endereco;
use awikabot_cliente::fluxo::{Conexao, FimDoFluxo, Sinal, seguir};
use awikabot_cliente::sessao::{self, Cofre, Sessao};
use futures::StreamExt;
use futures::channel::mpsc;
use gpui::{
    App, Context, Entity, FocusHandle, Focusable, KeyBinding, ScrollHandle, SharedString, Subscription, Task, Window, actions, div,
    prelude::*, px,
};

use crate::campo::{CampoDeTexto, Confirmado};
use crate::tema;

actions!(janela, [ProximoCampo]);

const CONTEXTO: &str = "Janela";
/// O código tem doze caracteres; a folga é para os hifens e espaços que a pessoa digitar.
const LIMITE_DO_CODIGO: usize = 40;
const LIMITE_DO_ENDERECO: usize = 300;

/// Liga as teclas da janela. Chamado uma vez, na partida do app.
pub fn registrar_teclas(cx: &mut App) {
    cx.bind_keys([KeyBinding::new("tab", ProximoCampo, Some(CONTEXTO))]);
}

enum DoFluxo {
    Sinal(Sinal),
    Fim(FimDoFluxo),
}

/// O fluxo de eventos de uma sessão. Quando a sessão sai de cena, a thread do fluxo é avisada
/// para parar, e a tarefa que a escuta é cancelada.
struct FluxoAtivo {
    parar: Arc<AtomicBool>,
    _escuta: Task<()>,
}

impl Drop for FluxoAtivo {
    fn drop(&mut self) {
        self.parar.store(true, Ordering::Relaxed);
    }
}

struct Pareamento {
    servidor: Entity<CampoDeTexto>,
    codigo: Entity<CampoDeTexto>,
    nome: Entity<CampoDeTexto>,
    ocupado: bool,
    aviso: Option<SharedString>,
    _assinaturas: Vec<Subscription>,
}

/// A sessão em uso: o que veio do cofre ou do pareamento, mais o que está na tela.
struct SessaoAberta {
    credencial: Credencial,
    bots: Vec<Bot>,
    selecionado: Option<String>,
    conversa: Conversa,
    compositor: Entity<CampoDeTexto>,
    conexao: Option<Conexao>,
    aviso: Option<SharedString>,
    rolagem: ScrollHandle,
    _assinatura: Subscription,
    _fluxo: FluxoAtivo,
}

enum Tela {
    Pareamento(Pareamento),
    Sessao(Box<SessaoAberta>),
}

const AVISO_DE_RECUSA: &str = "O servidor não reconhece mais este computador. Pareie de novo.";

pub struct Janela {
    api: Api,
    cofre: Arc<dyn Cofre>,
    tela: Tela,
    foco: FocusHandle,
    /// O campo que deve receber o teclado no próximo desenho: quem troca de tela nem sempre tem
    /// a janela à mão para dar o foco na hora.
    foco_pendente: Option<FocusHandle>,
}

fn mensagem_do_erro(erro: &ErroApi) -> SharedString {
    match erro {
        ErroApi::Servidor { codigo, .. } if codigo == "codigo_invalido" => "Código inválido ou vencido. Gere outro no servidor.".into(),
        ErroApi::Servidor { codigo, .. } if codigo == "muitas_tentativas" => {
            "Muitas tentativas erradas. O servidor bloqueou o pareamento por alguns minutos.".into()
        }
        ErroApi::Servidor { codigo, .. } if codigo == "turno_em_andamento" => "O bot ainda está respondendo.".into(),
        ErroApi::Servidor { codigo, .. } if codigo == "limite_de_turnos" => {
            "O servidor já está com o máximo de respostas em andamento.".into()
        }
        ErroApi::Rede(_) => "Sem resposta do servidor. Confira o endereço e a rede.".into(),
        outro => format!("Não deu certo: {outro}.").into(),
    }
}

fn nome_padrao_do_aparelho() -> String {
    // O nome que a pessoa vê na lista de aparelhos do servidor; ela pode trocar antes de parear.
    std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "Computador".to_owned())
}

impl Janela {
    pub fn new(cofre: Arc<dyn Cofre>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let pareamento = Self::tela_de_pareamento(None, cx);
        window.focus(&pareamento.servidor.focus_handle(cx), cx);
        let mut janela = Self { api: Api::new(), cofre, tela: Tela::Pareamento(pareamento), foco: cx.focus_handle(), foco_pendente: None };
        // Quem já pareou este computador abre direto na conversa. Se o token não valer mais, o
        // primeiro pedido descobre, e o app volta ao pareamento explicando.
        if let Some(guardada) = sessao::carregar(janela.cofre.as_ref()) {
            janela.entrar(guardada.credencial(), cx);
        }
        janela
    }

    fn tela_de_pareamento(aviso: Option<SharedString>, cx: &mut Context<Self>) -> Pareamento {
        let servidor = cx.new(|cx| CampoDeTexto::new("https://bots.exemplo.com", LIMITE_DO_ENDERECO, cx));
        let codigo = cx.new(|cx| CampoDeTexto::new("XXXX-XXXX-XXXX", LIMITE_DO_CODIGO, cx));
        let nome = cx.new(|cx| {
            let mut campo = CampoDeTexto::new("Nome deste computador", limites::NOME_DISPOSITIVO, cx);
            campo.definir(&nome_padrao_do_aparelho(), cx);
            campo
        });
        let assinaturas = [&servidor, &codigo, &nome]
            .map(|campo| cx.subscribe(campo, |janela: &mut Self, _, _: &Confirmado, cx| janela.parear(cx)))
            .into();
        Pareamento { servidor, codigo, nome, ocupado: false, aviso, _assinaturas: assinaturas }
    }

    /// Roda um pedido em segundo plano e entrega o resultado de volta à janela.
    fn em_segundo_plano<R: Send + 'static>(
        &self,
        cx: &mut Context<Self>,
        pedido: impl FnOnce(Api) -> R + Send + 'static,
        depois: impl FnOnce(&mut Self, R, &mut Context<Self>) + 'static,
    ) {
        let api = self.api.clone();
        cx.spawn(async move |janela, cx| {
            let resultado = cx.background_executor().spawn(async move { pedido(api) }).await;
            janela.update(cx, |janela, cx| depois(janela, resultado, cx)).ok();
        })
        .detach();
    }

    // --- Pareamento -------------------------------------------------------------

    fn parear(&mut self, cx: &mut Context<Self>) {
        let Tela::Pareamento(tela) = &mut self.tela else { return };
        if tela.ocupado {
            return;
        }
        let servidor = match normalizar_endereco(tela.servidor.read(cx).texto()) {
            Ok(servidor) => servidor,
            Err(motivo) => {
                tela.aviso = Some(motivo.mensagem().into());
                cx.notify();
                return;
            }
        };
        let pedido =
            PedidoPareamento { codigo: tela.codigo.read(cx).texto().to_owned(), nome: tela.nome.read(cx).texto().trim().to_owned() };
        if pedido.codigo.trim().is_empty() || pedido.nome.is_empty() {
            tela.aviso = Some("Informe o código de pareamento e o nome deste computador.".into());
            cx.notify();
            return;
        }
        tela.ocupado = true;
        tela.aviso = None;
        cx.notify();

        let destino = servidor.clone();
        self.em_segundo_plano(
            cx,
            move |api| api.parear(&destino, &pedido),
            move |janela, resposta, cx| janela.ao_parear(servidor, resposta, cx),
        );
    }

    fn ao_parear(&mut self, servidor: String, resposta: Result<RespostaPareamento, ErroApi>, cx: &mut Context<Self>) {
        let Tela::Pareamento(tela) = &mut self.tela else { return };
        tela.ocupado = false;
        match resposta {
            Ok(resposta) if resposta.servidor.protocolo == VERSAO_PROTOCOLO => {
                let nova = Sessao { servidor, token: resposta.token, dispositivo: resposta.dispositivo };
                // A sessão só passa a valer depois de guardada.
                match sessao::guardar(self.cofre.as_ref(), &nova) {
                    Ok(()) => self.entrar(nova.credencial(), cx),
                    Err(_) => {
                        tela.aviso = Some("Não foi possível guardar o pareamento neste computador. Tente de novo.".into());
                        // O token que não vai ser usado é revogado, para não ficar um aparelho fantasma no servidor.
                        let sem_uso = nova.credencial();
                        self.em_segundo_plano(cx, move |api| api.revogar_dispositivo(&sem_uso), |_, _, _| {});
                    }
                }
            }
            Ok(resposta) => {
                tela.aviso = Some(
                    format!(
                        "Este app e o servidor falam versões diferentes do protocolo (app: {VERSAO_PROTOCOLO}, servidor: {}). Atualize o mais antigo.",
                        resposta.servidor.protocolo
                    )
                    .into(),
                );
                // O token que não vai ser usado é revogado, para não ficar um aparelho fantasma no servidor.
                let sem_uso = Credencial { servidor, token: resposta.token };
                self.em_segundo_plano(cx, move |api| api.revogar_dispositivo(&sem_uso), |_, _, _| {});
            }
            Err(erro) => tela.aviso = Some(mensagem_do_erro(&erro)),
        }
        cx.notify();
    }

    // --- Sessão -----------------------------------------------------------------

    fn entrar(&mut self, credencial: Credencial, cx: &mut Context<Self>) {
        let compositor = cx.new(|cx| CampoDeTexto::new("Escreva para o bot", limites::TEXTO, cx));
        let assinatura = cx.subscribe(&compositor, |janela: &mut Self, _, _: &Confirmado, cx| janela.enviar(cx));
        self.foco_pendente = Some(compositor.focus_handle(cx));

        // O fluxo bloqueia enquanto durar: fica numa thread só dele e fala com a janela por um canal.
        let parar = Arc::new(AtomicBool::new(false));
        let (envio, mut recebimento) = mpsc::unbounded();
        let (do_fluxo, parar_fluxo) = (credencial.clone(), parar.clone());
        let iniciada = std::thread::Builder::new().name("awikabot-fluxo".into()).spawn(move || {
            let fim = seguir(&do_fluxo, &parar_fluxo, &mut |sinal| {
                let _ = envio.unbounded_send(DoFluxo::Sinal(sinal));
            });
            let _ = envio.unbounded_send(DoFluxo::Fim(fim));
        });
        let da_sessao = credencial.clone();
        let escuta = cx.spawn(async move |janela, cx| {
            while let Some(recebido) = recebimento.next().await {
                if janela.update(cx, |janela, cx| janela.do_fluxo(&da_sessao, recebido, cx)).is_err() {
                    break;
                }
            }
        });

        self.tela = Tela::Sessao(Box::new(SessaoAberta {
            credencial: credencial.clone(),
            bots: Vec::new(),
            selecionado: None,
            conversa: Conversa::default(),
            compositor,
            conexao: None,
            aviso: iniciada.is_err().then(|| "Não foi possível acompanhar o servidor em tempo real.".into()),
            rolagem: ScrollHandle::new(),
            _assinatura: assinatura,
            _fluxo: FluxoAtivo { parar, _escuta: escuta },
        }));
        self.carregar_bots(&credencial, cx);
        cx.notify();
    }

    /// A sessão atual, se ela ainda for a que fez o pedido.
    fn sessao_de(&mut self, credencial: &Credencial) -> Option<&mut SessaoAberta> {
        match &mut self.tela {
            Tela::Sessao(sessao) if &sessao.credencial == credencial => Some(sessao),
            _ => None,
        }
    }

    /// Volta ao pareamento. A sessão sai de cena, o fluxo dela para e o cofre é esvaziado antes de
    /// qualquer outra coisa: um pareamento feito em seguida não corre o risco de ser apagado por
    /// uma limpeza atrasada.
    fn sair(&mut self, aviso: Option<SharedString>, cx: &mut Context<Self>) {
        // Se nem apagar nem sobrescrever deu certo, a sessão antiga volta na próxima abertura, e
        // quem a recusa é o servidor.
        let _ = sessao::esquecer(self.cofre.as_ref());
        let pareamento = Self::tela_de_pareamento(aviso, cx);
        self.foco_pendente = Some(pareamento.servidor.focus_handle(cx));
        self.tela = Tela::Pareamento(pareamento);
        cx.notify();
    }

    /// Trata a resposta de um pedido da sessão `credencial`. Devolve o valor se deu certo e a
    /// sessão ainda é a mesma; a recusa do token pelo servidor desfaz o pareamento.
    fn conferir<T>(&mut self, credencial: &Credencial, resposta: Result<T, ErroApi>, cx: &mut Context<Self>) -> Option<T> {
        self.sessao_de(credencial)?;
        match resposta {
            Ok(valor) => Some(valor),
            Err(ErroApi::NaoAutenticado) => {
                self.sair(Some(AVISO_DE_RECUSA.into()), cx);
                None
            }
            Err(erro) => {
                if let Some(sessao) = self.sessao_de(credencial) {
                    sessao.aviso = Some(mensagem_do_erro(&erro));
                }
                cx.notify();
                None
            }
        }
    }

    fn carregar_bots(&mut self, credencial: &Credencial, cx: &mut Context<Self>) {
        let (do_pedido, da_resposta) = (credencial.clone(), credencial.clone());
        self.em_segundo_plano(
            cx,
            move |api| api.listar_bots(&do_pedido),
            move |janela, resposta, cx| {
                let Some(lista) = janela.conferir(&da_resposta, resposta, cx) else { return };
                let Some(sessao) = janela.sessao_de(&da_resposta) else { return };
                sessao.bots = lista.bots;
                let escolhido = sessao.selecionado.clone().filter(|id| sessao.bots.iter().any(|bot| &bot.id == id));
                let primeiro = sessao.bots.first().map(|bot| bot.id.clone());
                match escolhido.or(primeiro) {
                    Some(id) => janela.selecionar(&da_resposta, id, cx),
                    None => cx.notify(),
                }
            },
        );
    }

    fn selecionar(&mut self, credencial: &Credencial, bot_id: String, cx: &mut Context<Self>) {
        let Some(sessao) = self.sessao_de(credencial) else { return };
        if sessao.selecionado.as_deref() != Some(bot_id.as_str()) {
            sessao.conversa = Conversa::default();
            sessao.selecionado = Some(bot_id.clone());
        }
        cx.notify();
        self.carregar_mensagens(credencial, bot_id, cx);
    }

    fn carregar_mensagens(&mut self, credencial: &Credencial, bot_id: String, cx: &mut Context<Self>) {
        let (do_pedido, da_resposta, do_bot) = (credencial.clone(), credencial.clone(), bot_id.clone());
        self.em_segundo_plano(
            cx,
            move |api| api.listar_mensagens(&do_pedido, &bot_id),
            move |janela, resposta, cx| {
                let Some(pagina) = janela.conferir(&da_resposta, resposta, cx) else { return };
                let Some(sessao) = janela.sessao_de(&da_resposta) else { return };
                // A resposta de um bot que a pessoa já deixou de olhar não entra na conversa do outro.
                if sessao.selecionado.as_deref() == Some(do_bot.as_str()) {
                    sessao.conversa.trocar(pagina.mensagens);
                    sessao.rolagem.scroll_to_bottom();
                    cx.notify();
                }
            },
        );
    }

    fn novo_bot(&mut self, cx: &mut Context<Self>) {
        let Tela::Sessao(sessao) = &self.tela else { return };
        let credencial = sessao.credencial.clone();
        let entrada = BotEntrada { nome: format!("Bot {}", sessao.bots.len() + 1), instrucoes: None, modelo: None };
        let (do_pedido, da_resposta) = (credencial.clone(), credencial);
        self.em_segundo_plano(
            cx,
            move |api| api.criar_bot(&do_pedido, &entrada),
            move |janela, resposta, cx| {
                let Some(bot) = janela.conferir(&da_resposta, resposta, cx) else { return };
                let Some(sessao) = janela.sessao_de(&da_resposta) else { return };
                let id = bot.id.clone();
                guardar_bot(&mut sessao.bots, bot);
                janela.selecionar(&da_resposta, id, cx);
            },
        );
    }

    fn enviar(&mut self, cx: &mut Context<Self>) {
        let Tela::Sessao(sessao) = &mut self.tela else { return };
        let Some(bot_id) = sessao.selecionado.clone() else { return };
        let texto = sessao.compositor.read(cx).texto().trim().to_owned();
        if texto.is_empty() {
            return;
        }
        sessao.compositor.update(cx, |campo, cx| campo.definir("", cx));
        sessao.aviso = None;
        let credencial = sessao.credencial.clone();
        let (do_pedido, da_resposta, do_bot) = (credencial.clone(), credencial, bot_id.clone());
        self.em_segundo_plano(
            cx,
            move |api| api.enviar_turno(&do_pedido, &bot_id, &PedidoTurno { texto }),
            move |janela, resposta, cx| {
                let Some(turno) = janela.conferir(&da_resposta, resposta, cx) else { return };
                let Some(sessao) = janela.sessao_de(&da_resposta) else { return };
                if sessao.selecionado.as_deref() == Some(do_bot.as_str()) {
                    sessao.conversa.registrar_turno(turno);
                    sessao.rolagem.scroll_to_bottom();
                    cx.notify();
                }
            },
        );
    }

    fn desparear(&mut self, cx: &mut Context<Self>) {
        let Tela::Sessao(sessao) = &self.tela else { return };
        let credencial = sessao.credencial.clone();
        // O servidor é avisado por melhor esforço; a sessão local acaba de qualquer jeito.
        self.em_segundo_plano(cx, move |api| api.revogar_dispositivo(&credencial), |_, _, _| {});
        self.sair(None, cx);
    }

    fn do_fluxo(&mut self, credencial: &Credencial, recebido: DoFluxo, cx: &mut Context<Self>) {
        let Some(sessao) = self.sessao_de(credencial) else { return };
        match recebido {
            DoFluxo::Fim(FimDoFluxo::NaoAutenticado) => self.sair(Some(AVISO_DE_RECUSA.into()), cx),
            DoFluxo::Fim(FimDoFluxo::Parado) => {}
            DoFluxo::Sinal(Sinal::Conexao(conexao)) => {
                sessao.conexao = Some(conexao);
                cx.notify();
            }
            DoFluxo::Sinal(Sinal::Evento(evento)) => {
                if let Evento::BotSalvo { bot } = &evento {
                    guardar_bot(&mut sessao.bots, bot.clone());
                }
                let recarregar = match sessao.selecionado.clone() {
                    Some(bot_id) => (sessao.conversa.aplicar(&bot_id, &evento) == Efeito::Recarregar).then_some(bot_id),
                    None => None,
                };
                sessao.rolagem.scroll_to_bottom();
                cx.notify();
                if evento == Evento::Ressincronizar {
                    self.carregar_bots(credencial, cx);
                } else if let Some(bot_id) = recarregar {
                    self.carregar_mensagens(credencial, bot_id, cx);
                }
            }
        }
    }

    fn proximo_campo(&mut self, _: &ProximoCampo, window: &mut Window, cx: &mut Context<Self>) {
        let Tela::Pareamento(tela) = &self.tela else { return };
        let campos = [&tela.servidor, &tela.codigo, &tela.nome];
        let atual = campos.iter().position(|campo| campo.focus_handle(cx).is_focused(window)).unwrap_or(campos.len() - 1);
        window.focus(&campos[(atual + 1) % campos.len()].focus_handle(cx), cx);
    }
}

fn guardar_bot(bots: &mut Vec<Bot>, bot: Bot) {
    match bots.iter_mut().find(|atual| atual.id == bot.id) {
        Some(atual) => *atual = bot,
        None => bots.push(bot),
    }
}

// --- Desenho ------------------------------------------------------------------

fn botao(id: &'static str, rotulo: impl Into<SharedString>, principal: bool) -> gpui::Stateful<gpui::Div> {
    let base = div().id(id).h(px(30.)).px_3().flex().items_center().justify_center().rounded_md().cursor_pointer().child(rotulo.into());
    if principal {
        base.bg(tema::destaque()).text_color(tema::texto_no_destaque()).font_weight(gpui::FontWeight::SEMIBOLD)
    } else {
        base.bg(tema::elevado()).border_1().border_color(tema::borda_de_controle()).hover(|estilo| estilo.bg(tema::sob_o_mouse()))
    }
}

fn rotulo_do_campo(texto: &'static str) -> gpui::Div {
    div().text_size(px(tema::TAMANHO_PEQUENO)).text_color(tema::texto_secundario()).child(texto)
}

fn rotulo_do_estado(mensagem: &Mensagem) -> Option<(&'static str, gpui::Rgba)> {
    match mensagem.estado {
        MensagemEstado::Completa => None,
        MensagemEstado::EmAndamento => Some(("Respondendo…", tema::texto_secundario())),
        MensagemEstado::Parada => Some(("Resposta interrompida", tema::estado_de_aviso())),
        MensagemEstado::Falhou => Some(("A resposta falhou", tema::estado_de_erro())),
    }
}

impl Janela {
    fn desenhar_pareamento(&self, tela: &Pareamento, cx: &mut Context<Self>) -> gpui::Div {
        let aviso = tela.aviso.clone().map(|texto| div().text_color(tema::estado_de_erro()).child(texto));
        div().size_full().flex().items_center().justify_center().child(
            div()
                .w(px(380.))
                .flex()
                .flex_col()
                .gap_3()
                .child(div().text_size(px(22.)).text_color(tema::texto_forte()).font_weight(gpui::FontWeight::SEMIBOLD).child("awikabot"))
                .child(
                    div()
                        .text_color(tema::texto_secundario())
                        .child("Para parear, gere um código no servidor com o comando parear e informe abaixo."),
                )
                .child(div().flex().flex_col().gap_1().child(rotulo_do_campo("Endereço do servidor")).child(tela.servidor.clone()))
                .child(div().flex().flex_col().gap_1().child(rotulo_do_campo("Código de pareamento")).child(tela.codigo.clone()))
                .child(div().flex().flex_col().gap_1().child(rotulo_do_campo("Nome deste computador")).child(tela.nome.clone()))
                .children(aviso)
                .child(
                    botao("parear", if tela.ocupado { "Pareando…" } else { "Parear" }, true)
                        .on_click(cx.listener(|janela, _, _, cx| janela.parear(cx))),
                )
                .child(
                    div()
                        .text_size(px(tema::TAMANHO_PEQUENO))
                        .text_color(tema::texto_apagado())
                        .child(format!("Protocolo {VERSAO_PROTOCOLO}")),
                ),
        )
    }

    fn desenhar_lateral(&self, sessao: &SessaoAberta, cx: &mut Context<Self>) -> gpui::Div {
        let (estado, cor) = match sessao.conexao {
            Some(Conexao::Conectada) => ("Conectado", tema::estado_ok()),
            Some(Conexao::Reconectando) => ("Reconectando…", tema::estado_de_aviso()),
            None => ("Conectando…", tema::texto_secundario()),
        };
        let credencial = sessao.credencial.clone();
        let bots = sessao.bots.iter().enumerate().map(|(indice, bot)| {
            let escolhido = sessao.selecionado.as_deref() == Some(bot.id.as_str());
            let (credencial, id) = (credencial.clone(), bot.id.clone());
            div()
                .id(("bot", indice))
                .px_3()
                .py_1p5()
                .flex()
                .items_center()
                .gap_2()
                .cursor_pointer()
                .when(escolhido, |linha| linha.bg(tema::selecionado()).text_color(tema::texto_forte()))
                .when(!escolhido, |linha| linha.hover(|estilo| estilo.bg(tema::sob_o_mouse())))
                .child(div().flex_1().min_w_0().truncate().child(bot.nome.clone()))
                .when(bot.turno_ativo, |linha| {
                    linha.child(div().text_size(px(tema::TAMANHO_PEQUENO)).text_color(tema::estado_de_aviso()).child("respondendo"))
                })
                .on_click(cx.listener(move |janela, _, _, cx| janela.selecionar(&credencial, id.clone(), cx)))
        });

        div()
            .w(px(240.))
            .flex_none()
            .h_full()
            .flex()
            .flex_col()
            .bg(tema::painel())
            .border_r_1()
            .border_color(tema::divisoria())
            .child(
                div()
                    .p_3()
                    .flex()
                    .items_center()
                    .justify_between()
                    .border_b_1()
                    .border_color(tema::divisoria())
                    .child(div().text_color(tema::texto_forte()).font_weight(gpui::FontWeight::SEMIBOLD).child("Bots"))
                    .child(botao("novo-bot", "Novo bot", false).on_click(cx.listener(|janela, _, _, cx| janela.novo_bot(cx)))),
            )
            .child(div().id("lista-de-bots").flex_1().min_h_0().overflow_y_scroll().py_1().children(bots))
            .child(
                div()
                    .p_3()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .border_t_1()
                    .border_color(tema::divisoria())
                    .child(div().text_size(px(tema::TAMANHO_PEQUENO)).text_color(cor).child(estado))
                    .child(botao("desparear", "Desparear", false).on_click(cx.listener(|janela, _, _, cx| janela.desparear(cx)))),
            )
    }

    fn desenhar_conversa(&self, sessao: &SessaoAberta, cx: &mut Context<Self>) -> gpui::Div {
        let bot = sessao.selecionado.as_ref().and_then(|id| sessao.bots.iter().find(|bot| &bot.id == id));
        let Some(bot) = bot else {
            return div()
                .flex_1()
                .flex()
                .items_center()
                .justify_center()
                .text_color(tema::texto_secundario())
                .child("Nenhum bot ainda. Crie um em \"Novo bot\".");
        };

        let nome = bot.nome.clone();
        let mensagens = sessao.conversa.mensagens.iter().map(|mensagem| {
            let da_pessoa = mensagem.papel == MensagemPapel::Usuario;
            let quem: SharedString = if da_pessoa { "Você".into() } else { nome.clone().into() };
            let estado =
                rotulo_do_estado(mensagem).map(|(texto, cor)| div().text_size(px(tema::TAMANHO_PEQUENO)).text_color(cor).child(texto));
            div()
                .w_full()
                .min_w_0()
                .flex_none()
                .flex()
                .flex_col()
                .gap_1()
                .p_3()
                .rounded_md()
                .when(da_pessoa, |bloco| bloco.bg(tema::elevado()))
                .child(div().text_size(px(tema::TAMANHO_PEQUENO)).text_color(tema::texto_secundario()).child(quem))
                .when(!mensagem.texto.is_empty(), |bloco| {
                    bloco.child(div().w_full().min_w_0().whitespace_normal().text_color(tema::texto()).child(mensagem.texto.clone()))
                })
                .children(estado)
        });
        let aviso = sessao.aviso.clone().map(|texto| div().px_4().pb_2().text_color(tema::estado_de_aviso()).child(texto));

        // Sem largura mínima zero, um texto longo empurra a coluna para fora da janela em vez de quebrar.
        div()
            .flex_1()
            .min_w_0()
            .h_full()
            .flex()
            .flex_col()
            .child(
                div()
                    .p_3()
                    .truncate()
                    .border_b_1()
                    .border_color(tema::divisoria())
                    .text_color(tema::texto_forte())
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .child(bot.nome.clone()),
            )
            .child(
                div()
                    .id("mensagens")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .track_scroll(&sessao.rolagem)
                    .p_4()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .children(mensagens),
            )
            .children(aviso)
            .child(
                div()
                    .p_3()
                    .flex()
                    .items_center()
                    .gap_2()
                    .border_t_1()
                    .border_color(tema::divisoria())
                    .child(div().flex_1().min_w_0().child(sessao.compositor.clone()))
                    .child(botao("enviar", "Enviar", true).on_click(cx.listener(|janela, _, _, cx| janela.enviar(cx)))),
            )
    }
}

impl Focusable for Janela {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.foco.clone()
    }
}

impl Render for Janela {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some(foco) = self.foco_pendente.take() {
            window.focus(&foco, cx);
        }
        let conteudo = match &self.tela {
            Tela::Pareamento(tela) => self.desenhar_pareamento(tela, cx),
            Tela::Sessao(sessao) => {
                div().size_full().flex().child(self.desenhar_lateral(sessao, cx)).child(self.desenhar_conversa(sessao, cx))
            }
        };
        div()
            .key_context(CONTEXTO)
            .track_focus(&self.foco)
            .on_action(cx.listener(Self::proximo_campo))
            .size_full()
            .bg(tema::fundo())
            .text_color(tema::texto())
            .text_size(px(tema::TAMANHO_DO_TEXTO))
            .line_height(px(tema::ALTURA_DA_LINHA))
            .child(conteudo)
    }
}

#[cfg(test)]
mod testes {
    //! A janela dirigida sem tela, pelo apoio de testes da GPUI, contra o servidor de verdade:
    //! o que se digita e as teclas passam pelo mesmo caminho de uma pessoa usando o app.
    //! O cofre é o de memória; o do sistema tem teste próprio em `cofre_do_sistema.rs`.

    use std::time::{Duration, Instant};

    use awikabot_cliente::servidor_de_teste::{RespostaFalsa, ServidorDeTeste, ServidorFalso};
    use awikabot_cliente::sessao::CofreEmMemoria;
    use gpui::{TestAppContext, VisualTestContext};

    use super::*;
    use crate::campo;

    fn abrir(cofre: &Arc<CofreEmMemoria>, cx: &mut TestAppContext) -> (Entity<Janela>, VisualTestContext) {
        cx.update(|cx| {
            campo::registrar_teclas(cx);
            registrar_teclas(cx);
        });
        let do_app: Arc<dyn Cofre> = cofre.clone();
        let janela = cx.add_window(|window, cx| Janela::new(do_app, window, cx));
        let mut cx = VisualTestContext::from_window(janela.into(), cx);
        let raiz = janela.root(&mut cx).expect("raiz da janela");
        (raiz, cx)
    }

    /// Espera uma condição da janela, deixando as tarefas e a rede andarem.
    fn esperar(cx: &mut VisualTestContext, janela: &Entity<Janela>, o_que: &str, condicao: impl Fn(&Janela) -> bool) {
        let limite = Instant::now() + Duration::from_secs(20);
        loop {
            cx.run_until_parked();
            if janela.read_with(cx, |janela, _| condicao(janela)) {
                return;
            }
            assert!(Instant::now() < limite, "não aconteceu: {o_que}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn aberta(janela: &Janela) -> Option<&SessaoAberta> {
        match &janela.tela {
            Tela::Sessao(sessao) => Some(sessao),
            Tela::Pareamento(_) => None,
        }
    }

    fn aviso_do_pareamento(janela: &Janela) -> Option<String> {
        match &janela.tela {
            Tela::Pareamento(tela) => tela.aviso.as_ref().map(ToString::to_string),
            Tela::Sessao(_) => None,
        }
    }

    fn conectada(janela: &Janela) -> bool {
        aberta(janela).is_some_and(|sessao| sessao.conexao == Some(Conexao::Conectada))
    }

    /// Um computador já pareado, como ficaria no cofre.
    fn parear_pela_api(servidor: &ServidorDeTeste, nome: &str) -> Sessao {
        let pedido = PedidoPareamento { codigo: servidor.codigo_de_pareamento(), nome: nome.into() };
        let resposta = Api::new().parear(&servidor.base, &pedido).expect("parear pela API");
        Sessao { servidor: servidor.base.clone(), token: resposta.token, dispositivo: resposta.dispositivo }
    }

    fn cofre_com(guardada: &Sessao) -> Arc<CofreEmMemoria> {
        Arc::new(CofreEmMemoria::com(&sessao::serializar(guardada)))
    }

    #[gpui::test]
    fn endereco_sem_https_fora_da_rede_local_nem_sai_do_app(cx: &mut TestAppContext) {
        let cofre = Arc::new(CofreEmMemoria::default());
        let (janela, mut cx) = abrir(&cofre, cx);
        cx.simulate_input("http://bots.exemplo.com");
        cx.simulate_keystrokes("tab");
        cx.simulate_input("ABCD-EFGH-2345");
        cx.simulate_keystrokes("enter");
        cx.run_until_parked();
        janela.read_with(&cx, |janela, _| {
            assert_eq!(
                aviso_do_pareamento(janela).as_deref(),
                Some("Use https:// neste endereço. http:// só vale para localhost e endereços da rede local.")
            );
            let Tela::Pareamento(tela) = &janela.tela else { panic!("devia continuar no pareamento") };
            assert!(!tela.ocupado, "nenhum pedido devia ter saído");
        });
        assert!(cofre.tentativas_de_gravar().is_empty());
    }

    #[gpui::test]
    fn pareia_pelo_teclado_guarda_a_sessao_conversa_e_despareia(cx: &mut TestAppContext) {
        cx.executor().allow_parking();
        let servidor = ServidorDeTeste::subir();
        let cofre = Arc::new(CofreEmMemoria::default());
        let (janela, mut cx) = abrir(&cofre, cx);

        // Código errado primeiro: a mensagem do servidor aparece, a tela continua a mesma e nada é guardado.
        cx.simulate_input(&servidor.base);
        cx.simulate_keystrokes("tab");
        cx.simulate_input("AAAA-AAAA-AAAA");
        cx.simulate_keystrokes("enter");
        esperar(&mut cx, &janela, "aviso de código inválido", |janela| aviso_do_pareamento(janela).is_some());
        janela.read_with(&cx, |janela, _| {
            assert_eq!(aviso_do_pareamento(janela).as_deref(), Some("Código inválido ou vencido. Gere outro no servidor."));
        });
        assert_eq!(cofre.valor(), None);

        // Apaga o código errado com a tecla de apagar e digita o certo.
        cx.simulate_keystrokes(&"backspace ".repeat(14));
        cx.simulate_input(&servidor.codigo_de_pareamento().to_lowercase());
        cx.simulate_keystrokes("enter");
        esperar(&mut cx, &janela, "sessão conectada", conectada);

        // A sessão foi para o cofre, com o endereço normalizado e um token que o servidor aceita.
        let guardada = sessao::carregar(cofre.as_ref()).expect("sessão guardada no cofre");
        assert_eq!(guardada.servidor, servidor.base);
        assert!(Api::new().listar_bots(&guardada.credencial()).is_ok());

        // Um bot, e uma mensagem escrita no campo e enviada com Enter.
        janela.update(&mut cx, |janela, cx| janela.novo_bot(cx));
        esperar(&mut cx, &janela, "bot criado e selecionado", |janela| {
            aberta(janela).is_some_and(|sessao| sessao.bots.len() == 1 && sessao.selecionado.is_some())
        });
        // Sem clicar em nada: ao entrar na sessão, o teclado já cai no campo de mensagem.
        cx.simulate_input("olá mundo");
        cx.simulate_keystrokes("enter");
        esperar(&mut cx, &janela, "resposta completa do bot", |janela| {
            aberta(janela).is_some_and(|sessao| {
                sessao
                    .conversa
                    .mensagens
                    .last()
                    .is_some_and(|ultima| ultima.estado == MensagemEstado::Completa && ultima.papel == MensagemPapel::Bot)
            })
        });
        janela.read_with(&cx, |janela, cx| {
            let sessao = aberta(janela).expect("sessão");
            let textos: Vec<_> = sessao.conversa.mensagens.iter().map(|mensagem| (mensagem.papel, mensagem.texto.as_str())).collect();
            assert_eq!(textos, vec![(MensagemPapel::Usuario, "olá mundo"), (MensagemPapel::Bot, "Você disse: olá mundo")]);
            assert_eq!(sessao.compositor.read(cx).texto(), "", "o campo esvazia depois de enviar");
            assert_eq!(sessao.aviso, None);
        });

        // Desparear volta ao começo, esvazia o cofre, e o servidor passa a recusar o token.
        janela.update(&mut cx, |janela, cx| janela.desparear(cx));
        cx.run_until_parked();
        janela.read_with(&cx, |janela, _| assert!(aberta(janela).is_none()));
        assert_eq!(cofre.valor(), None);
        assert_eq!(Api::new().listar_bots(&guardada.credencial()), Err(ErroApi::NaoAutenticado));

        // De volta ao pareamento, o teclado cai no endereço do servidor.
        cx.simulate_input("bots.exemplo.com");
        janela.read_with(&cx, |janela, cx| {
            let Tela::Pareamento(tela) = &janela.tela else { panic!("devia estar no pareamento") };
            assert_eq!(tela.servidor.read(cx).texto(), "bots.exemplo.com");
        });
    }

    #[gpui::test]
    fn abre_direto_na_conversa_com_a_sessao_que_estava_no_cofre(cx: &mut TestAppContext) {
        cx.executor().allow_parking();
        let servidor = ServidorDeTeste::subir();
        let guardada = parear_pela_api(&servidor, "Computador já pareado");
        Api::new()
            .criar_bot(&guardada.credencial(), &BotEntrada { nome: "Scout".into(), instrucoes: None, modelo: None })
            .expect("bot que já existia");

        let cofre = cofre_com(&guardada);
        let (janela, mut cx) = abrir(&cofre, cx);
        // Antes de qualquer resposta da rede, a tela já é a da conversa.
        janela.read_with(&cx, |janela, _| assert!(aberta(janela).is_some(), "devia abrir sem passar pelo pareamento"));
        esperar(&mut cx, &janela, "bots carregados e fluxo conectado", |janela| {
            conectada(janela) && aberta(janela).is_some_and(|sessao| sessao.bots.len() == 1 && sessao.selecionado.is_some())
        });
        assert_eq!(sessao::carregar(cofre.as_ref()), Some(guardada), "abrir não mexe no cofre");
    }

    #[gpui::test]
    fn cofre_com_lixo_ou_endereco_adulterado_cai_no_pareamento(cx: &mut TestAppContext) {
        let adulterada = r#"{"servidor":"http://bots.exemplo.com","token":"tttttttttttttttttttttttttttttttttttttttttttt","dispositivo":{"id":"abcdefgh12345678","nome":"x","criadoEm":1}}"#;
        for conteudo in ["isto não é uma sessão", "", adulterada] {
            let cofre = Arc::new(CofreEmMemoria::com(conteudo));
            let (janela, cx) = abrir(&cofre, cx);
            janela.read_with(&cx, |janela, _| assert!(aberta(janela).is_none(), "{conteudo:?}"));
        }
    }

    #[gpui::test]
    fn token_revogado_no_servidor_volta_ao_pareamento_e_esvazia_o_cofre(cx: &mut TestAppContext) {
        cx.executor().allow_parking();
        let servidor = ServidorDeTeste::subir();
        let guardada = parear_pela_api(&servidor, "Computador perdido");
        let cofre = cofre_com(&guardada);
        let (janela, mut cx) = abrir(&cofre, cx);
        esperar(&mut cx, &janela, "sessão conectada", conectada);

        // O dono revoga este computador a partir de outro lugar.
        Api::new().revogar_dispositivo(&guardada.credencial()).expect("revogar");
        janela.update(&mut cx, |janela, cx| janela.novo_bot(cx));
        esperar(&mut cx, &janela, "volta ao pareamento", |janela| aberta(janela).is_none());
        janela.read_with(&cx, |janela, _| assert_eq!(aviso_do_pareamento(janela).as_deref(), Some(AVISO_DE_RECUSA)));
        assert_eq!(cofre.valor(), None);
    }

    #[gpui::test]
    fn recusa_que_vem_do_caminho_e_servidor_fora_do_ar_nao_desfazem_o_pareamento(cx: &mut TestAppContext) {
        cx.executor().allow_parking();
        // Um proxy que responde 401 com uma página dele, a tudo.
        let proxy = ServidorFalso::subir(|_, _| RespostaFalsa::html(401));
        // Um endereço onde não há ninguém ouvindo.
        let morto = {
            let escuta = std::net::TcpListener::bind("127.0.0.1:0").expect("porta livre");
            format!("http://127.0.0.1:{}", escuta.local_addr().expect("endereço").port())
        };
        for (caso, endereco) in [("401 de proxy", proxy.base.clone()), ("servidor fora do ar", morto)] {
            let guardada = Sessao {
                servidor: endereco,
                token: "t".repeat(43),
                dispositivo: awikabot_cliente::contrato::Dispositivo {
                    id: "abcdefgh12345678".into(),
                    nome: "Computador".into(),
                    criado_em: 1,
                },
            };
            let cofre = cofre_com(&guardada);
            let (janela, mut cx) = abrir(&cofre, cx);
            esperar(&mut cx, &janela, caso, |janela| aberta(janela).is_some_and(|sessao| sessao.aviso.is_some()));
            janela.read_with(&cx, |janela, _| assert!(aberta(janela).is_some(), "{caso}: a sessão devia continuar"));
            assert_eq!(sessao::carregar(cofre.as_ref()), Some(guardada), "{caso}: o cofre devia continuar com a sessão");
        }
    }

    #[gpui::test]
    fn pareamento_que_nao_pode_ser_guardado_nao_vale_e_o_token_e_revogado(cx: &mut TestAppContext) {
        cx.executor().allow_parking();
        let servidor = ServidorDeTeste::subir();
        let cofre = Arc::new(CofreEmMemoria::default());
        cofre.falhar_ao_gravar(true);
        let (janela, mut cx) = abrir(&cofre, cx);

        cx.simulate_input(&servidor.base);
        cx.simulate_keystrokes("tab");
        cx.simulate_input(&servidor.codigo_de_pareamento());
        cx.simulate_keystrokes("enter");
        esperar(&mut cx, &janela, "aviso de falha ao guardar", |janela| aviso_do_pareamento(janela).is_some());
        janela.read_with(&cx, |janela, _| {
            assert_eq!(
                aviso_do_pareamento(janela).as_deref(),
                Some("Não foi possível guardar o pareamento neste computador. Tente de novo.")
            );
        });

        // O token que o servidor entregou e não pôde ser guardado deixa de valer lá.
        let tentativa = cofre.tentativas_de_gravar().pop().expect("o app tentou guardar a sessão");
        let recusada: Sessao = serde_json_do_teste(&tentativa);
        let limite = Instant::now() + Duration::from_secs(10);
        while Api::new().listar_bots(&recusada.credencial()) != Err(ErroApi::NaoAutenticado) {
            assert!(Instant::now() < limite, "o token que não foi guardado continua valendo no servidor");
            cx.run_until_parked();
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn serde_json_do_teste(texto: &str) -> Sessao {
        sessao::ler_guardada(Some(texto)).expect("o que o app tentou gravar é uma sessão")
    }

    #[gpui::test]
    fn resposta_atrasada_de_uma_sessao_antiga_nao_derruba_a_nova(cx: &mut TestAppContext) {
        cx.executor().allow_parking();
        let servidor = ServidorDeTeste::subir();
        let antiga = parear_pela_api(&servidor, "Sessão antiga");
        let nova = parear_pela_api(&servidor, "Sessão nova");
        let cofre = cofre_com(&nova);
        let (janela, mut cx) = abrir(&cofre, cx);
        esperar(&mut cx, &janela, "sessão nova conectada", conectada);

        // Chega agora a recusa de um pedido feito pela sessão antiga, antes de a pessoa trocar de sessão.
        let valor = janela.update(&mut cx, |janela, cx| janela.conferir::<()>(&antiga.credencial(), Err(ErroApi::NaoAutenticado), cx));
        assert_eq!(valor, None);
        janela.read_with(&cx, |janela, _| {
            assert_eq!(aberta(janela).map(|sessao| &sessao.credencial), Some(&nova.credencial()), "a sessão nova devia continuar");
        });
        assert_eq!(sessao::carregar(cofre.as_ref()), Some(nova.clone()));

        // A mesma recusa, para a sessão que está em uso, desfaz o pareamento.
        janela.update(&mut cx, |janela, cx| janela.conferir::<()>(&nova.credencial(), Err(ErroApi::NaoAutenticado), cx));
        janela.read_with(&cx, |janela, _| assert_eq!(aviso_do_pareamento(janela).as_deref(), Some(AVISO_DE_RECUSA)));
        assert_eq!(cofre.valor(), None);
    }
}
