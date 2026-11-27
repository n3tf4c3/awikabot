//! O que a pessoa está escrevendo para cada bot, e o que um envio faz com esse texto.
//! Regra de tela sem tela: a janela só copia o campo para cá e daqui para o campo.
//!
//! - Cada bot tem o próprio rascunho: trocar de conversa guarda um e mostra o outro, e o texto
//!   escrito para um bot nunca é enviado a outro.
//! - O texto só sai do rascunho quando o servidor aceita o envio. Recusa e falha de rede o deixam
//!   como está, para a pessoa tentar de novo.
//! - Do aceite que chega atrasado só sai o que foi enviado: o que a pessoa digitou depois fica.

use std::collections::HashMap;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Rascunho {
    texto: String,
    /// Sobe a cada mudança do texto. O envio guarda a do momento em que saiu.
    revisao: u64,
    /// Há um envio deste rascunho a caminho do servidor.
    enviando: bool,
}

/// Um envio que saiu e ainda não voltou: para qual bot, o que foi e de qual revisão do rascunho.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Envio {
    bot_id: String,
    texto: String,
    /// O rascunho inteiro como estava ao sair, com os espaços das pontas que não foram enviados.
    como_estava: String,
    revisao: u64,
}

impl Envio {
    pub fn bot_id(&self) -> &str {
        &self.bot_id
    }

    /// O que vai ao servidor: o rascunho sem os espaços das pontas.
    pub fn texto(&self) -> &str {
        &self.texto
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Rascunhos {
    por_bot: HashMap<String, Rascunho>,
}

impl Rascunhos {
    /// O rascunho do bot; vazio se a pessoa não escreveu nada para ele.
    pub fn texto(&self, bot_id: &str) -> &str {
        self.por_bot.get(bot_id).map_or("", |rascunho| rascunho.texto.as_str())
    }

    /// O que está no campo do bot agora. Texto igual ao guardado não muda nada.
    pub fn editar(&mut self, bot_id: &str, texto: &str) {
        if self.texto(bot_id) == texto {
            return;
        }
        let rascunho = self.por_bot.entry(bot_id.to_owned()).or_default();
        rascunho.texto = texto.to_owned();
        rascunho.revisao += 1;
    }

    /// Há um envio do rascunho deste bot que ainda não voltou.
    pub fn enviando(&self, bot_id: &str) -> bool {
        self.por_bot.get(bot_id).is_some_and(|rascunho| rascunho.enviando)
    }

    /// Começa o envio do rascunho do bot. O texto continua no rascunho até o servidor aceitar.
    /// `None` se não há o que enviar, ou se o envio anterior deste bot ainda não voltou: mandar o
    /// mesmo texto duas vezes só renderia uma recusa.
    pub fn comecar_envio(&mut self, bot_id: &str) -> Option<Envio> {
        let rascunho = self.por_bot.get_mut(bot_id)?;
        let texto = rascunho.texto.trim();
        if texto.is_empty() || rascunho.enviando {
            return None;
        }
        rascunho.enviando = true;
        Some(Envio { bot_id: bot_id.to_owned(), texto: texto.to_owned(), como_estava: rascunho.texto.clone(), revisao: rascunho.revisao })
    }

    /// O servidor aceitou o envio: sai do rascunho o que foi enviado. Se a pessoa continuou
    /// escrevendo depois de enviar, fica o que ela escreveu depois; se mexeu no próprio texto
    /// enviado, não há como separar um do outro, e fica tudo.
    pub fn aceitar(&mut self, envio: &Envio) {
        let Some(rascunho) = self.por_bot.get_mut(&envio.bot_id) else { return };
        rascunho.enviando = false;
        let fica = if rascunho.revisao == envio.revisao {
            String::new()
        } else if let Some(depois) = rascunho.texto.strip_prefix(&envio.como_estava) {
            depois.to_owned()
        } else {
            return;
        };
        rascunho.texto = fica;
        rascunho.revisao += 1;
    }

    /// O envio não foi aceito (recusa do servidor, rede, prazo): o rascunho fica como está, e a
    /// pessoa pode enviar de novo.
    pub fn recusar(&mut self, envio: &Envio) {
        if let Some(rascunho) = self.por_bot.get_mut(&envio.bot_id) {
            rascunho.enviando = false;
        }
    }
}

#[cfg(test)]
mod testes {
    use super::*;

    const BOT_A: &str = "bot0000000000001";
    const BOT_B: &str = "bot0000000000002";

    fn com(bot_id: &str, texto: &str) -> Rascunhos {
        let mut rascunhos = Rascunhos::default();
        rascunhos.editar(bot_id, texto);
        rascunhos
    }

    // --- Um rascunho por bot ------------------------------------------------------------------

    #[test]
    fn cada_bot_tem_o_proprio_rascunho() {
        let mut rascunhos = Rascunhos::default();
        assert_eq!(rascunhos.texto(BOT_A), "");
        rascunhos.editar(BOT_A, "para o primeiro");
        assert_eq!(rascunhos.texto(BOT_A), "para o primeiro");
        assert_eq!(rascunhos.texto(BOT_B), "", "o texto de um bot não aparece no outro");
        rascunhos.editar(BOT_B, "para o segundo");
        assert_eq!(rascunhos.texto(BOT_A), "para o primeiro", "escrever para um não mexe no rascunho do outro");
        assert_eq!(rascunhos.texto(BOT_B), "para o segundo");
    }

    #[test]
    fn o_envio_leva_o_bot_do_rascunho_e_nao_o_do_outro() {
        let mut rascunhos = com(BOT_A, "para o primeiro");
        rascunhos.editar(BOT_B, "para o segundo");
        let envio = rascunhos.comecar_envio(BOT_B).expect("envio");
        assert_eq!((envio.bot_id(), envio.texto()), (BOT_B, "para o segundo"));
        rascunhos.aceitar(&envio);
        assert_eq!(rascunhos.texto(BOT_B), "");
        assert_eq!(rascunhos.texto(BOT_A), "para o primeiro", "o aceite de um bot não esvazia o rascunho do outro");
    }

    // --- O texto só sai com o aceite ----------------------------------------------------------

    #[test]
    fn o_texto_fica_no_rascunho_enquanto_o_envio_nao_volta() {
        let mut rascunhos = com(BOT_A, "olá");
        let envio = rascunhos.comecar_envio(BOT_A).expect("envio");
        assert_eq!(envio.texto(), "olá");
        assert_eq!(rascunhos.texto(BOT_A), "olá");
        assert!(rascunhos.enviando(BOT_A));
    }

    #[test]
    fn o_aceite_esvazia_o_rascunho_que_nao_mudou() {
        let mut rascunhos = com(BOT_A, "olá");
        let envio = rascunhos.comecar_envio(BOT_A).expect("envio");
        rascunhos.aceitar(&envio);
        assert_eq!(rascunhos.texto(BOT_A), "");
        assert!(!rascunhos.enviando(BOT_A));
    }

    #[test]
    fn a_recusa_deixa_o_texto_no_rascunho_e_a_pessoa_pode_enviar_de_novo() {
        let mut rascunhos = com(BOT_A, "olá");
        let envio = rascunhos.comecar_envio(BOT_A).expect("envio");
        rascunhos.recusar(&envio);
        assert_eq!(rascunhos.texto(BOT_A), "olá");
        assert!(!rascunhos.enviando(BOT_A));
        let de_novo = rascunhos.comecar_envio(BOT_A).expect("segundo envio");
        assert_eq!(de_novo.texto(), "olá");
    }

    #[test]
    fn o_que_vai_ao_servidor_e_o_texto_sem_os_espacos_das_pontas() {
        let mut rascunhos = com(BOT_A, "  olá, bot \n");
        let envio = rascunhos.comecar_envio(BOT_A).expect("envio");
        assert_eq!(envio.texto(), "olá, bot");
        rascunhos.aceitar(&envio);
        assert_eq!(rascunhos.texto(BOT_A), "");
    }

    #[test]
    fn rascunho_vazio_ou_so_de_espacos_nao_e_enviado() {
        let mut rascunhos = Rascunhos::default();
        assert_eq!(rascunhos.comecar_envio(BOT_A), None);
        rascunhos.editar(BOT_A, "  \n ");
        assert_eq!(rascunhos.comecar_envio(BOT_A), None);
        assert!(!rascunhos.enviando(BOT_A));
        assert_eq!(rascunhos.texto(BOT_A), "  \n ");
    }

    #[test]
    fn um_envio_por_vez_para_cada_bot() {
        let mut rascunhos = com(BOT_A, "olá");
        rascunhos.editar(BOT_B, "oi");
        let primeiro = rascunhos.comecar_envio(BOT_A).expect("envio");
        assert_eq!(rascunhos.comecar_envio(BOT_A), None, "o mesmo texto não sai duas vezes");
        assert!(rascunhos.comecar_envio(BOT_B).is_some(), "o envio de um bot não segura o de outro");
        rascunhos.aceitar(&primeiro);
        rascunhos.editar(BOT_A, "mais uma");
        assert!(rascunhos.comecar_envio(BOT_A).is_some());
    }

    // --- O que a pessoa digitou depois de enviar ----------------------------------------------

    #[test]
    fn o_aceite_atrasado_tira_so_o_que_foi_enviado() {
        let mut rascunhos = com(BOT_A, "primeira");
        let envio = rascunhos.comecar_envio(BOT_A).expect("envio");
        rascunhos.editar(BOT_A, "primeira e a seguinte");
        rascunhos.aceitar(&envio);
        assert_eq!(rascunhos.texto(BOT_A), " e a seguinte");
    }

    #[test]
    fn o_aceite_atrasado_nao_apaga_o_texto_que_a_pessoa_reescreveu() {
        let mut rascunhos = com(BOT_A, "primeira");
        let envio = rascunhos.comecar_envio(BOT_A).expect("envio");
        // Ela mexeu no próprio texto enviado: não há como saber o que é novo.
        rascunhos.editar(BOT_A, "outra coisa");
        rascunhos.aceitar(&envio);
        assert_eq!(rascunhos.texto(BOT_A), "outra coisa");
        assert!(!rascunhos.enviando(BOT_A));
    }

    #[test]
    fn a_recusa_atrasada_nao_mexe_no_que_a_pessoa_digitou_depois() {
        let mut rascunhos = com(BOT_A, "primeira");
        let envio = rascunhos.comecar_envio(BOT_A).expect("envio");
        rascunhos.editar(BOT_A, "primeira e a seguinte");
        rascunhos.recusar(&envio);
        assert_eq!(rascunhos.texto(BOT_A), "primeira e a seguinte");
    }

    #[test]
    fn quem_apagou_e_digitou_o_mesmo_texto_de_novo_ve_o_campo_esvaziar_com_o_aceite() {
        // A revisão mudou, mas o que está no campo é exatamente o que foi enviado.
        let mut rascunhos = com(BOT_A, "olá");
        let envio = rascunhos.comecar_envio(BOT_A).expect("envio");
        rascunhos.editar(BOT_A, "");
        rascunhos.editar(BOT_A, "olá");
        rascunhos.aceitar(&envio);
        assert_eq!(rascunhos.texto(BOT_A), "");
    }

    #[test]
    fn aceite_repetido_do_mesmo_envio_nao_apaga_o_texto_seguinte() {
        // Depois do aceite a revisão sobe: um aceite repetido do mesmo envio não apaga o texto seguinte.
        let mut rascunhos = com(BOT_A, "olá");
        let envio = rascunhos.comecar_envio(BOT_A).expect("envio");
        rascunhos.aceitar(&envio);
        rascunhos.editar(BOT_A, "tudo bem?");
        rascunhos.aceitar(&envio);
        assert_eq!(rascunhos.texto(BOT_A), "tudo bem?");
    }

    #[test]
    fn editar_com_o_mesmo_texto_nao_conta_como_mudanca() {
        let mut rascunhos = com(BOT_A, "olá");
        let envio = rascunhos.comecar_envio(BOT_A).expect("envio");
        // A janela repassa o campo a cada desenho dele, inclusive quando só o cursor andou.
        rascunhos.editar(BOT_A, "olá");
        rascunhos.aceitar(&envio);
        assert_eq!(rascunhos.texto(BOT_A), "");
    }
}
