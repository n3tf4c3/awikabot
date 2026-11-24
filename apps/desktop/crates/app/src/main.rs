//! App de desktop do awikabot. Por ora é a prova do passo 1 da etapa 6: uma janela que pareia
//! com o servidor e conversa com um bot, com a resposta chegando aos poucos.

// Em release no Windows, o app não abre um console junto.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod campo;
mod janela;
mod tema;

use gpui::{App, Bounds, TitlebarOptions, WindowBounds, WindowOptions, prelude::*, px, size};
use gpui_platform::application;

use crate::janela::Janela;

fn main() {
    application().run(|cx: &mut App| {
        campo::registrar_teclas(cx);
        janela::registrar_teclas(cx);
        // Fechar a janela encerra o app.
        cx.on_window_closed(|cx, _| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();

        let limites = Bounds::centered(None, size(px(980.), px(680.)), cx);
        let opcoes = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(limites)),
            titlebar: Some(TitlebarOptions { title: Some("awikabot".into()), ..Default::default() }),
            window_min_size: Some(size(px(640.), px(420.))),
            ..Default::default()
        };
        // Sem janela não há app: uma falha aqui encerra com a mensagem do erro.
        cx.open_window(opcoes, |window, cx| cx.new(|cx| Janela::new(window, cx))).expect("abrir a janela do awikabot");
        cx.activate(true);
    });
}
