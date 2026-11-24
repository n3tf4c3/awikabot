// Gerado de packages/core/src/index.ts. Não editar à mão.
// Para atualizar: pnpm --filter @awikabot/core contrato
// O teste do core falha enquanto este arquivo estiver diferente do que o contrato diz.

use serde::{Deserialize, Serialize};

/// Versão do contrato entre servidor e clientes.
pub const VERSAO_PROTOCOLO: u64 = 1;
/// Intervalo do sinal de vida do fluxo de eventos, em milissegundos.
pub const INTERVALO_PING_MS: u64 = 15000;
/// Quanto um pedido de aprovação espera pela pessoa, em milissegundos.
pub const ESPERA_APROVACAO_MS: u64 = 900000;

/// Limites que o servidor aplica. O cliente usa os mesmos nos campos.
pub mod limites {
    pub const NOME_DISPOSITIVO: usize = 60;
    pub const NOME_BOT: usize = 60;
    pub const INSTRUCOES: usize = 8000;
    pub const MODELO: usize = 80;
    pub const TEXTO: usize = 20000;
    pub const MENSAGENS_POR_PAGINA: usize = 50;
    pub const FERRAMENTA: usize = 100;
    pub const RESUMO_APROVACAO: usize = 4000;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SaudeStatus {
    #[serde(rename = "ok")]
    Ok,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Saude {
    pub status: SaudeStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InfoDoServidor {
    pub versao: String,
    pub protocolo: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Erro {
    pub erro: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dispositivo {
    pub id: String,
    pub nome: String,
    pub criado_em: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RespostaPareamento {
    pub token: String,
    pub dispositivo: Dispositivo,
    pub servidor: InfoDoServidor,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bot {
    pub id: String,
    pub nome: String,
    pub instrucoes: String,
    pub modelo: Option<String>,
    pub criado_em: u64,
    pub atualizado_em: u64,
    pub turno_ativo: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListaBots {
    pub bots: Vec<Bot>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum MensagemPapel {
    #[serde(rename = "usuario")]
    Usuario,
    #[serde(rename = "bot")]
    Bot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum MensagemEstado {
    #[serde(rename = "completa")]
    Completa,
    #[serde(rename = "em_andamento")]
    EmAndamento,
    #[serde(rename = "parada")]
    Parada,
    #[serde(rename = "falhou")]
    Falhou,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mensagem {
    pub id: String,
    pub bot_id: String,
    pub seq: u64,
    pub papel: MensagemPapel,
    pub texto: String,
    pub estado: MensagemEstado,
    pub criada_em: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListaMensagens {
    pub mensagens: Vec<Mensagem>,
    pub tem_mais: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RespostaTurno {
    pub usuario: Mensagem,
    pub bot: Mensagem,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AprovacaoEstado {
    #[serde(rename = "pendente")]
    Pendente,
    #[serde(rename = "aprovada")]
    Aprovada,
    #[serde(rename = "negada")]
    Negada,
    #[serde(rename = "expirada")]
    Expirada,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Aprovacao {
    pub id: String,
    pub bot_id: String,
    pub mensagem_id: String,
    pub ferramenta: String,
    pub resumo: String,
    pub estado: AprovacaoEstado,
    pub criada_em: u64,
    pub resolvida_em: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListaAprovacoes {
    pub aprovacoes: Vec<Aprovacao>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "tipo")]
pub enum Evento {
    #[serde(rename = "turno_iniciado", rename_all = "camelCase")]
    TurnoIniciado {
        bot_id: String,
        mensagem_id: String,
    },
    #[serde(rename = "texto", rename_all = "camelCase")]
    Texto {
        bot_id: String,
        mensagem_id: String,
        posicao: u64,
        trecho: String,
    },
    #[serde(rename = "turno_terminado", rename_all = "camelCase")]
    TurnoTerminado {
        bot_id: String,
        mensagem: Mensagem,
    },
    #[serde(rename = "bot_salvo", rename_all = "camelCase")]
    BotSalvo {
        bot: Bot,
    },
    #[serde(rename = "aprovacao_pedida", rename_all = "camelCase")]
    AprovacaoPedida {
        aprovacao: Aprovacao,
    },
    #[serde(rename = "aprovacao_resolvida", rename_all = "camelCase")]
    AprovacaoResolvida {
        aprovacao: Aprovacao,
    },
    #[serde(rename = "ressincronizar")]
    Ressincronizar,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PedidoPareamento {
    pub codigo: String,
    pub nome: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotEntrada {
    pub nome: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instrucoes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modelo: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotEdicao {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nome: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instrucoes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "crate::opcional_nulo")]
    pub modelo: Option<Option<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PedidoTurno {
    pub texto: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum DecisaoAprovacaoDecisao {
    #[serde(rename = "aprovar")]
    Aprovar,
    #[serde(rename = "negar")]
    Negar,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisaoAprovacao {
    pub decisao: DecisaoAprovacaoDecisao,
}
