//! Cores e medidas da interface. É o único módulo com cor literal.
//!
//! O tema escuro repete os valores do tema escuro do termIAX, para os dois apps terem a mesma
//! cara. Só os valores vêm de lá; nenhum código. O termIAX não tem tema claro próprio, então os
//! valores do claro são daqui, com os mesmos papéis e o contraste conferido em teste.

use std::sync::atomic::{AtomicBool, Ordering};

use gpui::{Rgba, WindowAppearance, rgb};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tema {
    Escuro,
    Claro,
}

struct Paleta {
    fundo: u32,
    painel: u32,
    elevado: u32,
    sob_o_mouse: u32,
    selecionado: u32,
    divisoria: u32,
    borda_de_controle: u32,
    texto: u32,
    texto_forte: u32,
    texto_secundario: u32,
    texto_apagado: u32,
    destaque: u32,
    texto_no_destaque: u32,
    selecao_de_texto: u32,
    estado_ok: u32,
    estado_de_aviso: u32,
    estado_de_erro: u32,
}

const ESCURA: Paleta = Paleta {
    fundo: 0x1E1E1E,
    painel: 0x212121,
    elevado: 0x262626,
    sob_o_mouse: 0x2A2A2A,
    selecionado: 0x373737,
    divisoria: 0x303030,
    borda_de_controle: 0x3A3A3A,
    texto: 0xD8D8D8,
    texto_forte: 0xF0F0F0,
    texto_secundario: 0x9A9A9A,
    texto_apagado: 0x6E6E6E,
    destaque: 0x5AA0F2,
    texto_no_destaque: 0x111418,
    selecao_de_texto: 0x38516D,
    estado_ok: 0x69C27E,
    estado_de_aviso: 0xE9B452,
    estado_de_erro: 0xF47B74,
};

const CLARA: Paleta = Paleta {
    fundo: 0xFAFAFA,
    painel: 0xF3F3F3,
    elevado: 0xFFFFFF,
    sob_o_mouse: 0xEBEBEB,
    selecionado: 0xDFDFDF,
    divisoria: 0xE2E2E2,
    borda_de_controle: 0xC8C8C8,
    texto: 0x2B2B2B,
    texto_forte: 0x111111,
    texto_secundario: 0x5F5F5F,
    texto_apagado: 0x767676,
    destaque: 0x1F6FD0,
    texto_no_destaque: 0xFFFFFF,
    selecao_de_texto: 0xC7DBF3,
    estado_ok: 0x2F7D32,
    estado_de_aviso: 0x8A6A00,
    estado_de_erro: 0xC5352C,
};

/// O tema em uso. Vale para o processo inteiro: o app tem uma janela só.
static CLARO: AtomicBool = AtomicBool::new(false);

pub fn usar(tema: Tema) {
    CLARO.store(tema == Tema::Claro, Ordering::Relaxed);
}

pub fn atual() -> Tema {
    if CLARO.load(Ordering::Relaxed) { Tema::Claro } else { Tema::Escuro }
}

/// O tema que acompanha a aparência que o sistema deu à janela.
pub fn da_aparencia(aparencia: WindowAppearance) -> Tema {
    match aparencia {
        WindowAppearance::Light | WindowAppearance::VibrantLight => Tema::Claro,
        WindowAppearance::Dark | WindowAppearance::VibrantDark => Tema::Escuro,
    }
}

/// Em build de desenvolvimento, `AWIKA_TEMA=claro` ou `escuro` fixa o tema, para a prova visual
/// capturar os dois sem mexer na configuração do sistema. O build de release ignora a variável.
pub fn fixado_para_a_prova() -> Option<Tema> {
    if !cfg!(debug_assertions) {
        return None;
    }
    match std::env::var("AWIKA_TEMA").ok()?.as_str() {
        "claro" => Some(Tema::Claro),
        "escuro" => Some(Tema::Escuro),
        _ => None,
    }
}

fn paleta_de(tema: Tema) -> &'static Paleta {
    match tema {
        Tema::Escuro => &ESCURA,
        Tema::Claro => &CLARA,
    }
}

fn paleta() -> &'static Paleta {
    paleta_de(atual())
}

/// Fundo da janela e da área central.
pub fn fundo() -> Rgba {
    rgb(paleta().fundo)
}

/// Painel lateral.
pub fn painel() -> Rgba {
    rgb(paleta().painel)
}

/// Campos, cartões e botões secundários.
pub fn elevado() -> Rgba {
    rgb(paleta().elevado)
}

pub fn sob_o_mouse() -> Rgba {
    rgb(paleta().sob_o_mouse)
}

pub fn selecionado() -> Rgba {
    rgb(paleta().selecionado)
}

pub fn divisoria() -> Rgba {
    rgb(paleta().divisoria)
}

pub fn borda_de_controle() -> Rgba {
    rgb(paleta().borda_de_controle)
}

pub fn texto() -> Rgba {
    rgb(paleta().texto)
}

pub fn texto_forte() -> Rgba {
    rgb(paleta().texto_forte)
}

pub fn texto_secundario() -> Rgba {
    rgb(paleta().texto_secundario)
}

/// Dicas dentro de campos vazios.
pub fn texto_apagado() -> Rgba {
    rgb(paleta().texto_apagado)
}

/// Botão principal, foco e cursor.
pub fn destaque() -> Rgba {
    rgb(paleta().destaque)
}

pub fn texto_no_destaque() -> Rgba {
    rgb(paleta().texto_no_destaque)
}

/// Fundo do texto selecionado num campo.
pub fn selecao_de_texto() -> Rgba {
    rgb(paleta().selecao_de_texto)
}

pub fn estado_ok() -> Rgba {
    rgb(paleta().estado_ok)
}

pub fn estado_de_aviso() -> Rgba {
    rgb(paleta().estado_de_aviso)
}

pub fn estado_de_erro() -> Rgba {
    rgb(paleta().estado_de_erro)
}

/// Texto da interface, em pixels.
pub const TAMANHO_DO_TEXTO: f32 = 13.0;
/// Rótulos pequenos e a linha de estado.
pub const TAMANHO_PEQUENO: f32 = 11.5;
/// Altura de linha da interface: 1,35 vezes o texto.
pub const ALTURA_DA_LINHA: f32 = 18.0;

#[cfg(test)]
mod testes {
    use super::*;

    /// Luminância relativa de uma cor, pela fórmula do WCAG.
    fn luminancia(cor: u32) -> f64 {
        let canal = |deslocamento: u32| {
            let valor = f64::from((cor >> deslocamento) & 0xFF) / 255.0;
            if valor <= 0.04045 { valor / 12.92 } else { ((valor + 0.055) / 1.055).powf(2.4) }
        };
        0.2126 * canal(16) + 0.7152 * canal(8) + 0.0722 * canal(0)
    }

    fn contraste(a: u32, b: u32) -> f64 {
        let (clara, escura) = if luminancia(a) > luminancia(b) { (a, b) } else { (b, a) };
        (luminancia(clara) + 0.05) / (luminancia(escura) + 0.05)
    }

    #[test]
    fn o_texto_e_legivel_sobre_cada_fundo_nos_dois_temas() {
        for (nome, paleta) in [("escuro", &ESCURA), ("claro", &CLARA)] {
            let fundos = [("fundo", paleta.fundo), ("painel", paleta.painel), ("elevado", paleta.elevado)];
            let textos = [
                ("texto", paleta.texto),
                ("texto forte", paleta.texto_forte),
                ("texto secundário", paleta.texto_secundario),
                ("estado ok", paleta.estado_ok),
                ("estado de aviso", paleta.estado_de_aviso),
                ("estado de erro", paleta.estado_de_erro),
            ];
            for (do_fundo, fundo) in fundos {
                for (do_texto, texto) in textos {
                    let medido = contraste(texto, fundo);
                    assert!(medido >= 4.5, "tema {nome}: {do_texto} sobre {do_fundo} tem contraste {medido:.2}");
                }
            }
            // Os pares fixos: a linha selecionada, o botão principal, o texto selecionado num campo.
            let pares = [
                ("texto forte sobre a linha selecionada", paleta.texto_forte, paleta.selecionado),
                ("texto sobre a linha sob o mouse", paleta.texto, paleta.sob_o_mouse),
                ("texto do botão principal", paleta.texto_no_destaque, paleta.destaque),
                ("texto selecionado num campo", paleta.texto, paleta.selecao_de_texto),
            ];
            for (o_que, texto, fundo) in pares {
                let medido = contraste(texto, fundo);
                assert!(medido >= 4.5, "tema {nome}: {o_que} tem contraste {medido:.2}");
            }
            // O cursor e a borda de foco só precisam se destacar do campo.
            assert!(contraste(paleta.destaque, paleta.elevado) >= 3.0, "tema {nome}: destaque sobre o campo");
        }
    }

    #[test]
    fn o_tema_acompanha_a_aparencia_da_janela() {
        assert_eq!(da_aparencia(WindowAppearance::Light), Tema::Claro);
        assert_eq!(da_aparencia(WindowAppearance::VibrantLight), Tema::Claro);
        assert_eq!(da_aparencia(WindowAppearance::Dark), Tema::Escuro);
        assert_eq!(da_aparencia(WindowAppearance::VibrantDark), Tema::Escuro);
    }
}
