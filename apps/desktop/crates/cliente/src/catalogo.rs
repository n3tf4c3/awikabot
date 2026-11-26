//! As listas do formulário do bot, montadas com o catálogo do servidor.
//!
//! É a mesma regra de `apps/mobile/src/lib/catalogo.ts`: "Auto" no topo dos modelos, "Outro" para
//! digitar um modelo que a lista não tem, "Padrão" no topo dos esforços, e só os motores prontos
//! da família dos agentes para criar. Sem catálogo (um servidor anterior à rota, ou fora do ar),
//! o formulário segue com o "Auto", o "Outro" e o motor padrão.

use crate::contrato::{Catalogo, MOTOR_PADRAO, MotorDoCatalogo, MotorDoCatalogoFamilia};
use crate::formulario_bot::CamposBot;

/// Um item de uma lista. `valor` é o que vai para o campo; vazio é o padrão do motor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Opcao {
    pub valor: String,
    pub rotulo: String,
}

impl Opcao {
    fn new(valor: &str, rotulo: &str) -> Self {
        Self { valor: valor.to_owned(), rotulo: rotulo.to_owned() }
    }
}

pub const ROTULO_AUTO: &str = "Auto";
pub const ROTULO_ESFORCO_PADRAO: &str = "Padrão";
pub const ROTULO_OUTRO_MODELO: &str = "Outro";

pub fn motor_do_catalogo<'a>(catalogo: Option<&'a Catalogo>, id: &str) -> Option<&'a MotorDoCatalogo> {
    catalogo?.motores.iter().find(|motor| motor.id == id)
}

/// O nome do motor para a tela; sem catálogo, o próprio id.
pub fn nome_do_motor(catalogo: Option<&Catalogo>, id: &str) -> String {
    motor_do_catalogo(catalogo, id).map_or_else(|| id.to_owned(), |motor| motor.nome.clone())
}

/// Os motores em que dá para criar um bot. Sem nenhum pronto, só o motor padrão.
pub fn motores_para_criar(catalogo: Option<&Catalogo>) -> Vec<Opcao> {
    let prontos: Vec<Opcao> = catalogo
        .map(|catalogo| catalogo.motores.as_slice())
        .unwrap_or_default()
        .iter()
        .filter(|motor| motor.pronto && motor.familia == MotorDoCatalogoFamilia::Agente)
        .map(|motor| Opcao::new(&motor.id, &motor.nome))
        .collect();
    if prontos.is_empty() { vec![Opcao::new(MOTOR_PADRAO, &nome_do_motor(catalogo, MOTOR_PADRAO))] } else { prontos }
}

/// "Auto" e os modelos que o catálogo sugere para o motor. "Outro" é um item à parte.
pub fn opcoes_de_modelo(catalogo: Option<&Catalogo>, motor: &str) -> Vec<Opcao> {
    let sugeridos = motor_do_catalogo(catalogo, motor).map(|motor| motor.modelos.as_slice()).unwrap_or_default();
    std::iter::once(Opcao::new("", ROTULO_AUTO)).chain(sugeridos.iter().map(|modelo| Opcao::new(&modelo.id, &modelo.nome))).collect()
}

/// "Padrão" e os esforços do motor; só "Padrão" quer dizer que a tela não mostra a lista. O esforço
/// `atual` que o catálogo não tiver entra no fim, com o próprio id, para a tela não o esconder.
pub fn opcoes_de_esforco(catalogo: Option<&Catalogo>, motor: &str, atual: &str) -> Vec<Opcao> {
    let esforcos = motor_do_catalogo(catalogo, motor).map(|motor| motor.esforcos.as_slice()).unwrap_or_default();
    let mut opcoes: Vec<Opcao> = std::iter::once(Opcao::new("", ROTULO_ESFORCO_PADRAO))
        .chain(esforcos.iter().map(|esforco| Opcao::new(&esforco.id, &esforco.nome)))
        .collect();
    if !opcoes.iter().any(|opcao| opcao.valor == atual) {
        opcoes.push(Opcao::new(atual, atual));
    }
    opcoes
}

/// O modelo foi digitado, e não escolhido na lista: não está vazio e não é um dos sugeridos.
pub fn modelo_digitado(modelo: &str, opcoes: &[Opcao]) -> bool {
    let aparado = modelo.trim();
    !aparado.is_empty() && !opcoes.iter().any(|opcao| opcao.valor == aparado)
}

/// O item marcado na lista de modelos, tirado do texto do campo: o próprio modelo quando ele é o
/// "Auto" (vazio) ou um dos sugeridos, e `None` quando foi digitado, que é o "Outro". No desktop o campo
/// fica à vista: a lista só o preenche.
pub fn modelo_marcado<'a>(texto: &'a str, opcoes: &[Opcao]) -> Option<&'a str> {
    (!modelo_digitado(texto, opcoes)).then(|| texto.trim())
}

/// O texto do campo ao clicar em "Outro": um modelo da lista dá lugar ao campo vazio, pronto para
/// digitar; um modelo já digitado fica. `None` quando o texto não muda.
pub fn texto_ao_escolher_outro(texto: &str, opcoes: &[Opcao]) -> Option<String> {
    (!modelo_digitado(texto, opcoes) && !texto.is_empty()).then(String::new)
}

/// Outro motor, só na criação. O modelo e o esforço escolhidos nas listas voltam ao padrão, a menos
/// que o outro motor também os tenha; um modelo digitado fica, porque o formato vale para qualquer motor.
pub fn trocar_motor(catalogo: Option<&Catalogo>, campos: &CamposBot, motor: &str) -> CamposBot {
    if motor == campos.motor {
        return campos.clone();
    }
    let da_lista_antiga = !modelo_digitado(&campos.modelo, &opcoes_de_modelo(catalogo, &campos.motor));
    let na_lista_nova = opcoes_de_modelo(catalogo, motor).iter().any(|opcao| opcao.valor == campos.modelo.trim());
    let esforco_vale = opcoes_de_esforco(catalogo, motor, "").iter().any(|opcao| opcao.valor == campos.esforco);
    CamposBot {
        modelo: if da_lista_antiga && !na_lista_nova { String::new() } else { campos.modelo.clone() },
        esforco: if esforco_vale { campos.esforco.clone() } else { String::new() },
        motor: motor.to_owned(),
        ..campos.clone()
    }
}

#[cfg(test)]
mod testes {
    use super::*;
    use crate::contrato::{EsforcoDoMotor, ModeloSugerido, MotorDoCatalogoPapeis};
    use crate::formulario_bot::validar_bot;

    fn motor(id: &str, nome: &str, modelos: &[(&str, &str)], esforcos: &[(&str, &str)]) -> MotorDoCatalogo {
        MotorDoCatalogo {
            id: id.into(),
            nome: nome.into(),
            familia: MotorDoCatalogoFamilia::Agente,
            modelos: modelos.iter().map(|(id, nome)| ModeloSugerido { id: (*id).into(), nome: (*nome).into() }).collect(),
            esforcos: esforcos.iter().map(|(id, nome)| EsforcoDoMotor { id: (*id).into(), nome: (*nome).into() }).collect(),
            papeis: vec![MotorDoCatalogoPapeis::Worker],
            pronto: true,
        }
    }

    fn catalogo() -> Catalogo {
        Catalogo {
            motores: vec![
                motor("claude-code", "Claude Code", &[("opus", "Opus"), ("sonnet", "Sonnet")], &[("low", "Baixo"), ("high", "Alto")]),
                motor("outro", "Outro motor", &[("rapido", "Rápido")], &[("high", "Alto")]),
            ],
        }
    }

    fn valores(opcoes: &[Opcao]) -> Vec<&str> {
        opcoes.iter().map(|opcao| opcao.valor.as_str()).collect()
    }

    fn com_modelo(modelo: &str) -> CamposBot {
        CamposBot { modelo: modelo.into(), ..CamposBot::default() }
    }

    #[test]
    fn a_lista_de_modelos_comeca_por_auto_e_segue_o_catalogo() {
        let catalogo = catalogo();
        assert_eq!(
            opcoes_de_modelo(Some(&catalogo), "claude-code"),
            vec![Opcao::new("", "Auto"), Opcao::new("opus", "Opus"), Opcao::new("sonnet", "Sonnet")]
        );
        assert_eq!(valores(&opcoes_de_modelo(None, MOTOR_PADRAO)), [""]);
        assert_eq!(valores(&opcoes_de_modelo(Some(&catalogo), "nao-existe")), [""]);
    }

    #[test]
    fn a_lista_de_esforcos_comeca_por_padrao_e_guarda_o_esforco_do_bot() {
        let catalogo = catalogo();
        assert_eq!(valores(&opcoes_de_esforco(Some(&catalogo), "claude-code", "")), ["", "low", "high"]);
        assert_eq!(opcoes_de_esforco(Some(&catalogo), "claude-code", "")[0].rotulo, "Padrão");
        assert_eq!(valores(&opcoes_de_esforco(None, MOTOR_PADRAO, "")), [""]);
        assert_eq!(opcoes_de_esforco(None, MOTOR_PADRAO, "high"), vec![Opcao::new("", "Padrão"), Opcao::new("high", "high")]);
    }

    #[test]
    fn para_criar_so_os_motores_prontos_que_sao_agentes() {
        let mut catalogo = catalogo();
        catalogo.motores[1].pronto = false;
        catalogo.motores.push(MotorDoCatalogo { familia: MotorDoCatalogoFamilia::Decisor, ..motor("juiz", "Juiz", &[], &[]) });
        assert_eq!(motores_para_criar(Some(&catalogo)), vec![Opcao::new("claude-code", "Claude Code")]);
        assert_eq!(motores_para_criar(None), vec![Opcao::new(MOTOR_PADRAO, MOTOR_PADRAO)]);
        assert_eq!(nome_do_motor(Some(&catalogo), "claude-code"), "Claude Code");
    }

    #[test]
    fn o_item_marcado_sai_do_texto_do_campo() {
        let opcoes = opcoes_de_modelo(Some(&catalogo()), "claude-code");
        assert_eq!(modelo_marcado("", &opcoes), Some(""));
        assert_eq!(modelo_marcado("   ", &opcoes), Some(""));
        assert_eq!(modelo_marcado(" opus ", &opcoes), Some("opus"));
        assert_eq!(modelo_marcado("meu-modelo", &opcoes), None);
        // Sem catálogo, todo modelo preenchido é o "Outro".
        assert_eq!(modelo_marcado("opus", &opcoes_de_modelo(None, MOTOR_PADRAO)), None);
        assert!(modelo_digitado("meu-modelo", &opcoes) && !modelo_digitado("sonnet", &opcoes));
    }

    #[test]
    fn outro_limpa_o_modelo_da_lista_e_mantem_o_digitado() {
        let opcoes = opcoes_de_modelo(Some(&catalogo()), "claude-code");
        assert_eq!(texto_ao_escolher_outro("opus", &opcoes), Some(String::new()));
        assert_eq!(texto_ao_escolher_outro("meu-modelo", &opcoes), None);
        assert_eq!(texto_ao_escolher_outro("", &opcoes), None);
        // O "Outro" em branco salva como "Auto".
        assert_eq!(validar_bot(&CamposBot { nome: "Scout".into(), ..com_modelo("") }).map(|entrada| entrada.modelo), Ok(None));
    }

    #[test]
    fn trocar_de_motor_volta_ao_padrao_o_que_o_outro_nao_tem() {
        let catalogo = catalogo();
        let da_lista = CamposBot { modelo: "opus".into(), esforco: "low".into(), ..CamposBot::default() };
        let trocado = trocar_motor(Some(&catalogo), &da_lista, "outro");
        assert_eq!((trocado.motor.as_str(), trocado.modelo.as_str(), trocado.esforco.as_str()), ("outro", "", ""));

        let digitado = CamposBot { modelo: "meu-modelo".into(), esforco: "high".into(), ..CamposBot::default() };
        let trocado = trocar_motor(Some(&catalogo), &digitado, "outro");
        assert_eq!((trocado.modelo.as_str(), trocado.esforco.as_str()), ("meu-modelo", "high"));
        assert_eq!(trocar_motor(Some(&catalogo), &digitado, "claude-code"), digitado);
    }
}
