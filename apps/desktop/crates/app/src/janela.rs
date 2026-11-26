//! A janela do app: a tela de pareamento e a de conversa, com os cartões de aprovação e o
//! formulário de bot.
//!
//! Todo pedido ao servidor roda em segundo plano e volta para cá com a credencial que o fez. O
//! resultado só é usado se essa credencial ainda for a da sessão atual, e só a recusa do token
//! pelo próprio servidor desfaz o pareamento: a mesma regra do app de celular.

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use awikabot_cliente::api::{Api, Credencial, ErroApi};
use awikabot_cliente::aprovacoes::{Aprovacoes, Item, Situacao, intercalar, rotulo_do_desfecho, situacao_do_bot};
use awikabot_cliente::contrato::{
    Aprovacao, AprovacaoEstado, Bot, DecisaoAprovacao, DecisaoAprovacaoDecisao, Evento, Mensagem, MensagemEstado, MensagemPapel,
    PedidoPareamento, PedidoTurno, RespostaPareamento, VERSAO_PROTOCOLO, limites,
};
use awikabot_cliente::conversa::{Conversa, Efeito};
use awikabot_cliente::endereco::normalizar_endereco;
use awikabot_cliente::fluxo::{Conexao, FimDoFluxo, Sinal, seguir};
use awikabot_cliente::formulario_bot::{CamposBot, ErrosBot, campos_do_bot, edicao_do_bot, validar_bot};
use awikabot_cliente::sessao::{self, Cofre, Sessao};
use futures::StreamExt;
use futures::channel::mpsc;
use gpui::{
    AnyWindowHandle, App, Context, ElementId, Entity, FocusHandle, Focusable, KeyBinding, ScrollHandle, SharedString, Subscription,
    SystemNotification, SystemNotificationResponse, Task, Window, WindowHandle, actions, div, prelude::*, px, relative,
};

use crate::atualizador::{Configuracao, PainelDeAtualizacao};
use crate::campo::{CampoDeTexto, Confirmado};
use crate::tema;

actions!(janela, [ProximoCampo, CampoAnterior, Cancelar]);

const CONTEXTO: &str = "Janela";
/// O código tem doze caracteres; a folga é para os hifens e espaços que a pessoa digitar.
const LIMITE_DO_CODIGO: usize = 40;
const LIMITE_DO_ENDERECO: usize = 300;

/// Como o sistema identifica o app: no Windows, é o nome sob o qual os avisos aparecem. O build
/// de desenvolvimento tem identidade própria, para não se misturar com o app instalado.
pub const IDENTIDADE: &str = if cfg!(debug_assertions) { "awikabot.desktop.desenvolvimento" } else { "awikabot.desktop" };
pub const NOME_DO_APP: &str = "awikabot";
/// Começo da etiqueta do aviso do sistema de um pedido de aprovação; o resto é o id do pedido.
const ETIQUETA_DE_APROVACAO: &str = "aprovacao:";

/// Liga as teclas da janela. Chamado uma vez, na partida do app.
pub fn registrar_teclas(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("tab", ProximoCampo, Some(CONTEXTO)),
        KeyBinding::new("shift-tab", CampoAnterior, Some(CONTEXTO)),
        KeyBinding::new("escape", Cancelar, Some(CONTEXTO)),
    ]);
}

/// Diz ao sistema quem é o app. Chamado uma vez, na partida, antes de abrir a janela.
pub fn identificar_o_app(cx: &mut App) {
    cx.set_app_identity(IDENTIDADE, NOME_DO_APP);
}

/// Leva para a janela o clique num aviso do sistema. Chamado uma vez, depois de a janela abrir.
pub fn ligar_avisos(janela: WindowHandle<Janela>, cx: &mut App) {
    cx.on_system_notification_response(move |resposta, cx| {
        // Uma janela que já fechou não tem o que mostrar.
        let _ = janela.update(cx, |janela, window, cx| janela.ao_responder_aviso(&resposta, window, cx));
    });
}

fn etiqueta_do_aviso(aprovacao_id: &str) -> String {
    format!("{ETIQUETA_DE_APROVACAO}{aprovacao_id}")
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

/// O formulário de criar ou editar um bot, aberto no lugar da conversa.
struct Formulario {
    /// O bot em edição; `None` quando é um bot novo.
    bot: Option<Bot>,
    nome: Entity<CampoDeTexto>,
    modelo: Entity<CampoDeTexto>,
    instrucoes: Entity<CampoDeTexto>,
    erros: ErrosBot,
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
    /// Os pedidos de aprovação de todos os bots: os pendentes, os resolvidos nesta execução e os
    /// já resolvidos que vieram com a página de cada conversa.
    aprovacoes: Aprovacoes,
    /// Pedidos cuja decisão já saiu daqui e ainda não voltou do servidor.
    decidindo: HashSet<String>,
    /// O pedido de parar a resposta já saiu e ainda não voltou.
    parando: bool,
    formulario: Option<Formulario>,
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
    /// O último campo que teve o teclado: é para ele que o teclado volta depois de um clique num botão.
    ultimo_campo: Option<FocusHandle>,
    desta_janela: AnyWindowHandle,
    /// A janela está na frente: quem está olhando para ela não precisa de aviso do sistema.
    na_frente: bool,
    /// Pedidos de aprovação com aviso do sistema ainda à mostra.
    avisados: HashSet<String>,
    /// O aviso de versão nova. Não existe onde não há pacote para baixar.
    atualizacao: Option<Entity<PainelDeAtualizacao>>,
    /// O painel de detalhes, à direita da conversa, está aberto. Só aparece se a janela couber.
    detalhes_abertos: bool,
    _observadores: [Subscription; 2],
}

fn mensagem_do_erro(erro: &ErroApi) -> SharedString {
    let do_servidor = |codigo: &str| -> Option<&'static str> {
        Some(match codigo {
            "codigo_invalido" => "Código inválido ou vencido. Gere outro no servidor.",
            "muitas_tentativas" => "Muitas tentativas erradas. O servidor bloqueou o pareamento por alguns minutos.",
            "turno_em_andamento" => "O bot ainda está respondendo.",
            "limite_de_turnos" => "O servidor já está com o máximo de respostas em andamento.",
            "nao_encontrado" => "Este bot não existe mais no servidor.",
            "dados_invalidos" => "O servidor não aceitou os dados enviados.",
            _ => return None,
        })
    };
    match erro {
        ErroApi::Servidor { codigo, .. } => match do_servidor(codigo) {
            Some(mensagem) => mensagem.into(),
            None => format!("Não deu certo: {erro}.").into(),
        },
        ErroApi::Rede(_) => "Sem resposta do servidor. Confira o endereço e a rede.".into(),
        outro => format!("Não deu certo: {outro}.").into(),
    }
}

fn nome_padrao_do_aparelho() -> String {
    // O nome que a pessoa vê na lista de aparelhos do servidor; ela pode trocar antes de parear.
    std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "Computador".to_owned())
}

fn tema_para(window: &Window) -> tema::Tema {
    tema::fixado_para_a_prova().unwrap_or_else(|| tema::da_aparencia(window.appearance()))
}

impl Janela {
    pub fn new(cofre: Arc<dyn Cofre>, atualizacao: Option<Configuracao>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        tema::usar(tema_para(window));
        let observadores = [
            // O tema acompanha o do sistema, inclusive quando a pessoa o troca com o app aberto.
            cx.observe_window_appearance(window, |_, window, _| {
                tema::usar(tema_para(window));
                window.refresh();
            }),
            cx.observe_window_activation(window, |janela: &mut Self, window, cx| janela.ao_mudar_de_plano(window.is_window_active(), cx)),
        ];
        let pareamento = Self::tela_de_pareamento(None, cx);
        window.focus(&pareamento.servidor.focus_handle(cx), cx);
        let mut janela = Self {
            api: Api::new(),
            cofre,
            tela: Tela::Pareamento(pareamento),
            foco: cx.focus_handle(),
            foco_pendente: None,
            ultimo_campo: None,
            desta_janela: window.window_handle(),
            na_frente: window.is_window_active(),
            avisados: HashSet::new(),
            atualizacao: atualizacao.map(|configuracao| cx.new(|cx| PainelDeAtualizacao::new(configuracao, cx))),
            detalhes_abertos: true,
            _observadores: observadores,
        };
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
        // Enter envia; Shift+Enter quebra a linha. O campo cresce com o texto até seis linhas.
        let compositor = cx.new(|cx| CampoDeTexto::area("Escreva para o bot", limites::TEXTO, (1, 6), true, cx).sem_moldura());
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
            aprovacoes: Aprovacoes::default(),
            decidindo: HashSet::new(),
            parando: false,
            formulario: None,
            compositor,
            conexao: None,
            aviso: iniciada.is_err().then(|| "Não foi possível acompanhar o servidor em tempo real.".into()),
            rolagem: ScrollHandle::new(),
            _assinatura: assinatura,
            _fluxo: FluxoAtivo { parar, _escuta: escuta },
        }));
        self.carregar_bots(&credencial, cx);
        self.carregar_aprovacoes(&credencial, cx);
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
        // Os avisos do sistema eram da sessão que acabou.
        for aprovacao_id in std::mem::take(&mut self.avisados) {
            cx.dismiss_system_notification(&etiqueta_do_aviso(&aprovacao_id));
        }
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
            sessao.parando = false;
        }
        cx.notify();
        self.carregar_mensagens(credencial, bot_id, cx);
    }

    /// O clique num bot da lista: troca de conversa e fecha o formulário, se estava aberto.
    fn escolher_na_lista(&mut self, credencial: &Credencial, bot_id: String, cx: &mut Context<Self>) {
        if self.sessao_de(credencial).is_some_and(|sessao| sessao.formulario.is_some()) {
            self.fechar_formulario(cx);
        }
        self.selecionar(credencial, bot_id, cx);
    }

    fn carregar_mensagens(&mut self, credencial: &Credencial, bot_id: String, cx: &mut Context<Self>) {
        let (do_pedido, da_resposta, do_bot) = (credencial.clone(), credencial.clone(), bot_id.clone());
        self.em_segundo_plano(
            cx,
            move |api| api.listar_mensagens(&do_pedido, &bot_id),
            move |janela, resposta, cx| {
                let Some(pagina) = janela.conferir(&da_resposta, resposta, cx) else { return };
                let Some(sessao) = janela.sessao_de(&da_resposta) else { return };
                // Os pedidos já resolvidos da página valem seja qual for a conversa aberta agora. Um
                // servidor anterior a esse campo não o manda.
                sessao.aprovacoes.aplicar_resolvidas(pagina.aprovacoes.unwrap_or_default());
                // A resposta de um bot que a pessoa já deixou de olhar não entra na conversa do outro.
                if sessao.selecionado.as_deref() == Some(do_bot.as_str()) {
                    sessao.conversa.trocar(pagina.mensagens);
                    sessao.rolagem.scroll_to_bottom();
                    cx.notify();
                }
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
                marcar_turno(&mut sessao.bots, &do_bot, true);
                if sessao.selecionado.as_deref() == Some(do_bot.as_str()) {
                    sessao.conversa.registrar_turno(turno);
                    sessao.rolagem.scroll_to_bottom();
                }
                cx.notify();
            },
        );
    }

    /// Para a resposta em andamento do bot selecionado.
    fn parar(&mut self, cx: &mut Context<Self>) {
        let Tela::Sessao(sessao) = &mut self.tela else { return };
        let Some(bot_id) = sessao.selecionado.clone() else { return };
        if sessao.parando {
            return;
        }
        sessao.parando = true;
        sessao.aviso = None;
        cx.notify();
        let credencial = sessao.credencial.clone();
        let (do_pedido, da_resposta, do_bot) = (credencial.clone(), credencial, bot_id.clone());
        self.em_segundo_plano(
            cx,
            move |api| api.parar_turno(&do_pedido, &bot_id),
            move |janela, resposta, cx| {
                if let Some(sessao) = janela.sessao_de(&da_resposta)
                    && sessao.selecionado.as_deref() == Some(do_bot.as_str())
                {
                    sessao.parando = false;
                }
                // A resposta terminou sozinha antes de o pedido chegar: não há o que avisar.
                let ja_tinha_terminado = matches!(&resposta, Err(ErroApi::Servidor { codigo, .. }) if codigo == "sem_turno_ativo");
                if !ja_tinha_terminado {
                    janela.conferir(&da_resposta, resposta, cx);
                }
                cx.notify();
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

    // --- Aprovações ---------------------------------------------------------------

    /// Busca os pedidos pendentes. Se um evento de aprovação chegar durante a busca, a lista pode
    /// ser mais velha que ele: ela só acrescenta o que faltava, e a busca é refeita.
    fn carregar_aprovacoes(&mut self, credencial: &Credencial, cx: &mut Context<Self>) {
        let Some(sessao) = self.sessao_de(credencial) else { return };
        let revisao = sessao.aprovacoes.revisao();
        let (do_pedido, da_resposta) = (credencial.clone(), credencial.clone());
        self.em_segundo_plano(
            cx,
            move |api| api.listar_aprovacoes(&do_pedido),
            move |janela, resposta, cx| {
                let Some(lista) = janela.conferir(&da_resposta, resposta, cx) else { return };
                let Some(sessao) = janela.sessao_de(&da_resposta) else { return };
                let em_dia = sessao.aprovacoes.aplicar_pendentes(lista.aprovacoes, revisao);
                cx.notify();
                if !em_dia {
                    janela.carregar_aprovacoes(&da_resposta, cx);
                }
            },
        );
    }

    /// Aprova ou nega um pedido. A decisão só vale quando o servidor responde.
    fn decidir(&mut self, aprovacao_id: String, decisao: DecisaoAprovacaoDecisao, cx: &mut Context<Self>) {
        let Tela::Sessao(sessao) = &mut self.tela else { return };
        if !sessao.decidindo.insert(aprovacao_id.clone()) {
            return;
        }
        sessao.aviso = None;
        cx.notify();
        let credencial = sessao.credencial.clone();
        let (do_pedido, da_resposta, do_pedido_de_aprovacao) = (credencial.clone(), credencial, aprovacao_id.clone());
        self.em_segundo_plano(
            cx,
            move |api| api.decidir_aprovacao(&do_pedido, &do_pedido_de_aprovacao, &DecisaoAprovacao { decisao }),
            move |janela, resposta, cx| {
                let Some(sessao) = janela.sessao_de(&da_resposta) else { return };
                sessao.decidindo.remove(&aprovacao_id);
                cx.notify();
                if matches!(&resposta, Err(ErroApi::Servidor { codigo, .. }) if codigo == "ja_resolvida" || codigo == "nao_encontrado") {
                    // Outro aparelho decidiu antes, ou o pedido expirou: a lista do servidor diz o que ainda espera.
                    sessao.aviso = Some("Este pedido já tinha sido resolvido.".into());
                    janela.carregar_aprovacoes(&da_resposta, cx);
                    return;
                }
                let Some(resolvida) = janela.conferir(&da_resposta, resposta, cx) else { return };
                janela.recolher_aviso(&resolvida.id, cx);
                if let Some(sessao) = janela.sessao_de(&da_resposta) {
                    sessao.aprovacoes.aplicar_decisao(resolvida);
                }
            },
        );
    }

    /// Avisa pelo sistema que um bot parou à espera da pessoa. Quem está com a janela na frente
    /// já vê o cartão ou a marca na lista de bots. O aviso não leva o conteúdo do pedido, que
    /// pode ter dado sensível e apareceria na tela de bloqueio: a decisão é no cartão.
    fn avisar_pedido(&mut self, aprovacao: &Aprovacao, cx: &mut Context<Self>) {
        if self.na_frente || aprovacao.estado != AprovacaoEstado::Pendente {
            return;
        }
        let Tela::Sessao(sessao) = &self.tela else { return };
        if sessao.aprovacoes.obter(&aprovacao.id).is_none_or(|guardada| guardada.estado != AprovacaoEstado::Pendente) {
            return;
        }
        let bot = sessao.bots.iter().find(|bot| bot.id == aprovacao.bot_id).map_or("Um bot", |bot| bot.nome.as_str());
        cx.show_system_notification(SystemNotification {
            tag: etiqueta_do_aviso(&aprovacao.id).into(),
            title: format!("{bot} pede aprovação").into(),
            body: format!("Quer usar {}. Abra o awikabot para ver o pedido e decidir.", aprovacao.ferramenta).into(),
            actions: Vec::new(),
        });
        self.avisados.insert(aprovacao.id.clone());
        let desta_janela = self.desta_janela;
        cx.defer(move |cx| {
            let _ = desta_janela.update(cx, |_, window, _| window.request_attention());
        });
    }

    fn recolher_aviso(&mut self, aprovacao_id: &str, cx: &mut Context<Self>) {
        if self.avisados.remove(aprovacao_id) {
            cx.dismiss_system_notification(&etiqueta_do_aviso(aprovacao_id));
        }
    }

    fn ao_mudar_de_plano(&mut self, na_frente: bool, cx: &mut Context<Self>) {
        self.na_frente = na_frente;
        if na_frente {
            // De volta ao app, os avisos já cumpriram o papel.
            for aprovacao_id in std::mem::take(&mut self.avisados) {
                cx.dismiss_system_notification(&etiqueta_do_aviso(&aprovacao_id));
            }
        }
    }

    /// A pessoa clicou num aviso do sistema: a janela vem para a frente, na conversa do pedido.
    fn ao_responder_aviso(&mut self, resposta: &SystemNotificationResponse, window: &mut Window, cx: &mut Context<Self>) {
        let Some(aprovacao_id) = resposta.tag.strip_prefix(ETIQUETA_DE_APROVACAO) else { return };
        window.activate_window();
        cx.activate(true);
        self.avisados.remove(aprovacao_id);
        let Tela::Sessao(sessao) = &self.tela else { return };
        let Some(bot_id) = sessao.aprovacoes.obter(aprovacao_id).map(|aprovacao| aprovacao.bot_id.clone()) else { return };
        let credencial = sessao.credencial.clone();
        self.selecionar(&credencial, bot_id, cx);
    }

    // --- Formulário de bot --------------------------------------------------------

    /// Abre o formulário no lugar da conversa: vazio para um bot novo, ou com os dados do bot.
    fn abrir_formulario(&mut self, bot: Option<Bot>, cx: &mut Context<Self>) {
        let Tela::Sessao(_) = &self.tela else { return };
        let campos = bot.as_ref().map(campos_do_bot).unwrap_or_default();
        let nome = cx.new(|cx| {
            let mut campo = CampoDeTexto::new("Como o bot aparece na lista", limites::NOME_BOT, cx);
            campo.definir(&campos.nome, cx);
            campo
        });
        let modelo = cx.new(|cx| {
            let mut campo = CampoDeTexto::new("Padrão do motor", limites::MODELO, cx);
            campo.definir(&campos.modelo, cx);
            campo
        });
        // Nas instruções, Enter quebra a linha: o que salva é o botão, ou Enter nos outros campos.
        let instrucoes = cx.new(|cx| {
            let mut campo = CampoDeTexto::area("O que este bot precisa saber e como deve agir", limites::INSTRUCOES, (6, 14), false, cx);
            campo.definir(&campos.instrucoes, cx);
            campo
        });
        let assinaturas =
            [&nome, &modelo].map(|campo| cx.subscribe(campo, |janela: &mut Self, _, _: &Confirmado, cx| janela.salvar_bot(cx))).into();
        self.foco_pendente = Some(nome.focus_handle(cx));
        let Tela::Sessao(sessao) = &mut self.tela else { return };
        sessao.formulario = Some(Formulario {
            bot,
            nome,
            modelo,
            instrucoes,
            erros: ErrosBot::default(),
            ocupado: false,
            aviso: None,
            _assinaturas: assinaturas,
        });
        cx.notify();
    }

    fn editar_selecionado(&mut self, cx: &mut Context<Self>) {
        let Tela::Sessao(sessao) = &self.tela else { return };
        let bot = sessao.selecionado.as_ref().and_then(|id| sessao.bots.iter().find(|bot| &bot.id == id)).cloned();
        if bot.is_some() {
            self.abrir_formulario(bot, cx);
        }
    }

    fn fechar_formulario(&mut self, cx: &mut Context<Self>) {
        let Tela::Sessao(sessao) = &mut self.tela else { return };
        if sessao.formulario.take().is_some() {
            self.foco_pendente = Some(sessao.compositor.focus_handle(cx));
            cx.notify();
        }
    }

    fn salvar_bot(&mut self, cx: &mut Context<Self>) {
        let Tela::Sessao(sessao) = &mut self.tela else { return };
        let Some(formulario) = &mut sessao.formulario else { return };
        if formulario.ocupado {
            return;
        }
        let campos = CamposBot {
            nome: formulario.nome.read(cx).texto().to_owned(),
            instrucoes: formulario.instrucoes.read(cx).texto().to_owned(),
            modelo: formulario.modelo.read(cx).texto().to_owned(),
        };
        formulario.aviso = None;
        let entrada = match validar_bot(&campos) {
            Ok(entrada) => entrada,
            Err(erros) => {
                // O teclado vai para o primeiro campo a corrigir.
                let a_corrigir = if erros.nome.is_some() {
                    &formulario.nome
                } else if erros.modelo.is_some() {
                    &formulario.modelo
                } else {
                    &formulario.instrucoes
                };
                self.foco_pendente = Some(a_corrigir.focus_handle(cx));
                formulario.erros = erros;
                cx.notify();
                return;
            }
        };
        formulario.erros = ErrosBot::default();
        let credencial = sessao.credencial.clone();
        let (do_pedido, da_resposta) = (credencial.clone(), credencial);
        let depois = move |janela: &mut Self, resposta: Result<Bot, ErroApi>, cx: &mut Context<Self>| {
            janela.ao_salvar_bot(&da_resposta, resposta, cx)
        };
        match &formulario.bot {
            None => {
                formulario.ocupado = true;
                self.em_segundo_plano(cx, move |api| api.criar_bot(&do_pedido, &entrada), depois);
            }
            Some(bot) => match edicao_do_bot(bot, &entrada) {
                // Nada mudou: salvar é só fechar.
                None => self.fechar_formulario(cx),
                Some(edicao) => {
                    formulario.ocupado = true;
                    let bot_id = bot.id.clone();
                    self.em_segundo_plano(cx, move |api| api.editar_bot(&do_pedido, &bot_id, &edicao), depois);
                }
            },
        }
        cx.notify();
    }

    fn ao_salvar_bot(&mut self, credencial: &Credencial, resposta: Result<Bot, ErroApi>, cx: &mut Context<Self>) {
        let Some(sessao) = self.sessao_de(credencial) else { return };
        match resposta {
            Ok(bot) => {
                let id = bot.id.clone();
                guardar_bot(&mut sessao.bots, bot);
                self.fechar_formulario(cx);
                self.selecionar(credencial, id, cx);
            }
            // A recusa do token segue o caminho de todos os pedidos: desfaz o pareamento.
            Err(ErroApi::NaoAutenticado) => {
                self.conferir::<Bot>(credencial, Err(ErroApi::NaoAutenticado), cx);
            }
            // Os outros erros ficam no formulário, com o que a pessoa digitou.
            Err(erro) => {
                if let Some(formulario) = &mut sessao.formulario {
                    formulario.ocupado = false;
                    formulario.aviso = Some(mensagem_do_erro(&erro));
                }
                cx.notify();
            }
        }
    }

    // --- Fluxo de eventos ---------------------------------------------------------

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
                match &evento {
                    Evento::BotSalvo { bot } => guardar_bot(&mut sessao.bots, bot.clone()),
                    Evento::TurnoIniciado { bot_id, .. } => marcar_turno(&mut sessao.bots, bot_id, true),
                    Evento::TurnoTerminado { bot_id, .. } => {
                        marcar_turno(&mut sessao.bots, bot_id, false);
                        if sessao.selecionado.as_deref() == Some(bot_id.as_str()) {
                            sessao.parando = false;
                        }
                    }
                    Evento::AprovacaoPedida { aprovacao } | Evento::AprovacaoResolvida { aprovacao } => {
                        sessao.aprovacoes.aplicar_evento(aprovacao.clone());
                    }
                    Evento::Texto { .. } | Evento::Ressincronizar => {}
                }
                let recarregar = match sessao.selecionado.clone() {
                    Some(bot_id) => (sessao.conversa.aplicar(&bot_id, &evento) == Efeito::Recarregar).then_some(bot_id),
                    None => None,
                };
                sessao.rolagem.scroll_to_bottom();
                cx.notify();
                match &evento {
                    Evento::AprovacaoPedida { aprovacao } => self.avisar_pedido(aprovacao, cx),
                    Evento::AprovacaoResolvida { aprovacao } => self.recolher_aviso(&aprovacao.id, cx),
                    _ => {}
                }
                if evento == Evento::Ressincronizar {
                    // O servidor avisou que este aparelho perdeu eventos: tudo é buscado de novo.
                    self.carregar_bots(credencial, cx);
                    self.carregar_aprovacoes(credencial, cx);
                } else if let Some(bot_id) = recarregar {
                    self.carregar_mensagens(credencial, bot_id, cx);
                }
            }
        }
    }

    // --- Teclado ------------------------------------------------------------------

    /// Os campos da tela, na ordem em que o Tab passa por eles.
    fn campos_em_ordem(&self, cx: &App) -> Vec<FocusHandle> {
        let campos: Vec<&Entity<CampoDeTexto>> = match &self.tela {
            Tela::Pareamento(tela) => vec![&tela.servidor, &tela.codigo, &tela.nome],
            Tela::Sessao(sessao) => match &sessao.formulario {
                Some(formulario) => vec![&formulario.nome, &formulario.modelo, &formulario.instrucoes],
                None => vec![&sessao.compositor],
            },
        };
        campos.into_iter().map(|campo| campo.focus_handle(cx)).collect()
    }

    fn andar_entre_campos(&mut self, para_frente: bool, window: &mut Window, cx: &mut Context<Self>) {
        let campos = self.campos_em_ordem(cx);
        let quantos = campos.len();
        let proximo = match campos.iter().position(|campo| campo.is_focused(window)) {
            Some(atual) if para_frente => (atual + 1) % quantos,
            Some(atual) => (atual + quantos - 1) % quantos,
            None => 0,
        };
        window.focus(&campos[proximo], cx);
    }

    fn proximo_campo(&mut self, _: &ProximoCampo, window: &mut Window, cx: &mut Context<Self>) {
        self.andar_entre_campos(true, window, cx);
    }

    fn campo_anterior(&mut self, _: &CampoAnterior, window: &mut Window, cx: &mut Context<Self>) {
        self.andar_entre_campos(false, window, cx);
    }

    fn cancelar(&mut self, _: &Cancelar, _: &mut Window, cx: &mut Context<Self>) {
        self.fechar_formulario(cx);
    }
}

fn guardar_bot(bots: &mut Vec<Bot>, bot: Bot) {
    match bots.iter_mut().find(|atual| atual.id == bot.id) {
        Some(atual) => *atual = bot,
        None => bots.push(bot),
    }
}

/// O começo e o fim de uma resposta mudam o que a lista de bots diz, sem esperar uma nova busca.
fn marcar_turno(bots: &mut [Bot], bot_id: &str, ativo: bool) {
    if let Some(bot) = bots.iter_mut().find(|bot| bot.id == bot_id) {
        bot.turno_ativo = ativo;
    }
}

/// O bot ainda está respondendo: é quando o botão de enviar dá lugar ao de parar.
fn respondendo(bot: &Bot, conversa: &Conversa) -> bool {
    bot.turno_ativo || conversa.mensagens.last().is_some_and(|ultima| ultima.estado == MensagemEstado::EmAndamento)
}

// --- Desenho ------------------------------------------------------------------

pub(crate) fn botao(id: impl Into<ElementId>, rotulo: impl Into<SharedString>, principal: bool) -> gpui::Stateful<gpui::Div> {
    let base = div().id(id).h(px(30.)).px_3().flex().items_center().justify_center().rounded_md().cursor_pointer().child(rotulo.into());
    if principal {
        base.bg(tema::destaque()).text_color(tema::texto_no_destaque()).font_weight(gpui::FontWeight::SEMIBOLD)
    } else {
        base.bg(tema::elevado()).border_1().border_color(tema::borda_de_controle()).hover(|estilo| estilo.bg(tema::sob_o_mouse()))
    }
}

/// Uma ação discreta, do tamanho de uma linha da lateral: sem fundo até o mouse passar.
fn linha_de_acao(id: impl Into<ElementId>, rotulo: impl Into<SharedString>) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .px_2()
        .py_1p5()
        .rounded_md()
        .cursor_pointer()
        .text_color(tema::texto())
        .hover(|estilo| estilo.bg(tema::sob_o_mouse()))
        .child(rotulo.into())
}

fn rotulo_do_campo(texto: &'static str) -> gpui::Div {
    div().text_size(px(tema::TAMANHO_PEQUENO)).text_color(tema::texto_secundario()).child(texto)
}

pub(crate) fn texto_pequeno(texto: impl Into<SharedString>, cor: gpui::Rgba) -> gpui::Div {
    div().text_size(px(tema::TAMANHO_PEQUENO)).text_color(cor).child(texto.into())
}

/// Um campo do formulário: rótulo, o campo, uma explicação e o erro de validação, se houver.
fn campo_do_formulario(
    rotulo: &'static str,
    campo: &Entity<CampoDeTexto>,
    explicacao: Option<&'static str>,
    erro: Option<&String>,
) -> gpui::Div {
    div()
        .flex()
        .flex_col()
        .gap_1()
        .child(rotulo_do_campo(rotulo))
        .child(campo.clone())
        .children(explicacao.map(|texto| texto_pequeno(texto, tema::texto_apagado())))
        .children(erro.map(|texto| texto_pequeno(texto.clone(), tema::estado_de_erro())))
}

fn rotulo_do_estado(mensagem: &Mensagem) -> Option<(&'static str, gpui::Rgba)> {
    match mensagem.estado {
        MensagemEstado::Completa => None,
        MensagemEstado::EmAndamento => Some(("Respondendo…", tema::texto_secundario())),
        MensagemEstado::Parada => Some(("Resposta interrompida", tema::estado_de_aviso())),
        MensagemEstado::Falhou => Some(("A resposta falhou", tema::estado_de_erro())),
    }
}

fn cor_do_desfecho(estado: AprovacaoEstado) -> gpui::Rgba {
    match estado {
        AprovacaoEstado::Aprovada => tema::estado_ok(),
        AprovacaoEstado::Negada => tema::estado_de_erro(),
        AprovacaoEstado::Expirada | AprovacaoEstado::Pendente => tema::estado_de_aviso(),
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
                .child(div().text_size(px(22.)).text_color(tema::texto_forte()).font_weight(gpui::FontWeight::SEMIBOLD).child(NOME_DO_APP))
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
                .child(texto_pequeno(format!("Protocolo {VERSAO_PROTOCOLO}"), tema::texto_apagado()))
                .children(self.atualizacao.clone()),
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
            // Bot parado à espera da pessoa vem antes de "respondendo": é o que ela precisa saber.
            let situacao = situacao_do_bot(bot, &sessao.aprovacoes).map(|situacao| {
                let cor = match situacao {
                    Situacao::AguardandoAprovacao => tema::estado_de_aviso(),
                    Situacao::Respondendo => tema::texto_secundario(),
                };
                texto_pequeno(situacao.rotulo(), cor).flex_none()
            });
            div()
                .id(("bot", indice))
                .mx_2()
                .px_2()
                .py_1p5()
                .rounded_md()
                .flex()
                .items_center()
                .gap_2()
                .cursor_pointer()
                .when(escolhido, |linha| linha.bg(tema::selecionado()).text_color(tema::texto_forte()))
                .when(!escolhido, |linha| linha.hover(|estilo| estilo.bg(tema::sob_o_mouse())))
                .child(div().flex_1().min_w_0().truncate().child(bot.nome.clone()))
                .children(situacao)
                .on_click(cx.listener(move |janela, _, _, cx| janela.escolher_na_lista(&credencial, id.clone(), cx)))
        });

        // A ação principal no alto, a lista no meio, e no pé o que é da conexão com o servidor.
        div()
            .w(px(tema::LARGURA_DA_LATERAL))
            .flex_none()
            .h_full()
            .flex()
            .flex_col()
            .bg(tema::painel())
            .border_r_1()
            .border_color(tema::divisoria())
            .child(
                div().p_2().child(
                    botao("novo-bot", "+  Novo bot", false)
                        .w_full()
                        .justify_start()
                        .debug_selector(|| "novo-bot".into())
                        .on_click(cx.listener(|janela, _, _, cx| janela.abrir_formulario(None, cx))),
                ),
            )
            .child(div().px_4().pt_2().pb_1().child(texto_pequeno("Bots", tema::texto_secundario())))
            .child(div().id("lista-de-bots").flex_1().min_h_0().overflow_y_scroll().pb_1().flex().flex_col().gap_0p5().children(bots))
            .child(
                div()
                    .p_2()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .children(self.atualizacao.clone().map(|painel| div().px_2().pb_1().child(painel)))
                    .child(
                        div()
                            .px_2()
                            .py_1()
                            .flex()
                            .items_center()
                            .gap_2()
                            .child(div().size(px(7.)).flex_none().rounded_full().bg(cor))
                            .child(texto_pequeno(estado, tema::texto_secundario())),
                    )
                    .child(
                        linha_de_acao("desparear", "Desparear")
                            .debug_selector(|| "desparear".into())
                            .on_click(cx.listener(|janela, _, _, cx| janela.desparear(cx))),
                    ),
            )
    }

    fn desenhar_mensagem(mensagem: &Mensagem, nome_do_bot: &str) -> gpui::Div {
        let estado = rotulo_do_estado(mensagem).map(|(texto, cor)| texto_pequeno(texto, cor));
        let texto = (!mensagem.texto.is_empty())
            .then(|| div().min_w_0().whitespace_normal().text_color(tema::texto()).child(mensagem.texto.clone()));
        // O que a pessoa escreveu fica num balão à direita; a resposta do bot, solta na coluna.
        if mensagem.papel == MensagemPapel::Usuario {
            return div().w_full().min_w_0().flex_none().flex().flex_col().items_end().gap_1().child(
                div()
                    .max_w(relative(0.8))
                    .min_w_0()
                    .px_3()
                    .py_2()
                    .rounded_xl()
                    .bg(tema::elevado())
                    .border_1()
                    .border_color(tema::divisoria())
                    .children(texto)
                    .children(estado),
            );
        }
        div()
            .w_full()
            .min_w_0()
            .flex_none()
            .flex()
            .flex_col()
            .gap_1()
            .py_1()
            .child(texto_pequeno(nome_do_bot.to_owned(), tema::texto_secundario()))
            .children(texto.map(|texto| texto.w_full()))
            .children(estado)
    }

    /// O cartão de um pedido de aprovação. Enquanto pendente, mostra o pedido inteiro e os dois
    /// botões: é o que está escrito aqui que a pessoa aprova. Depois de resolvido, vira uma linha.
    fn desenhar_aprovacao(&self, sessao: &SessaoAberta, aprovacao: &Aprovacao, indice: usize, cx: &mut Context<Self>) -> gpui::Div {
        if let Some(desfecho) = rotulo_do_desfecho(aprovacao.estado) {
            return div()
                .w_full()
                .min_w_0()
                .flex_none()
                .flex()
                .items_center()
                .gap_2()
                .debug_selector(|| "pedido-resolvido".into())
                .child(texto_pequeno(desfecho, cor_do_desfecho(aprovacao.estado)).flex_none())
                .child(texto_pequeno(aprovacao.ferramenta.clone(), tema::texto_secundario()).flex_none())
                .child(texto_pequeno(aprovacao.resumo.clone(), tema::texto_apagado()).flex_1().min_w_0().truncate());
        }

        let enviando = sessao.decidindo.contains(&aprovacao.id);
        let botoes =
            if enviando {
                div().child(texto_pequeno("Enviando a decisão…", tema::texto_secundario()))
            } else {
                let (para_aprovar, para_negar) = (aprovacao.id.clone(), aprovacao.id.clone());
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(botao(("aprovar", indice), "Aprovar", true).debug_selector(|| "aprovar".into()).on_click(
                        cx.listener(move |janela, _, _, cx| janela.decidir(para_aprovar.clone(), DecisaoAprovacaoDecisao::Aprovar, cx)),
                    ))
                    .child(botao(("negar", indice), "Negar", false).debug_selector(|| "negar".into()).on_click(
                        cx.listener(move |janela, _, _, cx| janela.decidir(para_negar.clone(), DecisaoAprovacaoDecisao::Negar, cx)),
                    ))
            };
        div()
            .w_full()
            .min_w_0()
            .flex_none()
            .flex()
            .flex_col()
            .gap_2()
            .p_3()
            .rounded_lg()
            .bg(tema::elevado())
            .border_1()
            .border_color(tema::estado_de_aviso())
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(div().text_color(tema::texto_forte()).font_weight(gpui::FontWeight::SEMIBOLD).child("Pedido de aprovação"))
                    .child(texto_pequeno(aprovacao.ferramenta.clone(), tema::texto_secundario())),
            )
            // O pedido inteiro, com as quebras de linha dele; um pedido longo rola dentro do cartão.
            .child(
                div()
                    .id(("resumo", indice))
                    .w_full()
                    .min_w_0()
                    .max_h(px(240.))
                    .overflow_y_scroll()
                    .whitespace_normal()
                    .text_color(tema::texto())
                    .child(aprovacao.resumo.clone()),
            )
            .child(botoes)
            .child(texto_pequeno("Sem resposta, o pedido expira e a ação não roda.", tema::texto_apagado()))
    }

    fn desenhar_conversa(
        &self,
        sessao: &SessaoAberta,
        compositor_com_o_teclado: bool,
        cabem_detalhes: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
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

        let do_bot = sessao.aprovacoes.do_bot(&bot.id);
        let itens = intercalar(&sessao.conversa.mensagens, &do_bot);
        let itens = itens.iter().enumerate().map(|(indice, item)| match item {
            Item::Mensagem(mensagem) => Self::desenhar_mensagem(mensagem, &bot.nome),
            Item::Aprovacao(aprovacao) => self.desenhar_aprovacao(sessao, aprovacao, indice, cx),
        });
        let itens: Vec<gpui::Div> = itens.collect();
        let aviso = sessao.aviso.clone().map(|texto| div().px_1().text_color(tema::estado_de_aviso()).child(texto));
        let acao = if respondendo(bot, &sessao.conversa) {
            botao("parar", if sessao.parando { "Parando…" } else { "Parar" }, false)
                .debug_selector(|| "parar".into())
                .on_click(cx.listener(|janela, _, _, cx| janela.parar(cx)))
        } else {
            botao("enviar", "Enviar", true).debug_selector(|| "enviar".into()).on_click(cx.listener(|janela, _, _, cx| janela.enviar(cx)))
        };
        let borda_do_compositor = if compositor_com_o_teclado { tema::destaque() } else { tema::borda_de_controle() };

        // A conversa e o compositor ficam numa coluna de largura limitada, no meio da área central;
        // a rolagem é da área inteira, para a barra ficar na borda da janela.
        // Sem largura mínima zero, um texto longo empurra a coluna para fora da janela em vez de quebrar.
        let coluna = || div().w_full().max_w(px(tema::LARGURA_DA_CONVERSA)).min_w_0().px_4();
        div()
            .flex_1()
            .min_w_0()
            .h_full()
            .flex()
            .flex_col()
            .child(
                div()
                    .px_4()
                    .py_2()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_color(tema::texto_forte())
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .child(bot.nome.clone()),
                    )
                    .child(
                        botao("editar-bot", "Editar", false)
                            .debug_selector(|| "editar-bot".into())
                            .on_click(cx.listener(|janela, _, _, cx| janela.editar_selecionado(cx))),
                    )
                    // Numa janela estreita o painel não cabe, e o botão some junto.
                    .when(cabem_detalhes, |cabecalho| {
                        cabecalho.child(
                            botao("alternar-detalhes", if self.detalhes_abertos { "Ocultar detalhes" } else { "Detalhes" }, false)
                                .debug_selector(|| "alternar-detalhes".into())
                                .on_click(cx.listener(|janela, _, _, cx| {
                                    janela.detalhes_abertos = !janela.detalhes_abertos;
                                    cx.notify();
                                })),
                        )
                    }),
            )
            .child(
                div()
                    .id("mensagens")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .track_scroll(&sessao.rolagem)
                    .flex()
                    .flex_col()
                    .items_center()
                    .child(coluna().py_4().flex().flex_col().gap_3().children(itens)),
            )
            .child(
                div().w_full().flex().justify_center().pb_4().child(
                    coluna().flex().flex_col().gap_2().children(aviso).child(
                        div()
                            .w_full()
                            .min_w_0()
                            .p_2()
                            .flex()
                            .flex_col()
                            .gap_2()
                            .rounded_xl()
                            .bg(tema::elevado())
                            .border_1()
                            .border_color(borda_do_compositor)
                            .child(div().w_full().min_w_0().child(sessao.compositor.clone()))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap_2()
                                    .child(
                                        texto_pequeno("Enter envia · Shift+Enter quebra a linha", tema::texto_apagado())
                                            .flex_1()
                                            .min_w_0()
                                            .truncate()
                                            .pl_2(),
                                    )
                                    .child(acao.flex_none().rounded_full()),
                            ),
                    ),
                ),
            )
    }

    /// O painel à direita da conversa: o bot aberto e os pedidos que esperam a pessoa, de todos
    /// os bots. O pedido aqui só leva à conversa dele; aprovar e negar ficam no cartão, que mostra
    /// o pedido inteiro.
    fn desenhar_detalhes(&self, sessao: &SessaoAberta, cx: &mut Context<Self>) -> gpui::Div {
        let secao = |titulo: &'static str| div().flex().flex_col().gap_2().child(texto_pequeno(titulo, tema::texto_secundario()));
        let item = |rotulo: &'static str, valor: gpui::Div| div().flex().flex_col().gap_0p5().child(rotulo_do_campo(rotulo)).child(valor);

        let bot = sessao.selecionado.as_ref().and_then(|id| sessao.bots.iter().find(|bot| &bot.id == id));
        let do_bot = bot.map(|bot| {
            let situacao = situacao_do_bot(bot, &sessao.aprovacoes).map_or("parado", Situacao::rotulo);
            let modelo = match &bot.modelo {
                Some(modelo) => div().min_w_0().truncate().child(modelo.clone()),
                None => div().text_color(tema::texto_apagado()).child("Padrão do motor"),
            };
            let instrucoes = if bot.instrucoes.is_empty() {
                div().text_color(tema::texto_apagado()).child("Sem instruções")
            } else {
                div().child(
                    div().id("instrucoes-do-bot").max_h(px(160.)).overflow_y_scroll().whitespace_normal().child(bot.instrucoes.clone()),
                )
            };
            secao("Bot")
                .child(
                    div()
                        .min_w_0()
                        .truncate()
                        .text_color(tema::texto_forte())
                        .font_weight(gpui::FontWeight::SEMIBOLD)
                        .child(bot.nome.clone()),
                )
                .child(item("Situação", div().child(situacao)))
                .child(item("Modelo", modelo))
                .child(item("Instruções", instrucoes))
        });

        let pendentes = sessao.aprovacoes.pendentes();
        let titulo_dos_pedidos: SharedString = match pendentes.len() {
            0 => "Pedidos pendentes".into(),
            quantos => format!("Pedidos pendentes ({quantos})").into(),
        };
        let linhas = pendentes.iter().enumerate().map(|(indice, aprovacao)| {
            let nome = sessao.bots.iter().find(|bot| bot.id == aprovacao.bot_id).map_or("Bot", |bot| bot.nome.as_str());
            let (credencial, bot_id) = (sessao.credencial.clone(), aprovacao.bot_id.clone());
            div()
                .id(("pendente", indice))
                .debug_selector(|| "pendente".into())
                .p_2()
                .flex()
                .flex_col()
                .gap_0p5()
                .rounded_md()
                .cursor_pointer()
                .bg(tema::elevado())
                .border_1()
                .border_color(tema::divisoria())
                .hover(|estilo| estilo.bg(tema::sob_o_mouse()))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap_2()
                        .child(div().flex_1().min_w_0().truncate().text_color(tema::texto_forte()).child(nome.to_owned()))
                        .child(texto_pequeno(aprovacao.ferramenta.clone(), tema::estado_de_aviso()).flex_none()),
                )
                .child(texto_pequeno(aprovacao.resumo.clone(), tema::texto_secundario()).min_w_0().truncate())
                .on_click(cx.listener(move |janela, _, _, cx| janela.escolher_na_lista(&credencial, bot_id.clone(), cx)))
        });
        let linhas: Vec<_> = linhas.collect();
        let pedidos = if linhas.is_empty() {
            secao("Pedidos pendentes").child(texto_pequeno("Nenhum pedido esperando.", tema::texto_apagado()))
        } else {
            div()
                .flex()
                .flex_col()
                .gap_2()
                .child(texto_pequeno(titulo_dos_pedidos, tema::texto_secundario()))
                .children(linhas)
                .child(texto_pequeno("Aprovar e negar ficam no cartão, na conversa.", tema::texto_apagado()))
        };

        div()
            .w(px(tema::LARGURA_DOS_DETALHES))
            .flex_none()
            .h_full()
            .flex()
            .flex_col()
            .bg(tema::painel())
            .border_l_1()
            .border_color(tema::divisoria())
            .child(div().py(px(14.)).px_4().text_color(tema::texto_forte()).font_weight(gpui::FontWeight::SEMIBOLD).child("Detalhes"))
            .child(
                div()
                    .id("detalhes")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .px_4()
                    .pb_4()
                    .flex()
                    .flex_col()
                    .gap_5()
                    .children(do_bot)
                    .child(pedidos),
            )
    }

    fn desenhar_formulario(&self, formulario: &Formulario, cx: &mut Context<Self>) -> gpui::Div {
        let titulo: SharedString = match &formulario.bot {
            Some(bot) => format!("Editar {}", bot.nome).into(),
            None => "Novo bot".into(),
        };
        let aviso = formulario.aviso.clone().map(|texto| div().text_color(tema::estado_de_erro()).child(texto));
        div()
            .flex_1()
            .min_w_0()
            .h_full()
            .flex()
            .flex_col()
            .child(
                div().py(px(14.)).px_4().truncate().text_color(tema::texto_forte()).font_weight(gpui::FontWeight::SEMIBOLD).child(titulo),
            )
            .child(
                div().id("formulario-de-bot").flex_1().min_h_0().overflow_y_scroll().p_4().child(
                    div()
                        .w_full()
                        .max_w(px(560.))
                        .flex()
                        .flex_col()
                        .gap_3()
                        .child(campo_do_formulario("Nome", &formulario.nome, None, formulario.erros.nome.as_ref()))
                        .child(campo_do_formulario(
                            "Modelo",
                            &formulario.modelo,
                            Some("Em branco, o bot usa o modelo padrão do motor."),
                            formulario.erros.modelo.as_ref(),
                        ))
                        .child(campo_do_formulario(
                            "Instruções",
                            &formulario.instrucoes,
                            Some("Enter quebra a linha. Para salvar, use o botão, ou Enter no nome ou no modelo."),
                            formulario.erros.instrucoes.as_ref(),
                        ))
                        .children(aviso)
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap_2()
                                .child(
                                    botao("salvar-bot", if formulario.ocupado { "Salvando…" } else { "Salvar" }, true)
                                        .debug_selector(|| "salvar-bot".into())
                                        .on_click(cx.listener(|janela, _, _, cx| janela.salvar_bot(cx))),
                                )
                                .child(
                                    botao("cancelar-bot", "Cancelar", false)
                                        .debug_selector(|| "cancelar-bot".into())
                                        .on_click(cx.listener(|janela, _, _, cx| janela.fechar_formulario(cx))),
                                ),
                        ),
                ),
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
        // Um clique num botão ou numa área vazia deixa o teclado na janela, sem campo nenhum:
        // ele volta para o campo em que estava, para a pessoa seguir digitando.
        let campos = self.campos_em_ordem(cx);
        if let Some(com_o_teclado) = campos.iter().find(|campo| campo.is_focused(window)) {
            self.ultimo_campo = Some(com_o_teclado.clone());
        } else if self.foco.is_focused(window) {
            let de_volta = self.ultimo_campo.clone().filter(|ultimo| campos.contains(ultimo)).or_else(|| campos.first().cloned());
            if let Some(campo) = de_volta {
                window.focus(&campo, cx);
            }
        }
        let conteudo = match &self.tela {
            Tela::Pareamento(tela) => self.desenhar_pareamento(tela, cx),
            Tela::Sessao(sessao) => {
                let cabem_detalhes = window.viewport_size().width >= px(tema::JANELA_MINIMA_COM_DETALHES);
                let (central, detalhes) = match &sessao.formulario {
                    Some(formulario) => (self.desenhar_formulario(formulario, cx), None),
                    None => {
                        let com_o_teclado = sessao.compositor.focus_handle(cx).is_focused(window);
                        let detalhes = (cabem_detalhes && self.detalhes_abertos).then(|| self.desenhar_detalhes(sessao, cx));
                        (self.desenhar_conversa(sessao, com_o_teclado, cabem_detalhes, cx), detalhes)
                    }
                };
                div().size_full().flex().child(self.desenhar_lateral(sessao, cx)).child(central).children(detalhes)
            }
        };
        div()
            .key_context(CONTEXTO)
            .track_focus(&self.foco)
            .on_action(cx.listener(Self::proximo_campo))
            .on_action(cx.listener(Self::campo_anterior))
            .on_action(cx.listener(Self::cancelar))
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
    //! o que se digita, as teclas e os cliques passam pelo mesmo caminho de uma pessoa usando o
    //! app. O cofre é o de memória; o do sistema tem teste próprio em `cofre_do_sistema.rs`.

    use std::time::{Duration, Instant};

    use awikabot_cliente::contrato::BotEntrada;
    use awikabot_cliente::servidor_de_teste::{RespostaFalsa, ServidorDeTeste, ServidorFalso};
    use awikabot_cliente::sessao::CofreEmMemoria;
    use gpui::{Modifiers, TestAppContext, VisualTestContext};

    use super::*;
    use crate::campo;

    fn abrir(cofre: &Arc<CofreEmMemoria>, cx: &mut TestAppContext) -> (Entity<Janela>, VisualTestContext) {
        cx.update(|cx| {
            campo::registrar_teclas(cx);
            registrar_teclas(cx);
            identificar_o_app(cx);
        });
        let do_app: Arc<dyn Cofre> = cofre.clone();
        let janela = cx.add_window(|window, cx| Janela::new(do_app, None, window, cx));
        cx.update(|cx| ligar_avisos(janela, cx));
        let mut cx = VisualTestContext::from_window(janela.into(), cx);
        // Como no app, que abre a janela na frente.
        cx.update(|window, _| window.activate_window());
        cx.run_until_parked();
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

    /// Espera algo que se vê de fora do app, como o estado no servidor.
    fn esperar_fora(cx: &mut VisualTestContext, o_que: &str, condicao: impl Fn() -> bool) {
        let limite = Instant::now() + Duration::from_secs(20);
        while !condicao() {
            assert!(Instant::now() < limite, "não aconteceu: {o_que}");
            cx.run_until_parked();
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Clica no meio de um elemento que está na tela, achado pelo nome de teste dele.
    fn clicar(cx: &mut VisualTestContext, seletor: &'static str) {
        cx.run_until_parked();
        let area = cx.debug_bounds(seletor).unwrap_or_else(|| panic!("não está na tela: {seletor}"));
        cx.simulate_click(area.center(), Modifiers::none());
    }

    fn na_tela(cx: &mut VisualTestContext, seletor: &'static str) -> bool {
        cx.run_until_parked();
        cx.debug_bounds(seletor).is_some()
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

    fn pronta_com_bot(janela: &Janela) -> bool {
        conectada(janela) && aberta(janela).is_some_and(|sessao| !sessao.bots.is_empty() && sessao.selecionado.is_some())
    }

    fn ultima_mensagem(janela: &Janela) -> Option<&Mensagem> {
        aberta(janela)?.conversa.mensagens.last()
    }

    fn resposta_completa(janela: &Janela) -> bool {
        ultima_mensagem(janela).is_some_and(|ultima| ultima.estado == MensagemEstado::Completa && ultima.papel == MensagemPapel::Bot)
    }

    /// Os pedidos de aprovação do bot selecionado, do mais antigo para o mais novo.
    fn pedidos(janela: &Janela) -> Vec<Aprovacao> {
        let Some(sessao) = aberta(janela) else { return Vec::new() };
        let Some(bot_id) = &sessao.selecionado else { return Vec::new() };
        sessao.aprovacoes.do_bot(bot_id).into_iter().cloned().collect()
    }

    fn estados_dos_pedidos(janela: &Janela) -> Vec<AprovacaoEstado> {
        pedidos(janela).iter().map(|aprovacao| aprovacao.estado).collect()
    }

    /// Um computador já pareado, como ficaria no cofre.
    fn parear_pela_api(servidor: &ServidorDeTeste, nome: &str) -> Sessao {
        let pedido = PedidoPareamento { codigo: servidor.codigo_de_pareamento(), nome: nome.into() };
        let resposta = Api::new().parear(&servidor.base, &pedido).expect("parear pela API");
        Sessao { servidor: servidor.base.clone(), token: resposta.token, dispositivo: resposta.dispositivo }
    }

    fn criar_bot_pela_api(sessao: &Sessao, nome: &str) -> Bot {
        Api::new()
            .criar_bot(&sessao.credencial(), &BotEntrada { nome: nome.into(), instrucoes: None, modelo: None })
            .expect("criar bot pela API")
    }

    fn cofre_com(guardada: &Sessao) -> Arc<CofreEmMemoria> {
        Arc::new(CofreEmMemoria::com(&sessao::serializar(guardada)))
    }

    /// Um servidor com um computador pareado e um bot, e a janela aberta nele, já conectada.
    fn abrir_com_bot(cx: &mut TestAppContext, nome_do_bot: &str) -> (ServidorDeTeste, Sessao, Bot, Entity<Janela>, VisualTestContext) {
        cx.executor().allow_parking();
        let servidor = ServidorDeTeste::subir();
        let guardada = parear_pela_api(&servidor, "Computador de teste");
        let bot = criar_bot_pela_api(&guardada, nome_do_bot);
        let (janela, mut cx) = abrir(&cofre_com(&guardada), cx);
        esperar(&mut cx, &janela, "sessão conectada, com o bot selecionado", pronta_com_bot);
        (servidor, guardada, bot, janela, cx)
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

        // Um bot criado pelo formulário: o teclado cai no nome, e Enter salva.
        clicar(&mut cx, "novo-bot");
        cx.simulate_input("Scout");
        cx.simulate_keystrokes("enter");
        esperar(&mut cx, &janela, "bot criado e selecionado", |janela| {
            aberta(janela).is_some_and(|sessao| sessao.bots.len() == 1 && sessao.selecionado.is_some() && sessao.formulario.is_none())
        });
        // Sem clicar em nada: fechado o formulário, o teclado volta ao campo de mensagem.
        cx.simulate_input("olá mundo");
        cx.simulate_keystrokes("enter");
        esperar(&mut cx, &janela, "resposta completa do bot", resposta_completa);
        janela.read_with(&cx, |janela, cx| {
            let sessao = aberta(janela).expect("sessão");
            let textos: Vec<_> = sessao.conversa.mensagens.iter().map(|mensagem| (mensagem.papel, mensagem.texto.as_str())).collect();
            assert_eq!(textos, vec![(MensagemPapel::Usuario, "olá mundo"), (MensagemPapel::Bot, "Você disse: olá mundo")]);
            assert_eq!(sessao.compositor.read(cx).texto(), "", "o campo esvazia depois de enviar");
            assert_eq!(sessao.aviso, None);
        });

        // Desparear volta ao começo, esvazia o cofre, e o servidor passa a recusar o token.
        clicar(&mut cx, "desparear");
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
        criar_bot_pela_api(&guardada, "Scout");

        let cofre = cofre_com(&guardada);
        let (janela, mut cx) = abrir(&cofre, cx);
        // Antes de qualquer resposta da rede, a tela já é a da conversa.
        janela.read_with(&cx, |janela, _| assert!(aberta(janela).is_some(), "devia abrir sem passar pelo pareamento"));
        esperar(&mut cx, &janela, "bots carregados e fluxo conectado", pronta_com_bot);
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

        // O dono revoga este computador a partir de outro lugar; o próximo pedido do app descobre.
        Api::new().revogar_dispositivo(&guardada.credencial()).expect("revogar");
        let credencial = guardada.credencial();
        janela.update(&mut cx, |janela, cx| janela.carregar_bots(&credencial, cx));
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
        let recusada = sessao::ler_guardada(Some(&tentativa)).expect("o que o app tentou gravar é uma sessão");
        esperar_fora(&mut cx, "o token que não foi guardado deixa de valer no servidor", || {
            Api::new().listar_bots(&recusada.credencial()) == Err(ErroApi::NaoAutenticado)
        });
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

    #[gpui::test]
    fn depois_de_clicar_em_enviar_o_teclado_continua_no_campo_de_mensagem(cx: &mut TestAppContext) {
        let (_servidor, _guardada, _bot, janela, mut cx) = abrir_com_bot(cx, "Scout");
        cx.simulate_input("primeira");
        clicar(&mut cx, "enviar");
        esperar(&mut cx, &janela, "primeira resposta completa", resposta_completa);
        // Sem clicar no campo: o clique no botão não pode ter levado o teclado embora.
        cx.simulate_input("segunda");
        cx.simulate_keystrokes("enter");
        esperar(&mut cx, &janela, "segunda resposta completa", |janela| {
            resposta_completa(janela) && aberta(janela).is_some_and(|sessao| sessao.conversa.mensagens.len() == 4)
        });
        janela.read_with(&cx, |janela, _| {
            let textos: Vec<_> =
                aberta(janela).expect("sessão").conversa.mensagens.iter().map(|mensagem| mensagem.texto.as_str()).collect();
            assert_eq!(textos, vec!["primeira", "Você disse: primeira", "segunda", "Você disse: segunda"]);
        });
    }

    #[gpui::test]
    fn o_aviso_de_versao_nova_aparece_no_pareamento_e_na_conversa(cx: &mut TestAppContext) {
        cx.executor().allow_parking();
        // De onde as versões sairiam não responde nada de útil: o painel fica só com a opção de avisar.
        let sem_versoes = ServidorFalso::subir(|_, _| RespostaFalsa::html(404));
        let pasta = std::env::temp_dir().join(format!("awikabot-teste-janela-atualizacao-{}", std::process::id()));
        let configuracao = Configuracao {
            origem: awikabot_cliente::atualizacao::Origem::de_teste(&sem_versoes.base),
            plataforma: "windows-x64".into(),
            atual: awikabot_cliente::atualizacao::Versao::deste_app(),
            pasta: pasta.clone(),
            politica: crate::confianca::Politica::do_app(),
            espera: Duration::ZERO,
            instalar: Arc::new(|_| Ok(())),
        };
        let servidor = ServidorDeTeste::subir();
        let guardada = parear_pela_api(&servidor, "Computador de teste");
        criar_bot_pela_api(&guardada, "Scout");

        // Sem sessão: a tela é a de pareamento.
        cx.update(|cx| {
            campo::registrar_teclas(cx);
            registrar_teclas(cx);
            identificar_o_app(cx);
        });
        let sem_sessao: Arc<dyn Cofre> = Arc::new(CofreEmMemoria::default());
        let de_pareamento = cx.add_window(|window, cx| Janela::new(sem_sessao, Some(configuracao.clone()), window, cx));
        let mut no_pareamento = VisualTestContext::from_window(de_pareamento.into(), cx);
        assert!(na_tela(&mut no_pareamento, "alternar-aviso-de-versao"));

        // Com sessão: a tela é a da conversa, e o aviso fica na lateral.
        let com_sessao: Arc<dyn Cofre> = cofre_com(&guardada);
        let de_conversa = no_pareamento.add_window(|window, cx| Janela::new(com_sessao, Some(configuracao), window, cx));
        let mut na_conversa = VisualTestContext::from_window(de_conversa.into(), &no_pareamento);
        let raiz = de_conversa.root(&mut na_conversa).expect("raiz da janela");
        esperar(&mut na_conversa, &raiz, "sessão conectada, com o bot selecionado", pronta_com_bot);
        assert!(na_tela(&mut na_conversa, "alternar-aviso-de-versao"));
        let _ = std::fs::remove_dir_all(pasta);
    }

    // --- Formulário de bot --------------------------------------------------------

    #[gpui::test]
    fn cria_um_bot_pelo_formulario_com_nome_modelo_e_instrucoes(cx: &mut TestAppContext) {
        cx.executor().allow_parking();
        let servidor = ServidorDeTeste::subir();
        let guardada = parear_pela_api(&servidor, "Computador de teste");
        let (janela, mut cx) = abrir(&cofre_com(&guardada), cx);
        esperar(&mut cx, &janela, "sessão conectada", conectada);

        clicar(&mut cx, "novo-bot");
        // Salvar sem nome não manda nada ao servidor: o erro aparece no campo.
        clicar(&mut cx, "salvar-bot");
        janela.read_with(&cx, |janela, _| {
            let formulario = aberta(janela).and_then(|sessao| sessao.formulario.as_ref()).expect("o formulário continua aberto");
            assert!(formulario.erros.nome.is_some(), "faltou o erro do nome");
            assert!(!formulario.ocupado, "nenhum pedido devia ter saído");
        });
        assert_eq!(Api::new().listar_bots(&guardada.credencial()).expect("listar").bots, Vec::new());

        // O teclado está no nome; Tab leva ao modelo e depois às instruções, onde Enter quebra a linha.
        cx.simulate_input("Scout");
        cx.simulate_keystrokes("tab");
        cx.simulate_input("modelo-de-teste");
        cx.simulate_keystrokes("tab");
        cx.simulate_input("Responda curto.");
        cx.simulate_keystrokes("enter");
        cx.simulate_input("Em português.");
        clicar(&mut cx, "salvar-bot");
        esperar(&mut cx, &janela, "bot criado e formulário fechado", |janela| {
            aberta(janela).is_some_and(|sessao| sessao.formulario.is_none() && sessao.bots.len() == 1 && sessao.selecionado.is_some())
        });

        let no_servidor = Api::new().listar_bots(&guardada.credencial()).expect("listar").bots;
        assert_eq!(no_servidor.len(), 1);
        assert_eq!(
            (no_servidor[0].nome.as_str(), no_servidor[0].modelo.as_deref(), no_servidor[0].instrucoes.as_str()),
            ("Scout", Some("modelo-de-teste"), "Responda curto.\nEm português.")
        );
        janela.read_with(&cx, |janela, _| {
            let sessao = aberta(janela).expect("sessão");
            assert_eq!(sessao.selecionado.as_deref(), Some(no_servidor[0].id.as_str()), "o bot novo fica selecionado");
        });
    }

    #[gpui::test]
    fn edita_o_bot_selecionado_e_so_manda_o_que_mudou(cx: &mut TestAppContext) {
        let (_servidor, guardada, bot, janela, mut cx) = abrir_com_bot(cx, "Scout");
        let listar = || Api::new().listar_bots(&guardada.credencial()).expect("listar").bots;

        // O formulário abre com os dados do bot. Esc fecha sem salvar o que foi digitado.
        clicar(&mut cx, "editar-bot");
        janela.read_with(&cx, |janela, cx| {
            let formulario = aberta(janela).and_then(|sessao| sessao.formulario.as_ref()).expect("formulário aberto");
            assert_eq!(formulario.nome.read(cx).texto(), "Scout");
            assert_eq!(formulario.bot.as_ref().map(|bot| bot.id.as_str()), Some(bot.id.as_str()));
        });
        cx.simulate_input(" que não vai ficar");
        cx.simulate_keystrokes("escape");
        janela.read_with(&cx, |janela, _| assert!(aberta(janela).is_some_and(|sessao| sessao.formulario.is_none())));
        assert_eq!(listar()[0].nome, "Scout");

        // Salvar sem mudar nada só fecha: o bot não é regravado.
        clicar(&mut cx, "editar-bot");
        clicar(&mut cx, "salvar-bot");
        janela.read_with(&cx, |janela, _| assert!(aberta(janela).is_some_and(|sessao| sessao.formulario.is_none())));
        assert_eq!(listar()[0].atualizado_em, bot.atualizado_em, "nada foi enviado ao servidor");

        // Troca o nome e põe um modelo; Enter no campo de modelo salva.
        clicar(&mut cx, "editar-bot");
        cx.simulate_keystrokes(&format!("{}-a", campo::tecla_principal()));
        cx.simulate_input("Batedor");
        cx.simulate_keystrokes("tab");
        cx.simulate_input("modelo:2[beta]");
        cx.simulate_keystrokes("enter");
        esperar(&mut cx, &janela, "bot editado e formulário fechado", |janela| {
            aberta(janela).is_some_and(|sessao| sessao.formulario.is_none() && sessao.bots.iter().any(|bot| bot.nome == "Batedor"))
        });
        let editado = listar().remove(0);
        assert_eq!(
            (editado.nome.as_str(), editado.modelo.as_deref(), editado.id.as_str()),
            ("Batedor", Some("modelo:2[beta]"), bot.id.as_str())
        );

        // Apagar o modelo devolve o bot ao padrão do motor.
        clicar(&mut cx, "editar-bot");
        cx.simulate_keystrokes("tab");
        cx.simulate_keystrokes(&format!("{}-a backspace enter", campo::tecla_principal()));
        esperar_fora(&mut cx, "modelo de volta ao padrão no servidor", || listar()[0].modelo.is_none());
        esperar(&mut cx, &janela, "formulário fechado", |janela| aberta(janela).is_some_and(|sessao| sessao.formulario.is_none()));
    }

    #[gpui::test]
    fn modelo_fora_da_regra_fica_no_formulario_com_o_erro_do_campo(cx: &mut TestAppContext) {
        let (_servidor, guardada, bot, janela, mut cx) = abrir_com_bot(cx, "Scout");
        clicar(&mut cx, "editar-bot");
        cx.simulate_keystrokes("tab");
        cx.simulate_input("modelo com espaço");
        cx.simulate_keystrokes("enter");
        janela.read_with(&cx, |janela, _| {
            let formulario = aberta(janela).and_then(|sessao| sessao.formulario.as_ref()).expect("o formulário continua aberto");
            assert!(formulario.erros.modelo.is_some());
            assert_eq!((formulario.erros.nome.as_ref(), formulario.erros.instrucoes.as_ref()), (None, None));
        });
        let no_servidor = Api::new().listar_bots(&guardada.credencial()).expect("listar").bots;
        assert_eq!(no_servidor[0].atualizado_em, bot.atualizado_em, "nada foi enviado ao servidor");
    }

    // --- Cartões de aprovação -----------------------------------------------------

    #[gpui::test]
    fn o_cartao_aprova_pelo_botao_e_o_bot_segue(cx: &mut TestAppContext) {
        let (_servidor, _guardada, bot, janela, mut cx) = abrir_com_bot(cx, "Scout");
        cx.simulate_input("!comando ls -la");
        cx.simulate_keystrokes("enter");
        esperar(&mut cx, &janela, "pedido de aprovação pendente", |janela| estados_dos_pedidos(janela) == [AprovacaoEstado::Pendente]);

        // O bot está parado à espera da pessoa: é isso que a lista de bots diz, e o cartão mostra o pedido inteiro.
        janela.read_with(&cx, |janela, _| {
            let sessao = aberta(janela).expect("sessão");
            assert_eq!(situacao_do_bot(&sessao.bots[0], &sessao.aprovacoes), Some(Situacao::AguardandoAprovacao));
            let pedido = &pedidos(janela)[0];
            assert_eq!(pedido.bot_id, bot.id);
            assert!(pedido.resumo.contains("ls -la"), "o cartão mostra o comando: {:?}", pedido.resumo);
        });
        assert!(na_tela(&mut cx, "aprovar") && na_tela(&mut cx, "negar"));

        clicar(&mut cx, "aprovar");
        esperar(&mut cx, &janela, "pedido aprovado e resposta completa", |janela| {
            estados_dos_pedidos(janela) == [AprovacaoEstado::Aprovada] && resposta_completa(janela)
        });
        assert!(!na_tela(&mut cx, "aprovar"), "resolvido, o cartão vira uma linha, sem botões");
        janela.read_with(&cx, |janela, _| {
            let sessao = aberta(janela).expect("sessão");
            assert_eq!(situacao_do_bot(&sessao.bots[0], &sessao.aprovacoes), None);
            assert!(sessao.decidindo.is_empty());
        });
    }

    #[gpui::test]
    fn o_cartao_nega_pelo_botao_e_a_acao_nao_roda(cx: &mut TestAppContext) {
        let (_servidor, _guardada, _bot, janela, mut cx) = abrir_com_bot(cx, "Scout");
        cx.simulate_input("!gravar notas.txt");
        cx.simulate_keystrokes("enter");
        esperar(&mut cx, &janela, "pedido de aprovação pendente", |janela| estados_dos_pedidos(janela) == [AprovacaoEstado::Pendente]);
        clicar(&mut cx, "negar");
        esperar(&mut cx, &janela, "pedido negado e turno terminado", |janela| {
            estados_dos_pedidos(janela) == [AprovacaoEstado::Negada]
                && ultima_mensagem(janela).is_some_and(|ultima| ultima.estado != MensagemEstado::EmAndamento)
        });
    }

    #[gpui::test]
    fn pedido_que_ja_esperava_aparece_ao_abrir_o_app_e_decisao_de_outro_aparelho_chega_pelo_fluxo(cx: &mut TestAppContext) {
        cx.executor().allow_parking();
        let servidor = ServidorDeTeste::subir();
        let guardada = parear_pela_api(&servidor, "Computador de teste");
        let outro = parear_pela_api(&servidor, "Celular");
        let bot = criar_bot_pela_api(&guardada, "Scout");
        let api = Api::new();
        // O pedido nasce antes de o app abrir.
        api.enviar_turno(&outro.credencial(), &bot.id, &PedidoTurno { texto: "!comando whoami".into() }).expect("turno");
        esperar_fora_do_app("pedido pendente no servidor", || {
            api.listar_aprovacoes(&outro.credencial()).is_ok_and(|lista| lista.aprovacoes.len() == 1)
        });

        let (janela, mut cx) = abrir(&cofre_com(&guardada), cx);
        esperar(&mut cx, &janela, "o pedido que já esperava aparece", |janela| estados_dos_pedidos(janela) == [AprovacaoEstado::Pendente]);
        assert!(na_tela(&mut cx, "aprovar"));

        // O celular nega: o cartão daqui acompanha, sem ninguém clicar em nada.
        let pedido = janela.read_with(&cx, |janela, _| pedidos(janela)[0].clone());
        api.decidir_aprovacao(&outro.credencial(), &pedido.id, &DecisaoAprovacao { decisao: DecisaoAprovacaoDecisao::Negar })
            .expect("negar");
        esperar(&mut cx, &janela, "pedido negado pelo outro aparelho", |janela| estados_dos_pedidos(janela) == [AprovacaoEstado::Negada]);
        assert!(!na_tela(&mut cx, "aprovar"));
    }

    #[gpui::test]
    fn pedido_resolvido_antes_de_o_app_abrir_aparece_na_conversa_como_linha(cx: &mut TestAppContext) {
        cx.executor().allow_parking();
        let servidor = ServidorDeTeste::subir();
        let guardada = parear_pela_api(&servidor, "Computador de teste");
        let outro = parear_pela_api(&servidor, "Celular");
        let bot = criar_bot_pela_api(&guardada, "Scout");
        let api = Api::new();
        // O pedido nasce, é negado e o turno termina antes de o app abrir: nada disso passa pelo fluxo daqui.
        api.enviar_turno(&outro.credencial(), &bot.id, &PedidoTurno { texto: "!comando whoami".into() }).expect("turno");
        esperar_fora_do_app("pedido pendente no servidor", || {
            api.listar_aprovacoes(&outro.credencial()).is_ok_and(|lista| lista.aprovacoes.len() == 1)
        });
        let pedido = api.listar_aprovacoes(&outro.credencial()).expect("pendentes").aprovacoes.remove(0);
        let negada = api
            .decidir_aprovacao(&outro.credencial(), &pedido.id, &DecisaoAprovacao { decisao: DecisaoAprovacaoDecisao::Negar })
            .expect("negar");
        esperar_fora_do_app("turno terminado no servidor", || {
            api.listar_bots(&outro.credencial()).is_ok_and(|lista| !lista.bots[0].turno_ativo)
        });

        let (janela, mut cx) = abrir(&cofre_com(&guardada), cx);
        esperar(&mut cx, &janela, "o pedido resolvido vem com a conversa", |janela| pedidos(janela) == [negada.clone()]);
        assert!(na_tela(&mut cx, "pedido-resolvido"), "a linha do pedido está na conversa");
        assert!(!na_tela(&mut cx, "aprovar"), "resolvido, não há o que decidir");
        janela.read_with(&cx, |janela, _| {
            let sessao = aberta(janela).expect("sessão");
            assert_eq!(situacao_do_bot(&sessao.bots[0], &sessao.aprovacoes), None);
            assert_eq!(ultima_mensagem(janela).map(|ultima| ultima.id.as_str()), Some(negada.mensagem_id.as_str()));
        });
    }

    #[gpui::test]
    fn sem_o_fluxo_de_eventos_o_pedido_que_esperava_ainda_aparece_ao_abrir(cx: &mut TestAppContext) {
        cx.executor().allow_parking();
        // Um caminho que deixa passar os pedidos comuns e derruba o fluxo de eventos, como um proxy mal configurado.
        let servidor = ServidorFalso::subir(|_, pedido| {
            let linha = pedido.linha.as_str();
            if linha.contains("/v1/eventos") {
                RespostaFalsa::html(502)
            } else if linha.contains("/v1/aprovacoes") {
                RespostaFalsa::json(
                    200,
                    r#"{"aprovacoes":[{"id":"aprovacao0000001","botId":"botbotbotbotbot1","mensagemId":"mensagem00000001","ferramenta":"Bash","resumo":"ls","estado":"pendente","criadaEm":2,"resolvidaEm":null}]}"#,
                )
            } else if linha.contains("/mensagens") {
                RespostaFalsa::json(200, r#"{"mensagens":[],"temMais":false}"#)
            } else if linha.contains("/v1/bots") {
                RespostaFalsa::json(
                    200,
                    r#"{"bots":[{"id":"botbotbotbotbot1","nome":"Scout","instrucoes":"","modelo":null,"criadoEm":1,"atualizadoEm":1,"turnoAtivo":true}]}"#,
                )
            } else {
                RespostaFalsa::html(404)
            }
        });
        let guardada = Sessao {
            servidor: servidor.base.clone(),
            token: "t".repeat(43),
            dispositivo: awikabot_cliente::contrato::Dispositivo { id: "abcdefgh12345678".into(), nome: "Computador".into(), criado_em: 1 },
        };
        let (janela, mut cx) = abrir(&cofre_com(&guardada), cx);
        esperar(&mut cx, &janela, "o pedido pendente aparece sem o fluxo", |janela| {
            estados_dos_pedidos(janela) == [AprovacaoEstado::Pendente]
        });
        janela.read_with(&cx, |janela, _| {
            let sessao = aberta(janela).expect("sessão");
            assert_ne!(sessao.conexao, Some(Conexao::Conectada), "o fluxo não conectou neste teste");
            assert_eq!(situacao_do_bot(&sessao.bots[0], &sessao.aprovacoes), Some(Situacao::AguardandoAprovacao));
        });
        assert!(na_tela(&mut cx, "aprovar"), "o cartão está na conversa, com os botões");
    }

    fn esperar_fora_do_app(o_que: &str, condicao: impl Fn() -> bool) {
        let limite = Instant::now() + Duration::from_secs(20);
        while !condicao() {
            assert!(Instant::now() < limite, "não aconteceu: {o_que}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[gpui::test]
    fn decidir_um_pedido_que_outro_aparelho_ja_resolveu_avisa_e_nao_desfaz_o_desfecho(cx: &mut TestAppContext) {
        let (servidor, _guardada, bot, janela, mut cx) = abrir_com_bot(cx, "Scout");
        let outro = parear_pela_api(&servidor, "Celular");
        cx.simulate_input("!comando date");
        cx.simulate_keystrokes("enter");
        esperar(&mut cx, &janela, "pedido de aprovação pendente", |janela| estados_dos_pedidos(janela) == [AprovacaoEstado::Pendente]);
        let pedido = janela.read_with(&cx, |janela, _| pedidos(janela)[0].clone());
        assert_eq!(pedido.bot_id, bot.id);

        // O celular nega; antes de o evento chegar aqui, a pessoa aprova no computador.
        Api::new()
            .decidir_aprovacao(&outro.credencial(), &pedido.id, &DecisaoAprovacao { decisao: DecisaoAprovacaoDecisao::Negar })
            .expect("negar pelo celular");
        janela.update(&mut cx, |janela, cx| janela.decidir(pedido.id.clone(), DecisaoAprovacaoDecisao::Aprovar, cx));
        esperar(&mut cx, &janela, "o desfecho do servidor prevalece", |janela| {
            estados_dos_pedidos(janela) == [AprovacaoEstado::Negada] && aberta(janela).is_some_and(|sessao| sessao.decidindo.is_empty())
        });
        janela.read_with(&cx, |janela, _| {
            assert_eq!(
                aberta(janela).and_then(|sessao| sessao.aviso.as_ref()).map(ToString::to_string).as_deref(),
                Some("Este pedido já tinha sido resolvido.")
            );
        });
    }

    // --- Aviso do sistema ---------------------------------------------------------

    #[gpui::test]
    fn com_a_janela_na_frente_o_pedido_nao_gera_aviso_do_sistema(cx: &mut TestAppContext) {
        let (_servidor, _guardada, _bot, janela, mut cx) = abrir_com_bot(cx, "Scout");
        janela.read_with(&cx, |janela, _| assert!(janela.na_frente, "a janela de teste abre na frente"));
        cx.simulate_input("!comando ls");
        cx.simulate_keystrokes("enter");
        esperar(&mut cx, &janela, "pedido de aprovação pendente", |janela| estados_dos_pedidos(janela) == [AprovacaoEstado::Pendente]);
        assert_eq!(cx.shown_system_notifications(), Vec::new(), "quem está olhando para o app vê o cartão");
    }

    #[gpui::test]
    fn com_a_janela_em_segundo_plano_o_pedido_gera_aviso_sem_o_conteudo_e_o_clique_abre_a_conversa(cx: &mut TestAppContext) {
        let (_servidor, guardada, primeiro, janela, mut cx) = abrir_com_bot(cx, "Scout");
        let segundo = criar_bot_pela_api(&guardada, "Vigia");
        esperar(&mut cx, &janela, "segundo bot na lista", |janela| aberta(janela).is_some_and(|sessao| sessao.bots.len() == 2));
        janela.read_with(&cx, |janela, _| {
            assert_eq!(aberta(janela).and_then(|sessao| sessao.selecionado.as_deref()), Some(primeiro.id.as_str()));
        });

        // A pessoa vai para outro programa; o segundo bot, que nem está na tela, pede uma aprovação.
        cx.deactivate_window();
        janela.read_with(&cx, |janela, _| assert!(!janela.na_frente));
        Api::new()
            .enviar_turno(&guardada.credencial(), &segundo.id, &PedidoTurno { texto: "!comando cat senha-do-banco.txt".into() })
            .expect("turno");
        esperar(&mut cx, &janela, "pedido do segundo bot conhecido", |janela| {
            aberta(janela).is_some_and(|sessao| sessao.aprovacoes.tem_pendente(&segundo.id))
        });

        let avisos = cx.shown_system_notifications();
        assert_eq!(avisos.len(), 1, "um pedido, um aviso: {avisos:?}");
        let aviso = &avisos[0];
        assert_eq!(aviso.title.as_ref(), "Vigia pede aprovação");
        assert!(
            !aviso.body.contains("senha-do-banco") && !aviso.title.contains("senha-do-banco"),
            "o aviso não leva o conteúdo: {aviso:?}"
        );
        assert!(aviso.actions.is_empty(), "a decisão é no cartão, que mostra o pedido inteiro");

        // O clique no aviso traz a janela para a conversa do bot que pediu.
        cx.simulate_system_notification_response(SystemNotificationResponse { tag: aviso.tag.clone(), action_id: None });
        esperar(&mut cx, &janela, "conversa do segundo bot aberta", |janela| {
            aberta(janela).is_some_and(|sessao| sessao.selecionado.as_deref() == Some(segundo.id.as_str()))
                && estados_dos_pedidos(janela) == [AprovacaoEstado::Pendente]
        });
        assert!(na_tela(&mut cx, "aprovar"));
    }

    #[gpui::test]
    fn o_painel_de_detalhes_lista_o_pedido_de_outro_bot_leva_a_conversa_dele_e_pode_ser_fechado(cx: &mut TestAppContext) {
        let (_servidor, guardada, primeiro, janela, mut cx) = abrir_com_bot(cx, "Scout");
        assert!(na_tela(&mut cx, "alternar-detalhes"), "a janela de teste cabe o painel");
        assert!(!na_tela(&mut cx, "pendente"));

        let segundo = criar_bot_pela_api(&guardada, "Vigia");
        Api::new()
            .enviar_turno(&guardada.credencial(), &segundo.id, &PedidoTurno { texto: "!comando cat /etc/hostname".into() })
            .expect("turno");
        esperar(&mut cx, &janela, "pedido do segundo bot conhecido", |janela| {
            aberta(janela).is_some_and(|sessao| sessao.bots.len() == 2 && sessao.aprovacoes.tem_pendente(&segundo.id))
        });
        janela.read_with(&cx, |janela, _| {
            assert_eq!(aberta(janela).and_then(|sessao| sessao.selecionado.as_deref()), Some(primeiro.id.as_str()));
        });
        // O pedido aparece no painel, sem botão de decidir: a decisão é no cartão.
        assert!(na_tela(&mut cx, "pendente"));
        assert!(!na_tela(&mut cx, "aprovar"));

        clicar(&mut cx, "pendente");
        esperar(&mut cx, &janela, "conversa do segundo bot aberta, com o cartão", |janela| {
            aberta(janela).is_some_and(|sessao| sessao.selecionado.as_deref() == Some(segundo.id.as_str()))
                && estados_dos_pedidos(janela) == [AprovacaoEstado::Pendente]
        });
        assert!(na_tela(&mut cx, "aprovar"));

        // Fechado, o painel some com o pedido; aberto de novo, volta.
        clicar(&mut cx, "alternar-detalhes");
        assert!(!na_tela(&mut cx, "pendente"));
        janela.read_with(&cx, |janela, _| assert!(!janela.detalhes_abertos));
        clicar(&mut cx, "alternar-detalhes");
        assert!(na_tela(&mut cx, "pendente"));

        // Decidido no cartão, o pedido sai do painel.
        clicar(&mut cx, "negar");
        esperar(&mut cx, &janela, "pedido negado", |janela| estados_dos_pedidos(janela) == [AprovacaoEstado::Negada]);
        assert!(!na_tela(&mut cx, "pendente"));
    }

    #[gpui::test]
    fn numa_janela_estreita_o_painel_de_detalhes_e_o_botao_dele_somem(cx: &mut TestAppContext) {
        let (_servidor, _guardada, _bot, _janela, mut cx) = abrir_com_bot(cx, "Scout");
        assert!(na_tela(&mut cx, "alternar-detalhes"));
        cx.simulate_resize(gpui::size(px(tema::JANELA_MINIMA_COM_DETALHES - 1.), px(600.)));
        cx.run_until_parked();
        assert!(!na_tela(&mut cx, "alternar-detalhes"));
        assert!(na_tela(&mut cx, "enviar"), "a conversa continua na tela");
    }

    #[gpui::test]
    fn o_aviso_do_sistema_e_recolhido_quando_o_pedido_e_resolvido_em_outro_aparelho(cx: &mut TestAppContext) {
        let (_servidor, guardada, bot, janela, mut cx) = abrir_com_bot(cx, "Scout");
        cx.deactivate_window();
        let api = Api::new();
        api.enviar_turno(&guardada.credencial(), &bot.id, &PedidoTurno { texto: "!comando uptime".into() }).expect("turno");
        esperar(&mut cx, &janela, "pedido pendente", |janela| estados_dos_pedidos(janela) == [AprovacaoEstado::Pendente]);
        let pedido = janela.read_with(&cx, |janela, _| pedidos(janela)[0].clone());
        let etiqueta = etiqueta_do_aviso(&pedido.id);
        assert_eq!(
            cx.delivered_system_notifications().iter().map(|aviso| aviso.tag.to_string()).collect::<Vec<_>>(),
            vec![etiqueta.clone()]
        );

        api.decidir_aprovacao(&guardada.credencial(), &pedido.id, &DecisaoAprovacao { decisao: DecisaoAprovacaoDecisao::Aprovar })
            .expect("aprovar de outro lugar");
        esperar(&mut cx, &janela, "pedido aprovado", |janela| estados_dos_pedidos(janela) == [AprovacaoEstado::Aprovada]);
        assert_eq!(cx.dismissed_system_notifications().iter().map(ToString::to_string).collect::<Vec<_>>(), vec![etiqueta]);
        assert_eq!(cx.delivered_system_notifications(), Vec::new());
    }

    // --- Parar um turno -----------------------------------------------------------

    #[gpui::test]
    fn parar_interrompe_a_resposta_em_andamento(cx: &mut TestAppContext) {
        let (_servidor, _guardada, _bot, janela, mut cx) = abrir_com_bot(cx, "Scout");
        assert!(na_tela(&mut cx, "enviar") && !na_tela(&mut cx, "parar"));

        // O motor de teste devolve o texto palavra por palavra: com muitas palavras, dá tempo de parar.
        cx.simulate_input(&"palavra ".repeat(600));
        cx.simulate_keystrokes("enter");
        esperar(&mut cx, &janela, "resposta chegando", |janela| {
            ultima_mensagem(janela).is_some_and(|ultima| ultima.estado == MensagemEstado::EmAndamento && !ultima.texto.is_empty())
        });
        assert!(na_tela(&mut cx, "parar") && !na_tela(&mut cx, "enviar"), "com o bot respondendo, o botão é o de parar");

        clicar(&mut cx, "parar");
        esperar(&mut cx, &janela, "resposta interrompida", |janela| {
            ultima_mensagem(janela).is_some_and(|ultima| ultima.estado == MensagemEstado::Parada)
        });
        janela.read_with(&cx, |janela, _| {
            let sessao = aberta(janela).expect("sessão");
            let ultima = sessao.conversa.mensagens.last().expect("resposta");
            assert!(ultima.texto.split_whitespace().count() < 600, "a resposta parou antes do fim");
            assert!(!sessao.parando && !sessao.bots[0].turno_ativo);
            assert_eq!(sessao.aviso, None);
        });
        assert!(na_tela(&mut cx, "enviar"), "parada a resposta, volta o botão de enviar");
    }
}
