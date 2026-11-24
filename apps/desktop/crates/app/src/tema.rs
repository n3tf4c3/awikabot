//! Cores e medidas da interface. É o único módulo com cor literal.
//!
//! Os valores são os do tema escuro do termIAX, para os dois apps terem a mesma cara. Só os
//! valores vêm de lá; nenhum código.

use gpui::{Rgba, rgb};

/// Fundo da janela e da área central.
pub fn fundo() -> Rgba {
    rgb(0x1E1E1E)
}

/// Painel lateral.
pub fn painel() -> Rgba {
    rgb(0x212121)
}

/// Campos e botões secundários.
pub fn elevado() -> Rgba {
    rgb(0x262626)
}

pub fn sob_o_mouse() -> Rgba {
    rgb(0x2A2A2A)
}

pub fn selecionado() -> Rgba {
    rgb(0x373737)
}

pub fn divisoria() -> Rgba {
    rgb(0x303030)
}

pub fn borda_de_controle() -> Rgba {
    rgb(0x3A3A3A)
}

pub fn texto() -> Rgba {
    rgb(0xD8D8D8)
}

pub fn texto_forte() -> Rgba {
    rgb(0xF0F0F0)
}

pub fn texto_secundario() -> Rgba {
    rgb(0x9A9A9A)
}

/// Dicas dentro de campos vazios.
pub fn texto_apagado() -> Rgba {
    rgb(0x6E6E6E)
}

/// Botão principal, foco e cursor.
pub fn destaque() -> Rgba {
    rgb(0x5AA0F2)
}

pub fn texto_no_destaque() -> Rgba {
    rgb(0x111418)
}

pub fn estado_ok() -> Rgba {
    rgb(0x69C27E)
}

pub fn estado_de_aviso() -> Rgba {
    rgb(0xE9B452)
}

pub fn estado_de_erro() -> Rgba {
    rgb(0xF47B74)
}

/// Texto da interface, em pixels.
pub const TAMANHO_DO_TEXTO: f32 = 13.0;
/// Rótulos pequenos e a linha de estado.
pub const TAMANHO_PEQUENO: f32 = 11.5;
/// Altura de linha da interface: 1,35 vezes o texto.
pub const ALTURA_DA_LINHA: f32 = 18.0;
