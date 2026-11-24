//! App de desktop do awikabot. Uma janela que pareia com o servidor, guarda a sessão no cofre
//! do sistema, conversa com os bots e mostra os pedidos de aprovação, com aviso do sistema
//! quando a janela não está na frente.

// Em release no Windows, o app não abre um console junto.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod campo;
#[cfg(any(windows, target_os = "macos"))]
mod cofre_do_sistema;
mod edicao;
mod janela;
mod tema;

use std::sync::Arc;

use awikabot_cliente::sessao::Cofre;

use gpui::{App, Bounds, TitlebarOptions, WindowBounds, WindowOptions, prelude::*, px, size};
use gpui_platform::application;

use crate::janela::Janela;

/// Onde a sessão fica guardada entre uma abertura e outra.
fn cofre() -> Arc<dyn Cofre> {
    #[cfg(any(windows, target_os = "macos"))]
    {
        Arc::new(cofre_do_sistema::CofreDoSistema::do_app())
    }
    // Num sistema sem cofre conhecido, a sessão vale só enquanto o app estiver aberto.
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        Arc::new(awikabot_cliente::sessao::CofreEmMemoria::default())
    }
}

fn main() {
    application().run(|cx: &mut App| {
        campo::registrar_teclas(cx);
        janela::registrar_teclas(cx);
        janela::identificar_o_app(cx);
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
            titlebar: Some(TitlebarOptions { title: Some(janela::NOME_DO_APP.into()), ..Default::default() }),
            window_min_size: Some(size(px(640.), px(420.))),
            ..Default::default()
        };
        // Sem janela não há app: uma falha aqui encerra com a mensagem do erro.
        let janela =
            cx.open_window(opcoes, |window, cx| cx.new(|cx| Janela::new(cofre(), window, cx))).expect("abrir a janela do awikabot");
        janela::ligar_avisos(janela, cx);
        cx.activate(true);
    });
}
