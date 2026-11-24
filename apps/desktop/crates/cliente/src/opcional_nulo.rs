//! Campo de edição em que ausente e nulo dizem coisas diferentes: `None` é "não mexer",
//! `Some(None)` é "apagar o valor" e `Some(Some(v))` é "trocar por v". O contrato gerado usa
//! este módulo com `#[serde(with = ...)]`, junto de `skip_serializing_if`, que cuida do `None`.

use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub fn serialize<S, T>(valor: &Option<Option<T>>, saida: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
    T: Serialize,
{
    match valor {
        Some(interno) => interno.serialize(saida),
        None => saida.serialize_none(),
    }
}

pub fn deserialize<'de, D, T>(entrada: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(entrada).map(Some)
}

#[cfg(test)]
mod testes {
    use crate::contrato::BotEdicao;

    fn edicao(modelo: Option<Option<String>>) -> BotEdicao {
        BotEdicao { nome: None, instrucoes: None, modelo }
    }

    #[test]
    fn ausente_nulo_e_valor_saem_diferentes() {
        assert_eq!(serde_json::to_string(&edicao(None)).unwrap(), "{}");
        assert_eq!(serde_json::to_string(&edicao(Some(None))).unwrap(), r#"{"modelo":null}"#);
        assert_eq!(serde_json::to_string(&edicao(Some(Some("x".into())))).unwrap(), r#"{"modelo":"x"}"#);
    }

    #[test]
    fn ausente_nulo_e_valor_voltam_diferentes() {
        assert_eq!(serde_json::from_str::<BotEdicao>("{}").unwrap(), edicao(None));
        assert_eq!(serde_json::from_str::<BotEdicao>(r#"{"modelo":null}"#).unwrap(), edicao(Some(None)));
        assert_eq!(serde_json::from_str::<BotEdicao>(r#"{"modelo":"x"}"#).unwrap(), edicao(Some(Some("x".into()))));
    }
}
