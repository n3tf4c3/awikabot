//! Campo de texto de uma linha.
//!
//! A GPUI não traz campo de texto pronto: quem quer um implementa `EntityInputHandler`, que é por
//! onde o sistema entrega o que a pessoa digita, inclusive acentos por tecla morta e o texto em
//! composição. A forma segue o exemplo `input` da própria GPUI. Este campo é o mínimo da prova:
//! cursor, apagar, setas, início e fim, e colar. Seleção, copiar e desfazer ainda não existem.

use std::ops::Range;

use gpui::{
    App, Bounds, Context, CursorStyle, Element, ElementId, ElementInputHandler, Entity, EntityInputHandler, EventEmitter, FocusHandle,
    Focusable, GlobalElementId, KeyBinding, LayoutId, MouseButton, MouseDownEvent, PaintQuad, Pixels, Point, ShapedLine, SharedString,
    Style, TextRun, UTF16Selection, UnderlineStyle, Window, actions, div, fill, point, prelude::*, px, relative, size,
};

use crate::tema;

actions!(campo_de_texto, [Apagar, ApagarAdiante, Esquerda, Direita, Inicio, Fim, Colar, Confirmar]);

const CONTEXTO: &str = "CampoDeTexto";

/// Liga as teclas do campo. Chamado uma vez, na partida do app.
pub fn registrar_teclas(cx: &mut App) {
    let contexto = Some(CONTEXTO);
    cx.bind_keys([
        KeyBinding::new("backspace", Apagar, contexto),
        KeyBinding::new("delete", ApagarAdiante, contexto),
        KeyBinding::new("left", Esquerda, contexto),
        KeyBinding::new("right", Direita, contexto),
        KeyBinding::new("home", Inicio, contexto),
        KeyBinding::new("end", Fim, contexto),
        KeyBinding::new("enter", Confirmar, contexto),
        KeyBinding::new("ctrl-v", Colar, contexto),
        KeyBinding::new("cmd-v", Colar, contexto),
    ]);
}

/// A pessoa apertou Enter no campo.
pub struct Confirmado;

pub struct CampoDeTexto {
    foco: FocusHandle,
    texto: String,
    dica: SharedString,
    /// Posição do cursor em bytes, sempre num limite de caractere.
    cursor: usize,
    /// Trecho ainda em composição pelo sistema (tecla morta, teclado de outro idioma).
    em_composicao: Option<Range<usize>>,
    /// Máximo de caracteres, vindo do contrato.
    limite: usize,
    linha: Option<ShapedLine>,
    area: Option<Bounds<Pixels>>,
}

impl EventEmitter<Confirmado> for CampoDeTexto {}

impl CampoDeTexto {
    pub fn new(dica: impl Into<SharedString>, limite: usize, cx: &mut Context<Self>) -> Self {
        Self {
            foco: cx.focus_handle(),
            texto: String::new(),
            dica: dica.into(),
            cursor: 0,
            em_composicao: None,
            limite,
            linha: None,
            area: None,
        }
    }

    pub fn texto(&self) -> &str {
        &self.texto
    }

    /// Troca o conteúdo inteiro e põe o cursor no fim. O limite vale aqui também.
    pub fn definir(&mut self, texto: &str, cx: &mut Context<Self>) {
        self.texto.clear();
        self.cursor = 0;
        self.em_composicao = None;
        self.trocar(0..0, texto);
        cx.notify();
    }

    fn anterior(&self, posicao: usize) -> usize {
        self.texto[..posicao].char_indices().next_back().map_or(0, |(indice, _)| indice)
    }

    fn seguinte(&self, posicao: usize) -> usize {
        self.texto[posicao..].chars().next().map_or(self.texto.len(), |letra| posicao + letra.len_utf8())
    }

    /// Troca um trecho por outro texto e devolve quantos bytes entraram. Quebras de linha viram
    /// espaço, e o que passa do limite fica de fora.
    fn trocar(&mut self, faixa: Range<usize>, novo: &str) -> usize {
        let mantidos = self.texto.chars().count() - self.texto[faixa.clone()].chars().count();
        let cabem = self.limite.saturating_sub(mantidos);
        let limpo: String = novo.chars().map(|letra| if letra.is_control() { ' ' } else { letra }).take(cabem).collect();
        self.texto.replace_range(faixa.clone(), &limpo);
        self.cursor = faixa.start + limpo.len();
        limpo.len()
    }

    fn para_utf16(&self, posicao: usize) -> usize {
        self.texto[..posicao].encode_utf16().count()
    }

    fn de_utf16(&self, alvo: usize) -> usize {
        let mut contadas = 0;
        for (indice, letra) in self.texto.char_indices() {
            if contadas >= alvo {
                return indice;
            }
            contadas += letra.len_utf16();
        }
        self.texto.len()
    }

    fn faixa_de_utf16(&self, faixa: &Range<usize>) -> Range<usize> {
        self.de_utf16(faixa.start)..self.de_utf16(faixa.end)
    }

    fn faixa_para_utf16(&self, faixa: &Range<usize>) -> Range<usize> {
        self.para_utf16(faixa.start)..self.para_utf16(faixa.end)
    }

    fn mover(&mut self, posicao: usize, cx: &mut Context<Self>) {
        self.cursor = posicao;
        cx.notify();
    }

    fn apagar(&mut self, _: &Apagar, _: &mut Window, cx: &mut Context<Self>) {
        let inicio = self.anterior(self.cursor);
        self.trocar(inicio..self.cursor, "");
        cx.notify();
    }

    fn apagar_adiante(&mut self, _: &ApagarAdiante, _: &mut Window, cx: &mut Context<Self>) {
        let fim = self.seguinte(self.cursor);
        self.trocar(self.cursor..fim, "");
        cx.notify();
    }

    fn esquerda(&mut self, _: &Esquerda, _: &mut Window, cx: &mut Context<Self>) {
        self.mover(self.anterior(self.cursor), cx);
    }

    fn direita(&mut self, _: &Direita, _: &mut Window, cx: &mut Context<Self>) {
        self.mover(self.seguinte(self.cursor), cx);
    }

    fn inicio(&mut self, _: &Inicio, _: &mut Window, cx: &mut Context<Self>) {
        self.mover(0, cx);
    }

    fn fim(&mut self, _: &Fim, _: &mut Window, cx: &mut Context<Self>) {
        self.mover(self.texto.len(), cx);
    }

    fn colar(&mut self, _: &Colar, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(colado) = cx.read_from_clipboard().and_then(|item| item.text()) {
            self.trocar(self.cursor..self.cursor, &colado);
            cx.notify();
        }
    }

    fn confirmar(&mut self, _: &Confirmar, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(Confirmado);
    }

    fn ao_clicar(&mut self, evento: &MouseDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let posicao = match (&self.area, &self.linha) {
            (Some(area), Some(linha)) if !self.texto.is_empty() => linha.closest_index_for_x(evento.position.x - area.left()),
            _ => self.texto.len(),
        };
        self.mover(posicao.min(self.texto.len()), cx);
    }
}

impl EntityInputHandler for CampoDeTexto {
    fn text_for_range(
        &mut self,
        faixa_utf16: Range<usize>,
        faixa_real: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let faixa = self.faixa_de_utf16(&faixa_utf16);
        faixa_real.replace(self.faixa_para_utf16(&faixa));
        Some(self.texto[faixa].to_owned())
    }

    fn selected_text_range(&mut self, _: bool, _: &mut Window, _: &mut Context<Self>) -> Option<UTF16Selection> {
        let cursor = self.para_utf16(self.cursor);
        Some(UTF16Selection { range: cursor..cursor, reversed: false })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.em_composicao.as_ref().map(|faixa| self.faixa_para_utf16(faixa))
    }

    fn unmark_text(&mut self, _: &mut Window, _: &mut Context<Self>) {
        self.em_composicao = None;
    }

    fn replace_text_in_range(&mut self, faixa_utf16: Option<Range<usize>>, novo: &str, _: &mut Window, cx: &mut Context<Self>) {
        let faixa =
            faixa_utf16.as_ref().map(|faixa| self.faixa_de_utf16(faixa)).or(self.em_composicao.clone()).unwrap_or(self.cursor..self.cursor);
        self.trocar(faixa, novo);
        self.em_composicao = None;
        cx.notify();
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        faixa_utf16: Option<Range<usize>>,
        novo: &str,
        _nova_selecao_utf16: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let faixa =
            faixa_utf16.as_ref().map(|faixa| self.faixa_de_utf16(faixa)).or(self.em_composicao.clone()).unwrap_or(self.cursor..self.cursor);
        let inicio = faixa.start;
        let entraram = self.trocar(faixa, novo);
        self.em_composicao = (entraram > 0).then_some(inicio..inicio + entraram);
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        faixa_utf16: Range<usize>,
        area: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let linha = self.linha.as_ref()?;
        let faixa = self.faixa_de_utf16(&faixa_utf16);
        Some(Bounds::from_corners(
            point(area.left() + linha.x_for_index(faixa.start), area.top()),
            point(area.left() + linha.x_for_index(faixa.end), area.bottom()),
        ))
    }

    fn character_index_for_point(&mut self, ponto: Point<Pixels>, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        let area = self.area?;
        let linha = self.linha.as_ref()?;
        let indice = linha.index_for_x(ponto.x - area.left())?;
        Some(self.para_utf16(indice.min(self.texto.len())))
    }
}

impl Focusable for CampoDeTexto {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.foco.clone()
    }
}

impl Render for CampoDeTexto {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let borda = if self.foco.is_focused(window) { tema::destaque() } else { tema::borda_de_controle() };
        div()
            .key_context(CONTEXTO)
            .track_focus(&self.foco)
            .cursor(CursorStyle::IBeam)
            .on_action(cx.listener(Self::apagar))
            .on_action(cx.listener(Self::apagar_adiante))
            .on_action(cx.listener(Self::esquerda))
            .on_action(cx.listener(Self::direita))
            .on_action(cx.listener(Self::inicio))
            .on_action(cx.listener(Self::fim))
            .on_action(cx.listener(Self::colar))
            .on_action(cx.listener(Self::confirmar))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::ao_clicar))
            .w_full()
            .h(px(32.))
            .px_2()
            .flex()
            .items_center()
            .overflow_hidden()
            .bg(tema::elevado())
            .border_1()
            .border_color(borda)
            .rounded_md()
            .text_size(px(tema::TAMANHO_DO_TEXTO))
            .line_height(px(tema::ALTURA_DA_LINHA))
            .text_color(tema::texto())
            .child(LinhaDoCampo { campo: cx.entity() })
    }
}

/// Desenha a linha do campo e avisa a janela de que ele recebe texto.
struct LinhaDoCampo {
    campo: Entity<CampoDeTexto>,
}

struct LinhaPronta {
    linha: Option<ShapedLine>,
    cursor: PaintQuad,
}

impl IntoElement for LinhaDoCampo {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for LinhaDoCampo {
    type RequestLayoutState = ();
    type PrepaintState = LinhaPronta;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let mut estilo = Style::default();
        estilo.size.width = relative(1.).into();
        estilo.size.height = window.line_height().into();
        (window.request_layout(estilo, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        area: Bounds<Pixels>,
        _: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        let campo = self.campo.read(cx);
        let estilo = window.text_style();
        let (mostrado, cor): (SharedString, _) = if campo.texto.is_empty() {
            (campo.dica.clone(), tema::texto_apagado().into())
        } else {
            (campo.texto.clone().into(), estilo.color)
        };

        let trecho =
            TextRun { len: mostrado.len(), font: estilo.font(), color: cor, background_color: None, underline: None, strikethrough: None };
        // O trecho em composição aparece sublinhado, como o sistema costuma mostrar.
        let trechos = match campo.em_composicao.as_ref().filter(|_| !campo.texto.is_empty()) {
            Some(faixa) => vec![
                TextRun { len: faixa.start, ..trecho.clone() },
                TextRun {
                    len: faixa.end - faixa.start,
                    underline: Some(UnderlineStyle { color: Some(trecho.color), thickness: px(1.), wavy: false }),
                    ..trecho.clone()
                },
                TextRun { len: mostrado.len() - faixa.end, ..trecho },
            ]
            .into_iter()
            .filter(|trecho| trecho.len > 0)
            .collect(),
            None => vec![trecho],
        };

        let tamanho = estilo.font_size.to_pixels(window.rem_size());
        let posicao_do_cursor = campo.cursor;
        let vazio = campo.texto.is_empty();
        let linha = window.text_system().shape_line(mostrado, tamanho, &trechos, None);
        let x = if vazio { px(0.) } else { linha.x_for_index(posicao_do_cursor) };
        let cursor = fill(Bounds::new(point(area.left() + x, area.top()), size(px(1.5), area.bottom() - area.top())), tema::destaque());
        LinhaPronta { linha: Some(linha), cursor }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        area: Bounds<Pixels>,
        _: &mut Self::RequestLayoutState,
        pronta: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let foco = self.campo.read(cx).foco.clone();
        window.handle_input(&foco, ElementInputHandler::new(area, self.campo.clone()), cx);

        let Some(linha) = pronta.linha.take() else { return };
        // Uma linha que não pôde ser desenhada não derruba a janela: o campo só fica em branco neste quadro.
        let _ = linha.paint(area.origin, window.line_height(), gpui::TextAlign::Left, None, window, cx);
        if foco.is_focused(window) {
            window.paint_quad(pronta.cursor.clone());
        }
        self.campo.update(cx, |campo, _| {
            campo.linha = Some(linha);
            campo.area = Some(area);
        });
    }
}

#[cfg(test)]
mod testes {
    use super::*;
    use gpui::TestAppContext;

    fn campo(cx: &mut TestAppContext, limite: usize) -> Entity<CampoDeTexto> {
        cx.new(|cx| CampoDeTexto::new("dica", limite, cx))
    }

    #[gpui::test]
    fn respeita_o_limite_em_caracteres_e_nao_em_bytes(cx: &mut TestAppContext) {
        let campo = campo(cx, 5);
        campo.update(cx, |campo, cx| campo.definir("ação e reação", cx));
        campo.read_with(cx, |campo, _| {
            assert_eq!(campo.texto(), "ação ");
            assert_eq!(campo.cursor, "ação ".len());
        });
    }

    #[gpui::test]
    fn quebra_de_linha_colada_vira_espaco(cx: &mut TestAppContext) {
        let campo = campo(cx, 40);
        campo.update(cx, |campo, cx| campo.definir("uma\r\nduas\ttres", cx));
        campo.read_with(cx, |campo, _| assert_eq!(campo.texto(), "uma  duas tres"));
    }

    #[gpui::test]
    fn o_cursor_anda_por_caractere_inteiro(cx: &mut TestAppContext) {
        let campo = campo(cx, 40);
        campo.update(cx, |campo, cx| {
            campo.definir("aé😀", cx);
            assert_eq!(campo.anterior(campo.cursor), "aé".len());
            assert_eq!(campo.anterior("aé".len()), "a".len());
            assert_eq!(campo.seguinte(0), 1);
            assert_eq!(campo.seguinte("aé".len()), "aé😀".len());
            // O sistema conversa em unidades UTF-16: o emoji vale duas.
            assert_eq!(campo.para_utf16(campo.texto.len()), 4);
            assert_eq!(campo.de_utf16(2), "aé".len());
            assert_eq!(campo.de_utf16(4), "aé😀".len());
        });
    }

    #[gpui::test]
    fn trocar_no_meio_mantem_o_resto(cx: &mut TestAppContext) {
        let campo = campo(cx, 10);
        campo.update(cx, |campo, cx| {
            campo.definir("abcdef", cx);
            let entraram = campo.trocar(2..4, "XYZ");
            assert_eq!((campo.texto(), entraram, campo.cursor), ("abXYZef", 3, 5));
            // Só cabem mais três caracteres.
            let entraram = campo.trocar(7..7, "12345");
            assert_eq!((campo.texto(), entraram), ("abXYZef123", 3));
        });
    }
}
