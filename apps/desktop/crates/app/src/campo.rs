//! Campo de texto, de uma linha ou de várias.
//!
//! A GPUI não traz campo de texto pronto: quem quer um implementa `EntityInputHandler`, que é por
//! onde o sistema entrega o que a pessoa digita, inclusive acentos por tecla morta e o texto em
//! composição. A forma segue os exemplos `input` e `view_example` da própria GPUI.
//!
//! O que cada tecla faz com o texto está em `edicao.rs`, sem interface. Aqui ficam o foco, as
//! teclas, o mouse, a área de transferência e o desenho: quebra de linha, seleção, cursor e a
//! rolagem que mantém o cursor à vista.

use std::ops::Range;

use gpui::{
    App, AvailableSpace, Bounds, ClipboardItem, ContentMask, Context, CursorStyle, Element, ElementId, ElementInputHandler, Entity,
    EntityInputHandler, EventEmitter, FocusHandle, Focusable, GlobalElementId, Hsla, KeyBinding, LayoutId, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, PaintQuad, Pixels, Point, ScrollWheelEvent, SharedString, Style, TextAlign, TextRun, UTF16Selection,
    UnderlineStyle, Window, WrappedLine, actions, div, fill, point, prelude::*, px, relative, size,
};

use crate::edicao::{Edicao, Movimento};
use crate::tema;

actions!(
    campo_de_texto,
    [
        Apagar,
        ApagarAdiante,
        ApagarPalavra,
        ApagarPalavraAdiante,
        Esquerda,
        Direita,
        PalavraEsquerda,
        PalavraDireita,
        InicioDaLinha,
        FimDaLinha,
        Inicio,
        Fim,
        Acima,
        Abaixo,
        SelecionarEsquerda,
        SelecionarDireita,
        SelecionarPalavraEsquerda,
        SelecionarPalavraDireita,
        SelecionarInicioDaLinha,
        SelecionarFimDaLinha,
        SelecionarInicio,
        SelecionarFim,
        SelecionarAcima,
        SelecionarAbaixo,
        SelecionarTudo,
        Copiar,
        Recortar,
        Colar,
        Desfazer,
        Refazer,
        Confirmar,
        NovaLinha,
    ]
);

const CONTEXTO: &str = "CampoDeTexto";

/// A tecla dos atalhos de copiar, colar e desfazer: Command no macOS, Ctrl nos outros.
pub fn tecla_principal() -> &'static str {
    if cfg!(target_os = "macos") { "cmd" } else { "ctrl" }
}

/// Liga as teclas do campo. Chamado uma vez, na partida do app.
pub fn registrar_teclas(cx: &mut App) {
    let contexto = Some(CONTEXTO);
    let principal = tecla_principal();
    // No macOS anda-se por palavra com Option, e ao começo e ao fim com Command e as setas.
    let de_palavra = if cfg!(target_os = "macos") { "alt" } else { "ctrl" };
    let mut teclas = vec![
        KeyBinding::new("backspace", Apagar, contexto),
        KeyBinding::new("delete", ApagarAdiante, contexto),
        KeyBinding::new(&format!("{de_palavra}-backspace"), ApagarPalavra, contexto),
        KeyBinding::new(&format!("{de_palavra}-delete"), ApagarPalavraAdiante, contexto),
        KeyBinding::new("left", Esquerda, contexto),
        KeyBinding::new("right", Direita, contexto),
        KeyBinding::new("shift-left", SelecionarEsquerda, contexto),
        KeyBinding::new("shift-right", SelecionarDireita, contexto),
        KeyBinding::new(&format!("{de_palavra}-left"), PalavraEsquerda, contexto),
        KeyBinding::new(&format!("{de_palavra}-right"), PalavraDireita, contexto),
        KeyBinding::new(&format!("{de_palavra}-shift-left"), SelecionarPalavraEsquerda, contexto),
        KeyBinding::new(&format!("{de_palavra}-shift-right"), SelecionarPalavraDireita, contexto),
        KeyBinding::new("home", InicioDaLinha, contexto),
        KeyBinding::new("end", FimDaLinha, contexto),
        KeyBinding::new("shift-home", SelecionarInicioDaLinha, contexto),
        KeyBinding::new("shift-end", SelecionarFimDaLinha, contexto),
        KeyBinding::new("up", Acima, contexto),
        KeyBinding::new("down", Abaixo, contexto),
        KeyBinding::new("shift-up", SelecionarAcima, contexto),
        KeyBinding::new("shift-down", SelecionarAbaixo, contexto),
        KeyBinding::new(&format!("{principal}-a"), SelecionarTudo, contexto),
        KeyBinding::new(&format!("{principal}-c"), Copiar, contexto),
        KeyBinding::new(&format!("{principal}-x"), Recortar, contexto),
        KeyBinding::new(&format!("{principal}-v"), Colar, contexto),
        KeyBinding::new(&format!("{principal}-z"), Desfazer, contexto),
        KeyBinding::new(&format!("{principal}-shift-z"), Refazer, contexto),
        KeyBinding::new("enter", Confirmar, contexto),
        KeyBinding::new("shift-enter", NovaLinha, contexto),
    ];
    if cfg!(target_os = "macos") {
        teclas.extend([
            KeyBinding::new("cmd-left", InicioDaLinha, contexto),
            KeyBinding::new("cmd-right", FimDaLinha, contexto),
            KeyBinding::new("cmd-shift-left", SelecionarInicioDaLinha, contexto),
            KeyBinding::new("cmd-shift-right", SelecionarFimDaLinha, contexto),
            KeyBinding::new("cmd-up", Inicio, contexto),
            KeyBinding::new("cmd-down", Fim, contexto),
            KeyBinding::new("cmd-shift-up", SelecionarInicio, contexto),
            KeyBinding::new("cmd-shift-down", SelecionarFim, contexto),
        ]);
    } else {
        teclas.extend([
            KeyBinding::new("ctrl-home", Inicio, contexto),
            KeyBinding::new("ctrl-end", Fim, contexto),
            KeyBinding::new("ctrl-shift-home", SelecionarInicio, contexto),
            KeyBinding::new("ctrl-shift-end", SelecionarFim, contexto),
            KeyBinding::new("ctrl-y", Refazer, contexto),
        ]);
    }
    cx.bind_keys(teclas);
}

/// A pessoa apertou Enter no campo.
pub struct Confirmado;

fn maior(a: Pixels, b: Pixels) -> Pixels {
    if a > b { a } else { b }
}

fn menor(a: Pixels, b: Pixels) -> Pixels {
    if a < b { a } else { b }
}

/// O texto como foi desenhado da última vez: é por ele que um ponto da tela vira posição no
/// texto, e uma posição no texto vira ponto da tela.
struct Desenho {
    area: Bounds<Pixels>,
    /// Um item por parágrafo; cada um pode ocupar várias linhas da tela.
    paragrafos: Vec<WrappedLine>,
    /// Onde cada parágrafo começa no texto, em bytes.
    inicios: Vec<usize>,
    /// A que altura cada parágrafo começa, a partir do alto do texto.
    topos: Vec<Pixels>,
    altura_da_linha: Pixels,
    altura: Pixels,
    largura: Pixels,
    /// O que está desenhado é a dica do campo vazio.
    vazio: bool,
}

impl Desenho {
    /// Onde fica uma posição do texto, a partir do canto do texto, sem contar a rolagem.
    fn ponto_de(&self, posicao: usize) -> Point<Pixels> {
        if self.vazio {
            return point(px(0.), px(0.));
        }
        let qual = self.inicios.iter().rposition(|inicio| *inicio <= posicao).unwrap_or(0);
        let (Some(paragrafo), Some(inicio), Some(topo)) = (self.paragrafos.get(qual), self.inicios.get(qual), self.topos.get(qual)) else {
            return point(px(0.), px(0.));
        };
        let no_paragrafo = (posicao - inicio).min(paragrafo.len());
        let local = paragrafo.position_for_index(no_paragrafo, self.altura_da_linha).unwrap_or_default();
        point(local.x, *topo + local.y)
    }

    /// A posição do texto mais próxima de um ponto dado a partir do canto do texto.
    fn posicao_em(&self, ponto: Point<Pixels>) -> usize {
        if self.vazio {
            return 0;
        }
        let qual = self.topos.iter().rposition(|topo| *topo <= ponto.y).unwrap_or(0);
        let (Some(paragrafo), Some(inicio), Some(topo)) = (self.paragrafos.get(qual), self.inicios.get(qual), self.topos.get(qual)) else {
            return 0;
        };
        // Abaixo da última linha do parágrafo, vale a última linha dele.
        let ultima_linha = paragrafo.size(self.altura_da_linha).height - px(1.);
        let local = point(maior(ponto.x, px(0.)), menor(maior(ponto.y - *topo, px(0.)), ultima_linha));
        let (Ok(no_paragrafo) | Err(no_paragrafo)) = paragrafo.closest_index_for_position(local, self.altura_da_linha);
        inicio + no_paragrafo.min(paragrafo.len())
    }
}

pub struct CampoDeTexto {
    foco: FocusHandle,
    edicao: Edicao,
    dica: SharedString,
    /// Trecho ainda em composição pelo sistema (tecla morta, teclado de outro idioma).
    em_composicao: Option<Range<usize>>,
    /// Quantas linhas o campo mostra, no mínimo e no máximo. O campo de uma linha tem 1 e 1.
    linhas: (usize, usize),
    /// Na área de texto: Enter confirma (e Shift+Enter quebra a linha), ou Enter quebra a linha.
    enter_confirma: bool,
    desenho: Option<Desenho>,
    /// Quanto do texto ficou para fora, à esquerda (campo de uma linha) ou acima (área).
    rolagem: Point<Pixels>,
    /// O próximo desenho ajusta a rolagem para o cursor aparecer.
    revelar_cursor: bool,
    /// A coluna que as setas para cima e para baixo tentam manter.
    coluna: Option<Pixels>,
    arrastando: bool,
}

impl EventEmitter<Confirmado> for CampoDeTexto {}

impl CampoDeTexto {
    /// Campo de uma linha. Enter confirma.
    pub fn new(dica: impl Into<SharedString>, limite: usize, cx: &mut Context<Self>) -> Self {
        Self::montar(dica.into(), Edicao::new(limite, false), (1, 1), true, cx)
    }

    /// Área de texto que cresce de `minimas` a `maximas` linhas e rola depois disso.
    pub fn area(
        dica: impl Into<SharedString>,
        limite: usize,
        (minimas, maximas): (usize, usize),
        enter_confirma: bool,
        cx: &mut Context<Self>,
    ) -> Self {
        let minimas = minimas.max(1);
        Self::montar(dica.into(), Edicao::new(limite, true), (minimas, maximas.max(minimas).max(2)), enter_confirma, cx)
    }

    fn montar(dica: SharedString, edicao: Edicao, linhas: (usize, usize), enter_confirma: bool, cx: &mut Context<Self>) -> Self {
        Self {
            foco: cx.focus_handle(),
            edicao,
            dica,
            em_composicao: None,
            linhas,
            enter_confirma,
            desenho: None,
            rolagem: point(px(0.), px(0.)),
            revelar_cursor: true,
            coluna: None,
            arrastando: false,
        }
    }

    pub fn texto(&self) -> &str {
        self.edicao.texto()
    }

    /// Troca o conteúdo inteiro e põe o cursor no fim. O limite vale aqui também.
    pub fn definir(&mut self, texto: &str, cx: &mut Context<Self>) {
        self.edicao.definir(texto);
        self.em_composicao = None;
        self.mudou(cx);
    }

    fn de_uma_linha(&self) -> bool {
        self.linhas.1 == 1
    }

    /// Depois de qualquer mudança no texto ou no cursor.
    fn mudou(&mut self, cx: &mut Context<Self>) {
        self.revelar_cursor = true;
        self.coluna = None;
        cx.notify();
    }

    fn ao_mover(&mut self, movimento: Movimento, selecionando: bool, cx: &mut Context<Self>) {
        self.edicao.mover(movimento, selecionando);
        self.mudou(cx);
    }

    /// Seta para cima ou para baixo: só a área de texto tem outra linha para onde ir.
    fn ao_mover_na_vertical(&mut self, para_baixo: bool, selecionando: bool, cx: &mut Context<Self>) {
        if self.de_uma_linha() {
            cx.propagate();
            return;
        }
        let Some(desenho) = &self.desenho else { return };
        let atual = desenho.ponto_de(self.edicao.cursor());
        let coluna = *self.coluna.get_or_insert(atual.x);
        let altura_da_linha = desenho.altura_da_linha;
        let alvo = if para_baixo {
            let abaixo = atual.y + altura_da_linha * 1.5;
            if abaixo >= desenho.altura { self.edicao.texto().len() } else { desenho.posicao_em(point(coluna, abaixo)) }
        } else if atual.y < altura_da_linha {
            0
        } else {
            desenho.posicao_em(point(coluna, atual.y - altura_da_linha * 0.5))
        };
        self.edicao.mover_para(alvo, selecionando);
        self.revelar_cursor = true;
        cx.notify();
    }

    fn apagar(&mut self, para_tras: bool, por_palavra: bool, cx: &mut Context<Self>) {
        if por_palavra {
            self.edicao.apagar_palavra(para_tras);
        } else {
            self.edicao.apagar(para_tras);
        }
        self.em_composicao = None;
        self.mudou(cx);
    }

    fn selecionar_tudo(&mut self, _: &SelecionarTudo, _: &mut Window, cx: &mut Context<Self>) {
        self.edicao.selecionar_tudo();
        self.mudou(cx);
    }

    fn copiar(&mut self, _: &Copiar, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(copiado) = self.edicao.copiar() {
            cx.write_to_clipboard(ClipboardItem::new_string(copiado));
        }
    }

    fn recortar(&mut self, _: &Recortar, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(recortado) = self.edicao.recortar() {
            cx.write_to_clipboard(ClipboardItem::new_string(recortado));
            self.mudou(cx);
        }
    }

    fn colar(&mut self, _: &Colar, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(colado) = cx.read_from_clipboard().and_then(|item| item.text()) {
            self.edicao.inserir(&colado);
            self.em_composicao = None;
            self.mudou(cx);
        }
    }

    fn desfazer(&mut self, _: &Desfazer, _: &mut Window, cx: &mut Context<Self>) {
        if self.edicao.desfazer() {
            self.em_composicao = None;
            self.mudou(cx);
        }
    }

    fn refazer(&mut self, _: &Refazer, _: &mut Window, cx: &mut Context<Self>) {
        if self.edicao.refazer() {
            self.em_composicao = None;
            self.mudou(cx);
        }
    }

    fn confirmar(&mut self, _: &Confirmar, _: &mut Window, cx: &mut Context<Self>) {
        if self.de_uma_linha() || self.enter_confirma {
            cx.emit(Confirmado);
        } else {
            self.edicao.inserir("\n");
            self.mudou(cx);
        }
    }

    fn nova_linha(&mut self, _: &NovaLinha, _: &mut Window, cx: &mut Context<Self>) {
        if self.de_uma_linha() {
            return;
        }
        self.edicao.inserir("\n");
        self.mudou(cx);
    }

    /// A posição do texto sob um ponto da janela.
    fn posicao_no_ponto(&self, ponto: Point<Pixels>) -> usize {
        match &self.desenho {
            Some(desenho) => desenho.posicao_em(ponto - desenho.area.origin + self.rolagem),
            None => self.edicao.texto().len(),
        }
    }

    fn ao_apertar(&mut self, evento: &MouseDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let posicao = self.posicao_no_ponto(evento.position);
        match evento.click_count {
            0 | 1 => self.edicao.mover_para(posicao, evento.modifiers.shift),
            2 => self.edicao.selecionar_palavra(posicao),
            _ => self.edicao.selecionar_tudo(),
        }
        self.arrastando = evento.click_count <= 1;
        self.mudou(cx);
    }

    fn ao_arrastar(&mut self, evento: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if !self.arrastando || evento.pressed_button != Some(MouseButton::Left) {
            return;
        }
        let posicao = self.posicao_no_ponto(evento.position);
        if posicao != self.edicao.cursor() {
            self.edicao.mover_para(posicao, true);
            self.mudou(cx);
        }
    }

    fn ao_soltar(&mut self, _: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        self.arrastando = false;
    }

    /// A roda do mouse só é da área de texto quando há texto fora de vista; senão, rola o que está em volta.
    fn ao_rolar(&mut self, evento: &ScrollWheelEvent, window: &mut Window, cx: &mut Context<Self>) {
        let Some(desenho) = &self.desenho else { return };
        if self.de_uma_linha() || desenho.altura <= desenho.area.size.height {
            return;
        }
        self.rolagem.y -= evento.delta.pixel_delta(window.line_height()).y;
        cx.stop_propagation();
        cx.notify();
    }

    /// A faixa que o sistema quer trocar: a que ele disse, o texto em composição, ou a seleção.
    fn faixa_do_sistema(&self, faixa_utf16: Option<&Range<usize>>) -> Range<usize> {
        faixa_utf16.map(|faixa| self.edicao.faixa_de_utf16(faixa)).or(self.em_composicao.clone()).unwrap_or(self.edicao.selecao())
    }

    /// Monta o texto como vai para a tela: cores, seleção, composição e quebra de linha.
    fn compor(&self, area: Bounds<Pixels>, window: &Window) -> Desenho {
        let estilo = window.text_style();
        let altura_da_linha = window.line_height();
        let tamanho = estilo.font_size.to_pixels(window.rem_size());
        let vazio = self.edicao.texto().is_empty();
        let (mostrado, cor): (SharedString, Hsla) =
            if vazio { (self.dica.clone(), tema::texto_apagado().into()) } else { (self.edicao.texto().to_owned().into(), estilo.color) };
        let base =
            TextRun { len: mostrado.len(), font: estilo.font(), color: cor, background_color: None, underline: None, strikethrough: None };
        let trechos = if vazio { vec![base] } else { trechos(&base, self.edicao.selecao(), self.em_composicao.clone()) };
        let quebra = (!self.de_uma_linha()).then_some(area.size.width);
        // Um texto que não pôde ser preparado não derruba a janela: o campo fica em branco neste quadro.
        let paragrafos: Vec<WrappedLine> = window
            .text_system()
            .shape_text(mostrado, tamanho, &trechos, quebra, None)
            .map(|linhas| linhas.into_iter().collect())
            .unwrap_or_default();

        let (mut inicios, mut topos) = (Vec::with_capacity(paragrafos.len()), Vec::with_capacity(paragrafos.len()));
        let (mut inicio, mut topo, mut largura) = (0, px(0.), px(0.));
        for paragrafo in &paragrafos {
            inicios.push(inicio);
            topos.push(topo);
            inicio += paragrafo.len() + '\n'.len_utf8();
            topo += paragrafo.size(altura_da_linha).height;
            largura = maior(largura, paragrafo.width());
        }
        Desenho { area, paragrafos, inicios, topos, altura_da_linha, altura: topo, largura, vazio }
    }

    /// Ajusta a rolagem ao texto que vai ser desenhado: mostra o cursor, se foi pedido, e não deixa sobrar vazio.
    fn acertar_rolagem(&mut self, desenho: &Desenho) {
        let visivel = desenho.area.size;
        let folga = px(2.);
        if self.revelar_cursor {
            self.revelar_cursor = false;
            let cursor = desenho.ponto_de(self.edicao.cursor());
            if self.de_uma_linha() {
                self.rolagem.x = menor(self.rolagem.x, cursor.x);
                self.rolagem.x = maior(self.rolagem.x, cursor.x + folga - visivel.width);
            } else {
                self.rolagem.y = menor(self.rolagem.y, cursor.y);
                self.rolagem.y = maior(self.rolagem.y, cursor.y + desenho.altura_da_linha - visivel.height);
            }
        }
        let (sobra_x, sobra_y) = if desenho.vazio {
            (px(0.), px(0.))
        } else if self.de_uma_linha() {
            (maior(desenho.largura + folga - visivel.width, px(0.)), px(0.))
        } else {
            (px(0.), maior(desenho.altura - visivel.height, px(0.)))
        };
        self.rolagem = point(menor(maior(self.rolagem.x, px(0.)), sobra_x), menor(maior(self.rolagem.y, px(0.)), sobra_y));
    }
}

/// Divide o texto em trechos de mesma aparência: selecionado, em composição, ou comum.
fn trechos(base: &TextRun, selecao: Range<usize>, composicao: Option<Range<usize>>) -> Vec<TextRun> {
    let tamanho = base.len;
    let mut cortes = vec![0, tamanho, selecao.start, selecao.end];
    if let Some(composicao) = &composicao {
        cortes.extend([composicao.start, composicao.end]);
    }
    cortes.retain(|corte| *corte <= tamanho);
    cortes.sort_unstable();
    cortes.dedup();
    cortes
        .windows(2)
        .map(|par| {
            let (inicio, fim) = (par[0], par[1]);
            let selecionado = selecao.start <= inicio && fim <= selecao.end;
            let em_composicao = composicao.as_ref().is_some_and(|faixa| faixa.start <= inicio && fim <= faixa.end);
            TextRun {
                len: fim - inicio,
                background_color: selecionado.then(|| tema::selecao_de_texto().into()),
                // O trecho em composição aparece sublinhado, como o sistema costuma mostrar.
                underline: em_composicao.then(|| UnderlineStyle { color: Some(base.color), thickness: px(1.), wavy: false }),
                ..base.clone()
            }
        })
        .collect()
}

impl EntityInputHandler for CampoDeTexto {
    fn text_for_range(
        &mut self,
        faixa_utf16: Range<usize>,
        faixa_real: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let faixa = self.edicao.faixa_de_utf16(&faixa_utf16);
        faixa_real.replace(self.edicao.faixa_para_utf16(&faixa));
        Some(self.edicao.texto()[faixa].to_owned())
    }

    fn selected_text_range(&mut self, _: bool, _: &mut Window, _: &mut Context<Self>) -> Option<UTF16Selection> {
        Some(UTF16Selection { range: self.edicao.faixa_para_utf16(&self.edicao.selecao()), reversed: self.edicao.selecao_invertida() })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.em_composicao.as_ref().map(|faixa| self.edicao.faixa_para_utf16(faixa))
    }

    fn unmark_text(&mut self, _: &mut Window, _: &mut Context<Self>) {
        self.em_composicao = None;
    }

    fn replace_text_in_range(&mut self, faixa_utf16: Option<Range<usize>>, novo: &str, _: &mut Window, cx: &mut Context<Self>) {
        if faixa_utf16.is_none() && self.em_composicao.is_none() {
            // O caso comum: a pessoa digitou, e o texto entra no cursor ou no lugar da seleção.
            self.edicao.inserir(novo);
        } else {
            self.edicao.trocar_faixa(self.faixa_do_sistema(faixa_utf16.as_ref()), novo);
        }
        self.em_composicao = None;
        self.mudou(cx);
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        faixa_utf16: Option<Range<usize>>,
        novo: &str,
        _nova_selecao_utf16: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let faixa = self.faixa_do_sistema(faixa_utf16.as_ref());
        let inicio = faixa.start;
        let entraram = self.edicao.trocar_faixa(faixa, novo);
        self.em_composicao = (entraram > 0).then_some(inicio..inicio + entraram);
        self.mudou(cx);
    }

    fn bounds_for_range(
        &mut self,
        faixa_utf16: Range<usize>,
        area: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let desenho = self.desenho.as_ref()?;
        let faixa = self.edicao.faixa_de_utf16(&faixa_utf16);
        let canto = area.origin - self.rolagem;
        let (inicio, fim) = (desenho.ponto_de(faixa.start), desenho.ponto_de(faixa.end));
        Some(Bounds::from_corners(canto + inicio, canto + point(fim.x, fim.y + desenho.altura_da_linha)))
    }

    fn character_index_for_point(&mut self, ponto: Point<Pixels>, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        self.desenho.as_ref()?;
        Some(self.edicao.para_utf16(self.posicao_no_ponto(ponto)))
    }
}

impl Focusable for CampoDeTexto {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.foco.clone()
    }
}

/// Liga várias ações de movimento ao mesmo tratador, cada uma com o seu movimento.
macro_rules! com_movimentos {
    ($elemento:expr, $cx:expr, $( $acao:ty => $movimento:expr, $selecionando:expr; )*) => {{
        let elemento = $elemento;
        $( let elemento = elemento.on_action($cx.listener(|campo: &mut CampoDeTexto, _: &$acao, _, cx| campo.ao_mover($movimento, $selecionando, cx))); )*
        elemento
    }};
}

impl Render for CampoDeTexto {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let borda = if self.foco.is_focused(window) { tema::destaque() } else { tema::borda_de_controle() };
        let de_uma_linha = self.de_uma_linha();
        let base = div()
            .key_context(CONTEXTO)
            .track_focus(&self.foco)
            .cursor(CursorStyle::IBeam)
            .on_action(cx.listener(|campo, _: &Apagar, _, cx| campo.apagar(true, false, cx)))
            .on_action(cx.listener(|campo, _: &ApagarAdiante, _, cx| campo.apagar(false, false, cx)))
            .on_action(cx.listener(|campo, _: &ApagarPalavra, _, cx| campo.apagar(true, true, cx)))
            .on_action(cx.listener(|campo, _: &ApagarPalavraAdiante, _, cx| campo.apagar(false, true, cx)))
            .on_action(cx.listener(|campo, _: &Acima, _, cx| campo.ao_mover_na_vertical(false, false, cx)))
            .on_action(cx.listener(|campo, _: &Abaixo, _, cx| campo.ao_mover_na_vertical(true, false, cx)))
            .on_action(cx.listener(|campo, _: &SelecionarAcima, _, cx| campo.ao_mover_na_vertical(false, true, cx)))
            .on_action(cx.listener(|campo, _: &SelecionarAbaixo, _, cx| campo.ao_mover_na_vertical(true, true, cx)))
            .on_action(cx.listener(Self::selecionar_tudo))
            .on_action(cx.listener(Self::copiar))
            .on_action(cx.listener(Self::recortar))
            .on_action(cx.listener(Self::colar))
            .on_action(cx.listener(Self::desfazer))
            .on_action(cx.listener(Self::refazer))
            .on_action(cx.listener(Self::confirmar))
            .on_action(cx.listener(Self::nova_linha))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::ao_apertar))
            .on_mouse_move(cx.listener(Self::ao_arrastar))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::ao_soltar))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::ao_soltar))
            .on_scroll_wheel(cx.listener(Self::ao_rolar));
        let base = com_movimentos!(base, cx,
            Esquerda => Movimento::Esquerda, false;
            Direita => Movimento::Direita, false;
            PalavraEsquerda => Movimento::PalavraEsquerda, false;
            PalavraDireita => Movimento::PalavraDireita, false;
            InicioDaLinha => Movimento::InicioDaLinha, false;
            FimDaLinha => Movimento::FimDaLinha, false;
            Inicio => Movimento::Inicio, false;
            Fim => Movimento::Fim, false;
            SelecionarEsquerda => Movimento::Esquerda, true;
            SelecionarDireita => Movimento::Direita, true;
            SelecionarPalavraEsquerda => Movimento::PalavraEsquerda, true;
            SelecionarPalavraDireita => Movimento::PalavraDireita, true;
            SelecionarInicioDaLinha => Movimento::InicioDaLinha, true;
            SelecionarFimDaLinha => Movimento::FimDaLinha, true;
            SelecionarInicio => Movimento::Inicio, true;
            SelecionarFim => Movimento::Fim, true;
        );
        base.w_full()
            .px_2()
            .overflow_hidden()
            .bg(tema::elevado())
            .border_1()
            .border_color(borda)
            .rounded_md()
            .text_size(px(tema::TAMANHO_DO_TEXTO))
            .line_height(px(tema::ALTURA_DA_LINHA))
            .text_color(tema::texto())
            .when(de_uma_linha, |campo| campo.h(px(32.)).flex().items_center())
            .when(!de_uma_linha, |campo| campo.py(px(6.)))
            .child(TextoDoCampo { campo: cx.entity() })
    }
}

/// Desenha o texto do campo e avisa a janela de que ele recebe texto.
struct TextoDoCampo {
    campo: Entity<CampoDeTexto>,
}

struct TextoPronto {
    desenho: Option<Desenho>,
    cursor: PaintQuad,
}

impl IntoElement for TextoDoCampo {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for TextoDoCampo {
    type RequestLayoutState = ();
    type PrepaintState = TextoPronto;

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
        let campo = self.campo.read(cx);
        let altura_da_linha = window.line_height();
        let mut estilo = Style::default();
        estilo.size.width = relative(1.).into();
        if campo.de_uma_linha() {
            estilo.size.height = altura_da_linha.into();
            return (window.request_layout(estilo, [], cx), ());
        }

        // A altura da área depende de quantas linhas o texto ocupa na largura que ela tiver.
        let (minimas, maximas) = campo.linhas;
        let texto: SharedString = campo.edicao.texto().to_owned().into();
        let do_texto = window.text_style();
        let (fonte, cor) = (do_texto.font(), do_texto.color);
        let tamanho = do_texto.font_size.to_pixels(window.rem_size());
        let medida = window.request_measured_layout(estilo, move |conhecido, disponivel, window, _| {
            let largura = conhecido.width.unwrap_or(match disponivel.width {
                AvailableSpace::Definite(largura) => largura,
                AvailableSpace::MinContent | AvailableSpace::MaxContent => px(320.),
            });
            let trecho =
                TextRun { len: texto.len(), font: fonte.clone(), color: cor, background_color: None, underline: None, strikethrough: None };
            let ocupadas = window
                .text_system()
                .shape_text(texto.clone(), tamanho, &[trecho], Some(largura), None)
                .map_or(1, |paragrafos| paragrafos.iter().map(|paragrafo| paragrafo.wrap_boundaries().len() + 1).sum::<usize>());
            size(largura, altura_da_linha * ocupadas.clamp(minimas, maximas) as f32)
        });
        (medida, ())
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
        let desenho = self.campo.read(cx).compor(area, window);
        self.campo.update(cx, |campo, _| campo.acertar_rolagem(&desenho));
        let campo = self.campo.read(cx);
        let onde = area.origin - campo.rolagem + desenho.ponto_de(campo.edicao.cursor());
        let cursor = fill(Bounds::new(onde, size(px(1.5), desenho.altura_da_linha)), tema::destaque());
        TextoPronto { desenho: Some(desenho), cursor }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        area: Bounds<Pixels>,
        _: &mut Self::RequestLayoutState,
        pronto: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let (foco, rolagem) = {
            let campo = self.campo.read(cx);
            (campo.foco.clone(), campo.rolagem)
        };
        window.handle_input(&foco, ElementInputHandler::new(area, self.campo.clone()), cx);

        let Some(desenho) = pronto.desenho.take() else { return };
        let canto = area.origin - rolagem;
        // O que rolou para fora do campo não é desenhado por cima da borda nem dos vizinhos.
        window.with_content_mask(Some(ContentMask { bounds: area }), |window| {
            for (paragrafo, topo) in desenho.paragrafos.iter().zip(&desenho.topos) {
                let origem = point(canto.x, canto.y + *topo);
                // Uma linha que não pôde ser desenhada não derruba a janela: fica em branco neste quadro.
                let _ = paragrafo.paint_background(origem, desenho.altura_da_linha, TextAlign::Left, None, window, cx);
                let _ = paragrafo.paint(origem, desenho.altura_da_linha, TextAlign::Left, None, window, cx);
            }
            if foco.is_focused(window) {
                window.paint_quad(pronto.cursor.clone());
            }
        });
        self.campo.update(cx, |campo, _| campo.desenho = Some(desenho));
    }
}

#[cfg(test)]
mod testes {
    //! O campo dirigido pelo teclado e pelo mouse, sem tela, pelo apoio de testes da GPUI. O que
    //! cada operação faz com o texto tem teste próprio em `edicao.rs`; aqui se confere a ligação:
    //! teclas, área de transferência, mouse, quebra de linha e rolagem.

    use std::cell::Cell;
    use std::rc::Rc;

    use gpui::{Modifiers, TestAppContext, VisualTestContext};

    use super::*;

    fn abrir(
        cx: &mut TestAppContext,
        criar: impl FnOnce(&mut Context<CampoDeTexto>) -> CampoDeTexto + 'static,
    ) -> (Entity<CampoDeTexto>, VisualTestContext) {
        cx.update(registrar_teclas);
        let janela = cx.add_window(|window, cx| {
            let campo = criar(cx);
            window.focus(&campo.focus_handle(cx), cx);
            campo
        });
        let mut cx = VisualTestContext::from_window(janela.into(), cx);
        let campo = janela.root(&mut cx).expect("raiz da janela");
        cx.run_until_parked();
        (campo, cx)
    }

    fn atalho(tecla: &str) -> String {
        format!("{}-{tecla}", tecla_principal())
    }

    fn area_do_texto(campo: &Entity<CampoDeTexto>, cx: &mut VisualTestContext) -> Bounds<Pixels> {
        cx.run_until_parked();
        campo.read_with(cx, |campo, _| campo.desenho.as_ref().expect("o campo já foi desenhado").area)
    }

    #[gpui::test]
    fn digita_seleciona_copia_recorta_cola_e_desfaz_pelo_teclado(cx: &mut TestAppContext) {
        let (campo, mut cx) = abrir(cx, |cx| CampoDeTexto::new("dica", 40, cx));
        cx.simulate_input("olá mundo");
        cx.simulate_keystrokes("shift-left shift-left shift-left shift-left shift-left");
        campo.read_with(&cx, |campo, _| assert_eq!(campo.edicao.selecionado(), "mundo"));

        cx.simulate_keystrokes(&atalho("c"));
        assert_eq!(cx.read_from_clipboard().and_then(|item| item.text()).as_deref(), Some("mundo"));
        campo.read_with(&cx, |campo, _| assert_eq!(campo.texto(), "olá mundo"));

        cx.simulate_keystrokes(&atalho("x"));
        campo.read_with(&cx, |campo, _| assert_eq!(campo.texto(), "olá "));
        cx.simulate_keystrokes(&format!("{0} {0}", atalho("v")));
        campo.read_with(&cx, |campo, _| assert_eq!(campo.texto(), "olá mundomundo"));

        cx.simulate_keystrokes(&atalho("z"));
        campo.read_with(&cx, |campo, _| assert_eq!(campo.texto(), "olá mundo"));
        cx.simulate_keystrokes(&atalho("shift-z"));
        campo.read_with(&cx, |campo, _| assert_eq!(campo.texto(), "olá mundomundo"));

        // Selecionar tudo e digitar troca o conteúdo; o que foi digitado entra no lugar da seleção.
        cx.simulate_keystrokes(&atalho("a"));
        cx.simulate_input("novo");
        campo.read_with(&cx, |campo, _| assert_eq!(campo.texto(), "novo"));
        cx.simulate_keystrokes("home delete end backspace");
        campo.read_with(&cx, |campo, _| assert_eq!(campo.texto(), "ov"));
    }

    #[gpui::test]
    fn copiar_sem_selecao_nao_mexe_na_area_de_transferencia(cx: &mut TestAppContext) {
        let (_campo, mut cx) = abrir(cx, |cx| CampoDeTexto::new("dica", 40, cx));
        cx.write_to_clipboard(ClipboardItem::new_string("o que já estava lá".into()));
        cx.simulate_input("texto");
        cx.simulate_keystrokes(&format!("{} {}", atalho("c"), atalho("x")));
        assert_eq!(cx.read_from_clipboard().and_then(|item| item.text()).as_deref(), Some("o que já estava lá"));
    }

    #[gpui::test]
    fn colar_respeita_o_limite_e_tira_a_quebra_de_linha_do_campo_de_uma_linha(cx: &mut TestAppContext) {
        let (campo, mut cx) = abrir(cx, |cx| CampoDeTexto::new("dica", 12, cx));
        cx.write_to_clipboard(ClipboardItem::new_string("uma\r\nduas\ntrês linhas".into()));
        cx.simulate_keystrokes(&atalho("v"));
        campo.read_with(&cx, |campo, _| assert_eq!(campo.texto(), "uma duas trê"));
    }

    #[gpui::test]
    fn na_area_enter_confirma_ou_quebra_a_linha_conforme_o_uso(cx: &mut TestAppContext) {
        // Como no campo de mensagem: Enter envia, Shift+Enter quebra a linha.
        let (campo, mut cx) = abrir(cx, |cx| CampoDeTexto::area("dica", 200, (1, 6), true, cx));
        let confirmacoes = Rc::new(Cell::new(0));
        let contador = confirmacoes.clone();
        let _assinatura = cx.update(|_, cx| cx.subscribe(&campo, move |_, _: &Confirmado, _| contador.set(contador.get() + 1)));
        cx.simulate_input("um");
        cx.simulate_keystrokes("shift-enter");
        cx.simulate_input("dois");
        campo.read_with(&cx, |campo, _| assert_eq!(campo.texto(), "um\ndois"));
        cx.simulate_keystrokes("enter");
        campo.read_with(&cx, |campo, _| assert_eq!(campo.texto(), "um\ndois", "Enter não entra no texto"));
        assert_eq!(confirmacoes.get(), 1);

        // Como no campo de instruções: Enter quebra a linha e nada é confirmado.
        let (campo, mut cx) = abrir(&mut cx, |cx| CampoDeTexto::area("dica", 200, (3, 8), false, cx));
        cx.simulate_input("um");
        cx.simulate_keystrokes("enter");
        cx.simulate_input("dois");
        campo.read_with(&cx, |campo, _| assert_eq!(campo.texto(), "um\ndois"));
        assert_eq!(confirmacoes.get(), 1);
    }

    #[gpui::test]
    fn no_campo_de_uma_linha_shift_enter_nao_faz_nada(cx: &mut TestAppContext) {
        let (campo, mut cx) = abrir(cx, |cx| CampoDeTexto::new("dica", 40, cx));
        cx.simulate_input("um");
        cx.simulate_keystrokes("shift-enter");
        cx.simulate_input("dois");
        campo.read_with(&cx, |campo, _| assert_eq!(campo.texto(), "umdois"));
    }

    #[gpui::test]
    fn as_setas_para_cima_e_para_baixo_andam_entre_as_linhas_da_area(cx: &mut TestAppContext) {
        let (campo, mut cx) = abrir(cx, |cx| CampoDeTexto::area("dica", 200, (1, 6), true, cx));
        cx.simulate_input("abc");
        cx.simulate_keystrokes("shift-enter");
        cx.simulate_input("def");
        cx.run_until_parked();

        cx.simulate_keystrokes("up");
        cx.run_until_parked();
        campo.read_with(&cx, |campo, _| assert_eq!(campo.edicao.cursor(), "abc".len(), "mesma coluna, linha de cima"));
        cx.simulate_keystrokes("down");
        cx.run_until_parked();
        campo.read_with(&cx, |campo, _| assert_eq!(campo.edicao.cursor(), "abc\ndef".len()));
        // Na primeira linha, para cima vai ao começo; na última, para baixo vai ao fim.
        cx.simulate_keystrokes("up");
        cx.run_until_parked();
        cx.simulate_keystrokes("up");
        campo.read_with(&cx, |campo, _| assert_eq!(campo.edicao.cursor(), 0));
        cx.simulate_keystrokes("shift-down");
        cx.run_until_parked();
        cx.simulate_keystrokes("shift-down");
        campo.read_with(&cx, |campo, _| assert_eq!(campo.edicao.selecionado(), "abc\ndef"));
    }

    #[gpui::test]
    fn clique_poe_o_cursor_arrastar_seleciona_e_duplo_clique_pega_a_palavra(cx: &mut TestAppContext) {
        let (campo, mut cx) = abrir(cx, |cx| CampoDeTexto::new("dica", 80, cx));
        cx.simulate_input("primeira segunda");
        let area = area_do_texto(&campo, &mut cx);
        let meio = area.top() + area.size.height / 2.;
        let (no_comeco, no_fim) = (point(area.left() + px(1.), meio), point(area.right() - px(2.), meio));

        cx.simulate_click(no_comeco, Modifiers::none());
        campo.read_with(&cx, |campo, _| assert_eq!((campo.edicao.cursor(), campo.edicao.tem_selecao()), (0, false)));
        cx.simulate_click(no_fim, Modifiers::none());
        campo.read_with(&cx, |campo, _| assert_eq!(campo.edicao.cursor(), "primeira segunda".len()));

        // Apertar no começo e arrastar até o fim seleciona tudo.
        cx.simulate_mouse_down(no_comeco, MouseButton::Left, Modifiers::none());
        cx.simulate_mouse_move(no_fim, MouseButton::Left, Modifiers::none());
        cx.simulate_mouse_up(no_fim, MouseButton::Left, Modifiers::none());
        campo.read_with(&cx, |campo, _| assert_eq!(campo.edicao.selecionado(), "primeira segunda"));
        // Depois de soltar, mexer o mouse não muda a seleção.
        cx.simulate_mouse_move(no_comeco, None, Modifiers::none());
        campo.read_with(&cx, |campo, _| assert_eq!(campo.edicao.selecionado(), "primeira segunda"));

        // Clique com Shift estende a seleção a partir do cursor.
        cx.simulate_click(no_comeco, Modifiers::none());
        cx.simulate_click(no_fim, Modifiers::shift());
        campo.read_with(&cx, |campo, _| assert_eq!(campo.edicao.selecionado(), "primeira segunda"));

        cx.simulate_event(MouseDownEvent {
            button: MouseButton::Left,
            position: no_comeco,
            modifiers: Modifiers::none(),
            click_count: 2,
            first_mouse: false,
        });
        campo.read_with(&cx, |campo, _| assert_eq!(campo.edicao.selecionado(), "primeira"));
    }

    #[gpui::test]
    fn o_campo_de_uma_linha_rola_para_o_cursor_ficar_a_vista(cx: &mut TestAppContext) {
        let (campo, mut cx) = abrir(cx, |cx| CampoDeTexto::new("dica", 4000, cx));
        cx.simulate_input(&"palavra comprida ".repeat(120));
        cx.run_until_parked();
        let cursor_a_vista = |campo: &CampoDeTexto| {
            let desenho = campo.desenho.as_ref().expect("desenhado");
            let x = desenho.ponto_de(campo.edicao.cursor()).x - campo.rolagem.x;
            x >= px(0.) && x <= desenho.area.size.width
        };
        campo.read_with(&cx, |campo, _| {
            assert!(campo.rolagem.x > px(0.), "o texto não cabe: o começo tem de ter saído pela esquerda");
            assert!(cursor_a_vista(campo), "o cursor, no fim do texto, tem de estar dentro do campo");
        });
        cx.simulate_keystrokes("home");
        cx.run_until_parked();
        campo.read_with(&cx, |campo, _| {
            assert_eq!(campo.rolagem.x, px(0.));
            assert!(cursor_a_vista(campo));
        });
    }

    #[gpui::test]
    fn a_area_cresce_ate_o_maximo_de_linhas_e_depois_rola(cx: &mut TestAppContext) {
        let (campo, mut cx) = abrir(cx, |cx| CampoDeTexto::area("dica", 4000, (1, 4), false, cx));
        let altura = |campo: &Entity<CampoDeTexto>, cx: &mut VisualTestContext| area_do_texto(campo, cx).size.height;
        let de_uma = altura(&campo, &mut cx);

        cx.simulate_input("a");
        cx.simulate_keystrokes("enter");
        cx.simulate_input("b");
        assert_eq!(altura(&campo, &mut cx), de_uma * 2., "duas linhas de texto, duas linhas de altura");

        cx.simulate_keystrokes("enter enter enter enter enter enter");
        cx.simulate_input("fim");
        assert_eq!(altura(&campo, &mut cx), de_uma * 4., "a altura para no máximo de linhas");
        campo.read_with(&cx, |campo, _| {
            let desenho = campo.desenho.as_ref().expect("desenhado");
            assert!(campo.rolagem.y > px(0.), "o começo do texto rolou para cima");
            let y = desenho.ponto_de(campo.edicao.cursor()).y - campo.rolagem.y;
            assert!(y >= px(0.) && y + desenho.altura_da_linha <= desenho.area.size.height, "o cursor continua à vista");
        });

        // Um texto longo sem quebra de linha é quebrado na largura da área, em vez de sumir pela direita.
        campo.update(&mut cx, |campo, cx| campo.definir(&"palavra ".repeat(200), cx));
        assert_eq!(altura(&campo, &mut cx), de_uma * 4.);
        campo.read_with(&cx, |campo, _| {
            let desenho = campo.desenho.as_ref().expect("desenhado");
            assert!(desenho.altura > desenho.area.size.height, "o texto ocupa mais linhas do que cabem");
            assert!(desenho.largura <= desenho.area.size.width, "nenhuma linha passa da largura da área");
        });
    }
}
