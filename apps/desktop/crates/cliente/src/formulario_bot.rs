//! O formulário do bot como a pessoa digita, e o que dele vai para o servidor.
//!
//! É a mesma regra de `apps/mobile/src/lib/formulario-bot.ts`, que valida com o esquema
//! `EsquemaBotEntrada` do contrato. Aqui a regra é escrita à mão, e os dois lados são testados
//! contra a mesma tabela, em `packages/core/casos/bot-entrada.json`: mudar a regra num deles sem
//! mudar no outro quebra o teste.

use crate::contrato::{Bot, BotEdicao, BotEntrada, limites};

/// Tudo texto; modelo vazio quer dizer "padrão do motor".
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CamposBot {
    pub nome: String,
    pub instrucoes: String,
    pub modelo: String,
}

/// A frase de cada campo com problema, igual à do app de celular.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ErrosBot {
    pub nome: Option<String>,
    pub instrucoes: Option<String>,
    pub modelo: Option<String>,
}

fn mensagem_do_nome() -> String {
    format!("Informe um nome com até {} caracteres.", limites::NOME_BOT)
}

fn mensagem_das_instrucoes() -> String {
    format!("As instruções têm no máximo {} caracteres.", limites::INSTRUCOES)
}

fn mensagem_do_modelo() -> String {
    format!(
        "Use até {} caracteres, começando por letra ou número: letras, números, ponto, hífen, sublinhado, dois-pontos e colchetes.",
        limites::MODELO
    )
}

/// O que o `trim()` do JavaScript tira das pontas, que é o que o esquema do contrato usa. Não é
/// o mesmo conjunto do `str::trim` do Rust: no JavaScript, U+FEFF sai e U+0085 fica; com o
/// `str::trim`, seria o contrário.
fn espaco_do_javascript(caractere: char) -> bool {
    matches!(
        caractere,
        '\u{0009}'..='\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

fn aparar(texto: &str) -> &str {
    texto.trim_matches(espaco_do_javascript)
}

/// O tamanho como o esquema do contrato conta: em caracteres Unicode (pontos de código). Um emoji
/// vale um, embora ocupe duas unidades UTF-16 e quatro bytes; uma letra com acento separado vale dois.
fn tamanho(texto: &str) -> usize {
    texto.chars().count()
}

/// Nome de modelo do motor, já sem espaços nas pontas: começa por letra ou número e segue com
/// letras, números, ponto, sublinhado, dois-pontos, colchetes e hífen. O formato restrito impede
/// que vire uma opção de linha de comando.
fn modelo_valido(modelo: &str) -> bool {
    let bytes = modelo.as_bytes();
    (1..=limites::MODELO).contains(&tamanho(modelo))
        && bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes.iter().all(|byte| byte.is_ascii_alphanumeric() || b"._:[]-".contains(byte))
}

pub fn campos_do_bot(bot: &Bot) -> CamposBot {
    CamposBot { nome: bot.nome.clone(), instrucoes: bot.instrucoes.clone(), modelo: bot.modelo.clone().unwrap_or_default() }
}

/// A entrada pronta para o servidor, ou o erro de cada campo (mesmas mensagens do celular).
/// O nome e o modelo perdem os espaços das pontas; as instruções vão como foram digitadas.
pub fn validar_bot(campos: &CamposBot) -> Result<BotEntrada, ErrosBot> {
    let nome = aparar(&campos.nome);
    let modelo = aparar(&campos.modelo);
    let erros = ErrosBot {
        nome: (!(1..=limites::NOME_BOT).contains(&tamanho(nome))).then(mensagem_do_nome),
        instrucoes: (tamanho(&campos.instrucoes) > limites::INSTRUCOES).then(mensagem_das_instrucoes),
        modelo: (!modelo.is_empty() && !modelo_valido(modelo)).then(mensagem_do_modelo),
    };
    if erros != ErrosBot::default() {
        return Err(erros);
    }
    Ok(BotEntrada {
        nome: nome.to_owned(),
        instrucoes: Some(campos.instrucoes.clone()),
        modelo: (!modelo.is_empty()).then(|| modelo.to_owned()),
    })
}

/// Só o que mudou em relação ao bot, para o `PATCH`. `None` quando nada mudou. Instruções
/// ausentes na entrada valem o mesmo que no servidor: texto vazio. Modelo ausente quer dizer
/// "padrão do motor", e sai como `Some(None)` quando o bot tinha um.
pub fn edicao_do_bot(bot: &Bot, entrada: &BotEntrada) -> Option<BotEdicao> {
    let instrucoes = entrada.instrucoes.as_deref().unwrap_or_default();
    let edicao = BotEdicao {
        nome: (entrada.nome != bot.nome).then(|| entrada.nome.clone()),
        instrucoes: (instrucoes != bot.instrucoes).then(|| instrucoes.to_owned()),
        modelo: (entrada.modelo != bot.modelo).then(|| entrada.modelo.clone()),
    };
    (edicao != BotEdicao { nome: None, instrucoes: None, modelo: None }).then_some(edicao)
}

#[cfg(test)]
mod testes {
    use serde::Deserialize;

    use super::*;

    fn bot() -> Bot {
        Bot {
            id: "bot0000000000001".into(),
            nome: "Ajudante".into(),
            instrucoes: "Responda curto.".into(),
            modelo: Some("modelo-x".into()),
            criado_em: 1,
            atualizado_em: 2,
            turno_ativo: false,
        }
    }

    fn campos(nome: &str, instrucoes: &str, modelo: &str) -> CamposBot {
        CamposBot { nome: nome.into(), instrucoes: instrucoes.into(), modelo: modelo.into() }
    }

    fn entrada(nome: &str, instrucoes: &str, modelo: Option<&str>) -> BotEntrada {
        BotEntrada { nome: nome.into(), instrucoes: Some(instrucoes.into()), modelo: modelo.map(str::to_owned) }
    }

    /// Os nomes dos campos com erro, em ordem alfabética, como a tabela de casos os lista.
    fn campos_com_erro(erros: &ErrosBot) -> Vec<&'static str> {
        [("instrucoes", &erros.instrucoes), ("modelo", &erros.modelo), ("nome", &erros.nome)]
            .into_iter()
            .filter_map(|(campo, erro)| erro.is_some().then_some(campo))
            .collect()
    }

    // --- A tabela que o app de celular também testa -----------------------------------------

    /// Um pedaço de texto da tabela: o próprio texto, ou um trecho repetido, para os casos de limite.
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Parte {
        Texto(String),
        Repeticao { repete: String, vezes: usize },
    }

    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Texto {
        Inteiro(String),
        Partes(Vec<Parte>),
    }

    impl Texto {
        fn montar(&self) -> String {
            match self {
                Self::Inteiro(texto) => texto.clone(),
                Self::Partes(partes) => partes
                    .iter()
                    .map(|parte| match parte {
                        Parte::Texto(texto) => texto.clone(),
                        Parte::Repeticao { repete, vezes } => repete.repeat(*vezes),
                    })
                    .collect(),
            }
        }
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct EntradaEsperada {
        nome: Texto,
        instrucoes: Texto,
        modelo: Option<Texto>,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Caso {
        caso: String,
        nome: Texto,
        instrucoes: Texto,
        modelo: Texto,
        entrada: Option<EntradaEsperada>,
        erros: Option<Vec<String>>,
    }

    #[derive(Deserialize)]
    struct Tabela {
        casos: Vec<Caso>,
    }

    /// Quem diverge da tabela, diverge do outro app e do servidor.
    #[test]
    fn segue_a_mesma_tabela_do_app_de_celular() {
        let texto = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../packages/core/casos/bot-entrada.json"));
        let tabela: Tabela = serde_json::from_str(texto).expect("tabela de casos");
        assert!(tabela.casos.len() >= 90, "a tabela encolheu: {} casos", tabela.casos.len());
        for caso in tabela.casos {
            let digitado = CamposBot { nome: caso.nome.montar(), instrucoes: caso.instrucoes.montar(), modelo: caso.modelo.montar() };
            let obtido = validar_bot(&digitado);
            match (&caso.entrada, &caso.erros) {
                (Some(esperada), None) => {
                    let esperada = BotEntrada {
                        nome: esperada.nome.montar(),
                        instrucoes: Some(esperada.instrucoes.montar()),
                        modelo: esperada.modelo.as_ref().map(Texto::montar),
                    };
                    assert_eq!(obtido, Ok(esperada), "caso {:?}", caso.caso);
                }
                (None, Some(erros)) => {
                    assert!(!erros.is_empty(), "caso {:?} sem campo com erro", caso.caso);
                    let obtidos = obtido.as_ref().map_err(campos_com_erro);
                    assert_eq!(obtidos.map_err(|campos| campos.join(",")), Err(erros.join(",")), "caso {:?}", caso.caso);
                }
                _ => panic!("caso sem entrada nem erros, ou com os dois: {:?}", caso.caso),
            }
        }
    }

    // --- validar_bot ------------------------------------------------------------------------

    #[test]
    fn aceita_so_o_nome_e_manda_modelo_nulo_e_instrucoes_vazias() {
        assert_eq!(validar_bot(&campos("Ajudante", "", "")), Ok(entrada("Ajudante", "", None)));
    }

    #[test]
    fn tira_espacos_das_pontas_do_nome_e_do_modelo_e_preserva_as_instrucoes() {
        assert_eq!(
            validar_bot(&campos("  Ajudante ", "  linha 1\n", " modelo-x ")),
            Ok(entrada("Ajudante", "  linha 1\n", Some("modelo-x")))
        );
    }

    #[test]
    fn trata_modelo_so_com_espacos_como_vazio() {
        assert_eq!(validar_bot(&campos("Ajudante", "", "   ")).map(|entrada| entrada.modelo), Ok(None));
    }

    #[test]
    fn exige_nome() {
        for nome in ["", "   "] {
            assert_eq!(validar_bot(&campos(nome, "", "")).as_ref().map_err(campos_com_erro), Err(vec!["nome"]), "{nome:?}");
        }
    }

    #[test]
    fn respeita_os_limites_do_contrato_em_cada_campo() {
        let erros = |campos: CamposBot| validar_bot(&campos).as_ref().map_err(campos_com_erro).err().unwrap_or_default();
        assert_eq!(erros(campos(&"n".repeat(limites::NOME_BOT), "", "")), Vec::<&str>::new());
        assert_eq!(erros(campos(&"n".repeat(limites::NOME_BOT + 1), "", "")), ["nome"]);
        assert_eq!(erros(campos("Ajudante", &"i".repeat(limites::INSTRUCOES), "")), Vec::<&str>::new());
        assert_eq!(erros(campos("Ajudante", &"i".repeat(limites::INSTRUCOES + 1), "")), ["instrucoes"]);
        assert_eq!(erros(campos("Ajudante", "", &"m".repeat(limites::MODELO))), Vec::<&str>::new());
        assert_eq!(erros(campos("Ajudante", "", &"m".repeat(limites::MODELO + 1))), ["modelo"]);
    }

    #[test]
    fn o_tamanho_conta_caracteres_e_nao_bytes_nem_unidades_utf16() {
        // Um emoji: um caractere, duas unidades UTF-16, quatro bytes.
        assert!(validar_bot(&campos(&"😀".repeat(limites::NOME_BOT), "", "")).is_ok());
        assert!(validar_bot(&campos(&"😀".repeat(limites::NOME_BOT + 1), "", "")).is_err());
        assert!(validar_bot(&campos("Ajudante", &"ã".repeat(limites::INSTRUCOES), "")).is_ok());
    }

    #[test]
    fn recusa_modelo_fora_do_formato() {
        for modelo in ["--flag", "modelo x", "modelo/x", "-x", "modelo;rm"] {
            assert_eq!(validar_bot(&campos("Ajudante", "", modelo)).as_ref().map_err(campos_com_erro), Err(vec!["modelo"]), "{modelo}");
        }
    }

    #[test]
    fn aceita_modelo_no_formato() {
        for modelo in ["modelo-x", "familia.modelo:4.5", "modelo[1m]", "m_1"] {
            assert_eq!(validar_bot(&campos("Ajudante", "", modelo)).map(|entrada| entrada.modelo), Ok(Some(modelo.to_owned())), "{modelo}");
        }
    }

    #[test]
    fn aponta_todos_os_campos_com_problema_com_frase_em_portugues() {
        let erros = validar_bot(&campos("", &"i".repeat(limites::INSTRUCOES + 1), "--x")).expect_err("três campos com erro");
        assert_eq!(erros.nome.as_deref(), Some("Informe um nome com até 60 caracteres."));
        assert_eq!(erros.instrucoes.as_deref(), Some("As instruções têm no máximo 8000 caracteres."));
        assert_eq!(
            erros.modelo.as_deref(),
            Some(
                "Use até 80 caracteres, começando por letra ou número: letras, números, ponto, hífen, sublinhado, dois-pontos e colchetes."
            )
        );
    }

    #[test]
    fn so_o_campo_com_problema_ganha_frase() {
        let erros = validar_bot(&campos("Ajudante", "", "--x")).expect_err("modelo com erro");
        assert_eq!(erros, ErrosBot { nome: None, instrucoes: None, modelo: Some(mensagem_do_modelo()) });
    }

    // --- campos_do_bot ----------------------------------------------------------------------

    #[test]
    fn preenche_o_formulario_com_o_bot() {
        assert_eq!(campos_do_bot(&bot()), campos("Ajudante", "Responda curto.", "modelo-x"));
    }

    #[test]
    fn mostra_modelo_nulo_como_campo_vazio() {
        assert_eq!(campos_do_bot(&Bot { modelo: None, ..bot() }).modelo, "");
    }

    // --- edicao_do_bot ----------------------------------------------------------------------

    fn igual() -> BotEntrada {
        entrada("Ajudante", "Responda curto.", Some("modelo-x"))
    }

    fn edicao(nome: Option<&str>, instrucoes: Option<&str>, modelo: Option<Option<&str>>) -> BotEdicao {
        BotEdicao {
            nome: nome.map(str::to_owned),
            instrucoes: instrucoes.map(str::to_owned),
            modelo: modelo.map(|modelo| modelo.map(str::to_owned)),
        }
    }

    #[test]
    fn devolve_none_quando_nada_mudou() {
        assert_eq!(edicao_do_bot(&bot(), &igual()), None);
    }

    #[test]
    fn manda_so_o_que_mudou() {
        assert_eq!(edicao_do_bot(&bot(), &BotEntrada { nome: "Outro".into(), ..igual() }), Some(edicao(Some("Outro"), None, None)));
        assert_eq!(edicao_do_bot(&bot(), &BotEntrada { instrucoes: Some(String::new()), ..igual() }), Some(edicao(None, Some(""), None)));
        assert_eq!(edicao_do_bot(&bot(), &entrada("Outro", "x", Some("y"))), Some(edicao(Some("Outro"), Some("x"), Some(Some("y")))));
    }

    #[test]
    fn manda_modelo_nulo_para_tirar_o_modelo() {
        let sem_modelo = edicao_do_bot(&bot(), &BotEntrada { modelo: None, ..igual() });
        assert_eq!(sem_modelo, Some(edicao(None, None, Some(None))));
        // No fio, é o `null` que o servidor lê como "voltar ao padrão do motor".
        assert_eq!(serde_json::to_string(&sem_modelo).expect("json"), r#"{"modelo":null}"#);
    }

    #[test]
    fn bot_sem_modelo_e_entrada_sem_modelo_nao_geram_edicao() {
        let sem_modelo = Bot { modelo: None, ..bot() };
        assert_eq!(edicao_do_bot(&sem_modelo, &BotEntrada { modelo: None, ..igual() }), None);
        assert_eq!(edicao_do_bot(&sem_modelo, &igual()), Some(edicao(None, None, Some(Some("modelo-x")))));
    }

    #[test]
    fn instrucoes_ausentes_valem_texto_vazio() {
        let sem_instrucoes = BotEntrada { instrucoes: None, ..igual() };
        assert_eq!(edicao_do_bot(&bot(), &sem_instrucoes), Some(edicao(None, Some(""), None)));
        assert_eq!(edicao_do_bot(&Bot { instrucoes: String::new(), ..bot() }, &sem_instrucoes), None);
    }

    #[test]
    fn formulario_aberto_e_salvo_sem_mexer_nao_gera_edicao() {
        let lido = validar_bot(&campos_do_bot(&bot())).expect("o bot do servidor é válido");
        assert_eq!(edicao_do_bot(&bot(), &lido), None);
        let sem_modelo = Bot { modelo: None, ..bot() };
        let lido = validar_bot(&campos_do_bot(&sem_modelo)).expect("o bot do servidor é válido");
        assert_eq!(edicao_do_bot(&sem_modelo, &lido), None);
    }
}
