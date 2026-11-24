//! A conversa de um bot na memória do app, e o que cada evento do fluxo faz com ela.
//! Regra de tela sem tela: a interface só desenha o que está aqui.

use crate::contrato::{Evento, Mensagem, MensagemEstado, RespostaTurno};

/// O que a interface precisa fazer depois de um evento.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Efeito {
    Nada,
    /// O que está na memória não basta: buscar as mensagens de novo.
    Recarregar,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Conversa {
    /// Em ordem crescente de `seq`.
    pub mensagens: Vec<Mensagem>,
}

/// O servidor conta a posição de um trecho como o JavaScript conta o tamanho de um texto.
fn tamanho_utf16(texto: &str) -> u64 {
    texto.encode_utf16().count() as u64
}

impl Conversa {
    /// Troca tudo pelo que o servidor acabou de devolver.
    pub fn trocar(&mut self, mensagens: Vec<Mensagem>) {
        self.mensagens = mensagens;
    }

    fn guardar(&mut self, mensagem: Mensagem) {
        match self.mensagens.iter_mut().find(|atual| atual.id == mensagem.id) {
            Some(atual) => *atual = mensagem,
            None => {
                self.mensagens.push(mensagem);
                self.mensagens.sort_by_key(|mensagem| mensagem.seq);
            }
        }
    }

    /// A resposta de `POST .../turnos`: a mensagem da pessoa e a do bot, ainda vazia. Uma mensagem
    /// que o fluxo já trouxe, e talvez já tenha completado, não volta atrás.
    pub fn registrar_turno(&mut self, resposta: RespostaTurno) {
        for mensagem in [resposta.usuario, resposta.bot] {
            if !self.mensagens.iter().any(|atual| atual.id == mensagem.id) {
                self.guardar(mensagem);
            }
        }
    }

    /// Aplica um evento do fluxo à conversa do bot `bot_id`. Eventos de outros bots não mexem em nada.
    pub fn aplicar(&mut self, bot_id: &str, evento: &Evento) -> Efeito {
        match evento {
            Evento::Ressincronizar => Efeito::Recarregar,
            Evento::TurnoIniciado { bot_id: do_evento, mensagem_id } if do_evento == bot_id => {
                if self.mensagens.iter().any(|mensagem| &mensagem.id == mensagem_id) { Efeito::Nada } else { Efeito::Recarregar }
            }
            Evento::Texto { bot_id: do_evento, mensagem_id, posicao, trecho } if do_evento == bot_id => {
                let Some(mensagem) = self.mensagens.iter_mut().find(|mensagem| &mensagem.id == mensagem_id) else {
                    return Efeito::Recarregar;
                };
                if mensagem.estado != MensagemEstado::EmAndamento {
                    return Efeito::Nada;
                }
                let tenho = tamanho_utf16(&mensagem.texto);
                if *posicao == tenho {
                    mensagem.texto.push_str(trecho);
                    Efeito::Nada
                } else if *posicao < tenho {
                    // Trecho que a busca da mensagem em andamento já tinha trazido.
                    Efeito::Nada
                } else {
                    // Buraco: um trecho se perdeu no caminho.
                    Efeito::Recarregar
                }
            }
            Evento::TurnoTerminado { bot_id: do_evento, mensagem } if do_evento == bot_id => {
                self.guardar(mensagem.clone());
                Efeito::Nada
            }
            _ => Efeito::Nada,
        }
    }
}

#[cfg(test)]
mod testes {
    use super::*;
    use crate::contrato::MensagemPapel;

    const BOT: &str = "botbotbotbotbot1";

    fn mensagem(id: &str, seq: u64, papel: MensagemPapel, texto: &str, estado: MensagemEstado) -> Mensagem {
        Mensagem { id: id.into(), bot_id: BOT.into(), seq, papel, texto: texto.into(), estado, criada_em: 1 }
    }

    fn em_andamento(texto: &str) -> Conversa {
        Conversa {
            mensagens: vec![
                mensagem("pergunta00000001", 1, MensagemPapel::Usuario, "oi", MensagemEstado::Completa),
                mensagem("resposta00000002", 2, MensagemPapel::Bot, texto, MensagemEstado::EmAndamento),
            ],
        }
    }

    fn trecho(posicao: u64, texto: &str) -> Evento {
        Evento::Texto { bot_id: BOT.into(), mensagem_id: "resposta00000002".into(), posicao, trecho: texto.into() }
    }

    #[test]
    fn junta_os_trechos_na_ordem() {
        let mut conversa = em_andamento("");
        assert_eq!(conversa.aplicar(BOT, &trecho(0, "Você ")), Efeito::Nada);
        // "Você " tem cinco unidades UTF-16, e seis bytes em UTF-8: a posição segue o servidor.
        assert_eq!(conversa.aplicar(BOT, &trecho(5, "disse")), Efeito::Nada);
        assert_eq!(conversa.mensagens[1].texto, "Você disse");
    }

    #[test]
    fn nao_repete_trecho_que_ja_tem_e_pede_nova_busca_num_buraco() {
        let mut conversa = em_andamento("Você disse");
        assert_eq!(conversa.aplicar(BOT, &trecho(5, "disse")), Efeito::Nada);
        assert_eq!(conversa.mensagens[1].texto, "Você disse");
        assert_eq!(conversa.aplicar(BOT, &trecho(40, "depois")), Efeito::Recarregar);
        assert_eq!(conversa.mensagens[1].texto, "Você disse");
    }

    #[test]
    fn trecho_de_mensagem_desconhecida_pede_nova_busca() {
        let mut conversa = Conversa::default();
        assert_eq!(conversa.aplicar(BOT, &trecho(0, "x")), Efeito::Recarregar);
    }

    #[test]
    fn o_fim_do_turno_troca_a_mensagem_e_trecho_atrasado_nao_mexe_nela() {
        let mut conversa = em_andamento("Você");
        let final_ = mensagem("resposta00000002", 2, MensagemPapel::Bot, "Você disse: oi", MensagemEstado::Completa);
        assert_eq!(conversa.aplicar(BOT, &Evento::TurnoTerminado { bot_id: BOT.into(), mensagem: final_.clone() }), Efeito::Nada);
        assert_eq!(conversa.mensagens[1], final_);
        assert_eq!(conversa.aplicar(BOT, &trecho(14, " de novo")), Efeito::Nada);
        assert_eq!(conversa.mensagens[1], final_);
    }

    #[test]
    fn turno_que_comecou_em_outro_aparelho_pede_nova_busca() {
        let mut conversa = em_andamento("");
        let de_fora = Evento::TurnoIniciado { bot_id: BOT.into(), mensagem_id: "novaresposta0004".into() };
        assert_eq!(conversa.aplicar(BOT, &de_fora), Efeito::Recarregar);
        let conhecido = Evento::TurnoIniciado { bot_id: BOT.into(), mensagem_id: "resposta00000002".into() };
        assert_eq!(conversa.aplicar(BOT, &conhecido), Efeito::Nada);
    }

    #[test]
    fn evento_de_outro_bot_nao_mexe_em_nada() {
        let mut conversa = em_andamento("a");
        let antes = conversa.clone();
        let de_outro =
            Evento::Texto { bot_id: "outrobot00000009".into(), mensagem_id: "resposta00000002".into(), posicao: 1, trecho: "b".into() };
        assert_eq!(conversa.aplicar(BOT, &de_outro), Efeito::Nada);
        assert_eq!(conversa, antes);
        assert_eq!(conversa.aplicar(BOT, &Evento::Ressincronizar), Efeito::Recarregar);
    }

    #[test]
    fn a_resposta_do_envio_nao_desfaz_o_que_o_fluxo_ja_trouxe() {
        let mut conversa = Conversa::default();
        let usuario = mensagem("pergunta00000001", 1, MensagemPapel::Usuario, "oi", MensagemEstado::Completa);
        let vazia = mensagem("resposta00000002", 2, MensagemPapel::Bot, "", MensagemEstado::EmAndamento);
        let completa = mensagem("resposta00000002", 2, MensagemPapel::Bot, "Você disse: oi", MensagemEstado::Completa);
        // O fluxo chegou antes da resposta do envio.
        conversa.aplicar(BOT, &Evento::TurnoTerminado { bot_id: BOT.into(), mensagem: completa.clone() });
        conversa.registrar_turno(RespostaTurno { usuario: usuario.clone(), bot: vazia });
        assert_eq!(conversa.mensagens, vec![usuario, completa]);
    }
}
