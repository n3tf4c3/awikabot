//! A conversa de um bot na memória do app, e o que cada evento do fluxo faz com ela.
//! Regra de tela sem tela: a interface só desenha o que está aqui.
//!
//! Uma resposta HTTP pode chegar depois de um evento mais novo que ela: a página pedida antes do
//! fim do turno, o aceite de um envio cujo turno já acabou. Por isso nada aqui troca a conversa
//! inteira: cada mensagem recebida é comparada com a que o app já tem, e a que terminou não volta
//! a `em_andamento`. É a mesma regra de `apps/mobile/src/lib/conversa.ts`.

use std::collections::{HashMap, HashSet};

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
    /// Em ordem crescente de `seq`, sem repetição.
    pub mensagens: Vec<Mensagem>,
    /// Há mensagens mais antigas no servidor do que a primeira desta lista.
    pub tem_mais: bool,
}

/// O servidor conta a posição de um trecho como o JavaScript conta o tamanho de um texto.
fn tamanho_utf16(texto: &str) -> u64 {
    texto.encode_utf16().count() as u64
}

fn terminou(mensagem: &Mensagem) -> bool {
    mensagem.estado != MensagemEstado::EmAndamento
}

/// Entre a cópia que o app tem e a recebida da mesma mensagem, a que terminou vence: uma resposta
/// HTTP montada antes do fim do turno pode chegar depois do evento `turno_terminado`. Com as duas
/// em andamento, fica a que foi mais longe: são começos da mesma resposta.
fn mais_recente(local: Option<Mensagem>, recebida: Mensagem) -> Mensagem {
    match local {
        Some(local) if !terminou(&recebida) && (terminou(&local) || local.texto.len() > recebida.texto.len()) => local,
        _ => recebida,
    }
}

impl Conversa {
    /// Aplica a página mais recente (`GET mensagens` sem `antes`). A página manda no trecho que
    /// cobre, mensagem por mensagem, sem desfazer o que já terminou. As mais antigas já carregadas
    /// só ficam se a página emenda nelas, e as que chegaram por evento depois da página ficam no fim.
    pub fn aplicar_pagina_recente(&mut self, pagina: Vec<Mensagem>, tem_mais: bool) {
        let (Some(primeira), Some(ultima)) = (pagina.first(), pagina.last()) else {
            // Página vazia: o que o app tem chegou por evento, depois de ela ser montada.
            self.tem_mais = false;
            return;
        };
        let (primeiro_seq, ultimo_seq) = (primeira.seq, ultima.seq);
        let emenda = self.mensagens.iter().any(|local| local.id == primeira.id);
        let (mut anteriores, mut cobertas, mut posteriores) = (Vec::new(), HashMap::new(), Vec::new());
        for local in std::mem::take(&mut self.mensagens) {
            if local.seq > ultimo_seq {
                posteriores.push(local);
            } else if local.seq >= primeiro_seq {
                cobertas.insert(local.id.clone(), local);
            } else if emenda {
                anteriores.push(local);
            }
        }
        // Com as anteriores no lugar, quem sabe se há mais antes delas é a página que as trouxe.
        if anteriores.is_empty() {
            self.tem_mais = tem_mais;
        }
        self.mensagens = anteriores;
        self.mensagens.extend(pagina.into_iter().map(|recebida| mais_recente(cobertas.remove(&recebida.id), recebida)));
        self.mensagens.extend(posteriores);
    }

    /// O `seq` que pede a página anterior à mensagem mais antiga que o app tem; `None` se o
    /// servidor não tem nada antes dela.
    pub fn cursor_das_anteriores(&self) -> Option<u64> {
        self.mensagens.first().filter(|_| self.tem_mais).map(|primeira| primeira.seq)
    }

    /// Aplica a página de mensagens anteriores a `antes`, pedida com `cursor_das_anteriores`. O
    /// que chegou por evento durante o pedido fica onde está. Se a conversa mudou de começo
    /// enquanto o pedido corria, a página não emenda mais: é descartada, e a função devolve `false`.
    pub fn aplicar_pagina_anterior(&mut self, antes: u64, pagina: Vec<Mensagem>, tem_mais: bool) -> bool {
        if self.mensagens.first().map(|primeira| primeira.seq) != Some(antes) {
            return false;
        }
        let conhecidas: HashSet<&str> = self.mensagens.iter().map(|mensagem| mensagem.id.as_str()).collect();
        let mut juntas: Vec<Mensagem> =
            pagina.into_iter().filter(|mensagem| mensagem.seq < antes && !conhecidas.contains(mensagem.id.as_str())).collect();
        juntas.append(&mut self.mensagens);
        self.mensagens = juntas;
        self.tem_mais = tem_mais;
        true
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

/// A última resposta que cada bot terminou, pelo que o fluxo e as páginas contaram. Os turnos de
/// um bot vêm um depois do outro: se o app já viu terminada uma mensagem de `seq` igual ou maior,
/// o turno daquela resposta acabou. É o que impede o aceite atrasado de um envio de marcar como
/// "respondendo" um bot cujo turno já terminou.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TurnosTerminados {
    por_bot: HashMap<String, u64>,
}

impl TurnosTerminados {
    /// Uma mensagem que o app viu terminada. A que ainda está em andamento não conta.
    pub fn registrar(&mut self, mensagem: &Mensagem) {
        if !terminou(mensagem) {
            return;
        }
        let ultimo = self.por_bot.entry(mensagem.bot_id.clone()).or_insert(mensagem.seq);
        *ultimo = (*ultimo).max(mensagem.seq);
    }

    /// O turno desta resposta já acabou, pelo que o app viu.
    pub fn ja_terminou(&self, resposta: &Mensagem) -> bool {
        terminou(resposta) || self.por_bot.get(&resposta.bot_id).is_some_and(|ultimo| *ultimo >= resposta.seq)
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
            ..Conversa::default()
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

    // --- Página mais recente: resposta HTTP que chega depois de um evento ---------------------

    fn pergunta() -> Mensagem {
        mensagem("pergunta00000001", 1, MensagemPapel::Usuario, "oi", MensagemEstado::Completa)
    }

    fn resposta(texto: &str, estado: MensagemEstado) -> Mensagem {
        mensagem("resposta00000002", 2, MensagemPapel::Bot, texto, estado)
    }

    fn fim_do_turno(mensagem: &Mensagem) -> Evento {
        Evento::TurnoTerminado { bot_id: BOT.into(), mensagem: mensagem.clone() }
    }

    /// Mensagem `seq` de uma conversa longa: a pessoa nas ímpares, o bot nas pares.
    fn da_conversa_longa(seq: u64) -> Mensagem {
        let papel = if seq % 2 == 1 { MensagemPapel::Usuario } else { MensagemPapel::Bot };
        mensagem(&format!("msg{seq:013}"), seq, papel, &format!("texto {seq}"), MensagemEstado::Completa)
    }

    fn seqs(conversa: &Conversa) -> Vec<u64> {
        conversa.mensagens.iter().map(|mensagem| mensagem.seq).collect()
    }

    #[test]
    fn pagina_pedida_antes_do_fim_do_turno_nao_devolve_a_resposta_a_em_andamento() {
        let mut conversa = em_andamento("Você");
        let completa = resposta("Você disse: oi", MensagemEstado::Completa);
        conversa.aplicar(BOT, &fim_do_turno(&completa));
        // A página foi montada no servidor antes de o turno acabar, e chega depois do evento.
        conversa.aplicar_pagina_recente(vec![pergunta(), resposta("Você", MensagemEstado::EmAndamento)], false);
        assert_eq!(conversa.mensagens, vec![pergunta(), completa]);
    }

    #[test]
    fn nenhum_desfecho_volta_a_em_andamento_com_uma_pagina_antiga() {
        for desfecho in [MensagemEstado::Completa, MensagemEstado::Parada, MensagemEstado::Falhou] {
            let mut conversa = em_andamento("Você");
            let terminada = resposta("Você disse", desfecho);
            conversa.aplicar(BOT, &fim_do_turno(&terminada));
            conversa.aplicar_pagina_recente(vec![pergunta(), resposta("", MensagemEstado::EmAndamento)], false);
            assert_eq!(conversa.mensagens[1], terminada, "{desfecho:?}");
        }
    }

    #[test]
    fn pagina_antiga_traz_o_que_faltava_sem_mexer_na_resposta_que_o_fluxo_ja_terminou() {
        // O app só tem a resposta, que chegou pelo fim do turno; a página traz a pergunta.
        let mut conversa = Conversa::default();
        let completa = resposta("Você disse: oi", MensagemEstado::Completa);
        conversa.aplicar(BOT, &fim_do_turno(&completa));
        conversa.aplicar_pagina_recente(vec![pergunta(), resposta("Você", MensagemEstado::EmAndamento)], false);
        assert_eq!(conversa.mensagens, vec![pergunta(), completa]);
    }

    #[test]
    fn pagina_em_dia_troca_a_resposta_em_andamento_pela_terminada() {
        // O caminho contrário continua valendo: é a página que conta o fim de um turno que o app não viu acabar.
        let mut conversa = em_andamento("Você");
        let parada = resposta("Você disse", MensagemEstado::Parada);
        conversa.aplicar_pagina_recente(vec![pergunta(), parada.clone()], false);
        assert_eq!(conversa.mensagens, vec![pergunta(), parada]);
    }

    #[test]
    fn pagina_mais_curta_nao_encurta_a_resposta_em_andamento_e_a_mais_longa_a_completa() {
        let mut conversa = em_andamento("Você disse");
        conversa.aplicar_pagina_recente(vec![pergunta(), resposta("Você", MensagemEstado::EmAndamento)], false);
        assert_eq!(conversa.mensagens[1].texto, "Você disse");
        // O trecho seguinte encaixa onde o app estava, sem pedir outra busca.
        assert_eq!(conversa.aplicar(BOT, &trecho(10, ": oi")), Efeito::Nada);
        conversa.aplicar_pagina_recente(vec![pergunta(), resposta("Você disse: oi, tudo", MensagemEstado::EmAndamento)], false);
        assert_eq!(conversa.mensagens[1].texto, "Você disse: oi, tudo");
    }

    #[test]
    fn mensagem_que_chegou_por_evento_depois_da_pagina_fica_no_fim() {
        let mut conversa = Conversa { mensagens: vec![da_conversa_longa(1), da_conversa_longa(2)], ..Conversa::default() };
        // Outro turno terminou enquanto a página, montada antes dele, estava a caminho.
        conversa.aplicar(BOT, &fim_do_turno(&da_conversa_longa(4)));
        conversa.aplicar_pagina_recente(vec![da_conversa_longa(1), da_conversa_longa(2)], false);
        assert_eq!(seqs(&conversa), vec![1, 2, 4]);
    }

    #[test]
    fn pagina_vazia_nao_apaga_o_que_chegou_por_evento() {
        let mut conversa = Conversa::default();
        let completa = resposta("Você disse: oi", MensagemEstado::Completa);
        conversa.aplicar(BOT, &fim_do_turno(&completa));
        conversa.aplicar_pagina_recente(Vec::new(), false);
        assert_eq!(conversa.mensagens, vec![completa]);
        assert!(!conversa.tem_mais);
    }

    // --- Páginas anteriores -----------------------------------------------------------------

    fn pagina(seqs: std::ops::RangeInclusive<u64>) -> Vec<Mensagem> {
        seqs.map(da_conversa_longa).collect()
    }

    #[test]
    fn a_pagina_recente_diz_se_ha_mensagens_anteriores_e_qual_e_o_cursor() {
        let mut conversa = Conversa::default();
        assert_eq!(conversa.cursor_das_anteriores(), None);
        conversa.aplicar_pagina_recente(pagina(3..=52), true);
        assert_eq!(seqs(&conversa), (3..=52).collect::<Vec<_>>());
        assert_eq!(conversa.cursor_das_anteriores(), Some(3));

        let mut curta = Conversa::default();
        curta.aplicar_pagina_recente(pagina(1..=4), false);
        assert_eq!(curta.cursor_das_anteriores(), None);
    }

    #[test]
    fn a_pagina_anterior_entra_no_comeco_sem_repetir_nada() {
        let mut conversa = Conversa::default();
        conversa.aplicar_pagina_recente(pagina(3..=52), true);
        // A página traz, de sobra, uma mensagem que o app já tem.
        assert!(conversa.aplicar_pagina_anterior(3, pagina(1..=3), false));
        assert_eq!(seqs(&conversa), (1..=52).collect::<Vec<_>>());
        assert_eq!(conversa.cursor_das_anteriores(), None);
        // A mesma página, de novo, não emenda mais nem repete nada.
        assert!(!conversa.aplicar_pagina_anterior(3, pagina(1..=2), false));
        assert_eq!(seqs(&conversa), (1..=52).collect::<Vec<_>>());
    }

    #[test]
    fn eventos_que_chegam_durante_o_pedido_das_anteriores_ficam_como_estao() {
        let mut conversa = Conversa::default();
        conversa.aplicar_pagina_recente(pagina(3..=52), true);
        // Enquanto a página anterior está a caminho, um turno novo começa, fala e termina.
        let pergunta = Mensagem { texto: "mais uma".into(), ..da_conversa_longa(53) };
        let vazia = Mensagem { texto: String::new(), estado: MensagemEstado::EmAndamento, ..da_conversa_longa(54) };
        conversa.registrar_turno(RespostaTurno { usuario: pergunta.clone(), bot: vazia.clone() });
        let fala = Evento::Texto { bot_id: BOT.into(), mensagem_id: vazia.id.clone(), posicao: 0, trecho: "Você disse".into() };
        assert_eq!(conversa.aplicar(BOT, &fala), Efeito::Nada);
        let completa = Mensagem { texto: "Você disse: mais uma".into(), ..da_conversa_longa(54) };
        conversa.aplicar(BOT, &fim_do_turno(&completa));

        assert!(conversa.aplicar_pagina_anterior(3, pagina(1..=2), false));
        assert_eq!(seqs(&conversa), (1..=54).collect::<Vec<_>>());
        assert_eq!(conversa.mensagens[53], completa);
        assert_eq!(conversa.mensagens[52], pergunta);
    }

    #[test]
    fn a_pagina_anterior_diz_se_ainda_ha_mais_e_o_cursor_anda() {
        let mut conversa = Conversa::default();
        conversa.aplicar_pagina_recente(pagina(101..=150), true);
        assert!(conversa.aplicar_pagina_anterior(101, pagina(51..=100), true));
        assert_eq!(conversa.cursor_das_anteriores(), Some(51));
        assert!(conversa.aplicar_pagina_anterior(51, pagina(1..=50), false));
        assert_eq!(seqs(&conversa), (1..=150).collect::<Vec<_>>());
        assert_eq!(conversa.cursor_das_anteriores(), None);
    }

    #[test]
    fn pagina_anterior_que_nao_emenda_mais_e_descartada() {
        let mut conversa = Conversa::default();
        conversa.aplicar_pagina_recente(pagina(53..=102), true);
        // Durante o pedido das anteriores a 53, a conversa foi buscada de novo e começa em outro lugar.
        conversa.aplicar_pagina_recente(pagina(153..=202), true);
        assert!(!conversa.aplicar_pagina_anterior(53, pagina(3..=52), true));
        assert_eq!(seqs(&conversa), (153..=202).collect::<Vec<_>>());
        assert_eq!(conversa.cursor_das_anteriores(), Some(153));
        // Conversa vazia também não emenda.
        assert!(!Conversa::default().aplicar_pagina_anterior(3, pagina(1..=2), false));
    }

    #[test]
    fn a_pagina_recente_mantem_as_anteriores_ja_carregadas_quando_emenda_nelas() {
        let mut conversa = Conversa::default();
        conversa.aplicar_pagina_recente(pagina(3..=52), true);
        assert!(conversa.aplicar_pagina_anterior(3, pagina(1..=2), false));
        // Nova busca da página mais recente, depois de mais um turno: ela começa numa mensagem que o app tem.
        conversa.aplicar_pagina_recente(pagina(5..=54), true);
        assert_eq!(seqs(&conversa), (1..=54).collect::<Vec<_>>());
        // Quem sabe que não há nada antes da 1 é a página que a trouxe, não a mais recente.
        assert_eq!(conversa.cursor_das_anteriores(), None);
    }

    // --- Marca de turno ativo ---------------------------------------------------------------

    #[test]
    fn o_aceite_de_um_envio_cujo_turno_ja_terminou_nao_conta_como_turno_ativo() {
        let mut terminados = TurnosTerminados::default();
        let vazia = resposta("", MensagemEstado::EmAndamento);
        assert!(!terminados.ja_terminou(&vazia), "sem notícia do fim, o turno do aceite está em andamento");
        // O fim do turno chega pelo fluxo antes do aceite do envio.
        terminados.registrar(&resposta("Você disse: oi", MensagemEstado::Completa));
        assert!(terminados.ja_terminou(&vazia));
    }

    #[test]
    fn o_fim_de_um_turno_anterior_nao_encerra_o_turno_seguinte() {
        let mut terminados = TurnosTerminados::default();
        terminados.registrar(&resposta("Você disse: oi", MensagemEstado::Completa));
        let do_turno_seguinte = mensagem("resposta00000004", 4, MensagemPapel::Bot, "", MensagemEstado::EmAndamento);
        assert!(!terminados.ja_terminou(&do_turno_seguinte));
        // A mensagem da pessoa, já completa, não encerra o turno que ela mesma abriu.
        terminados.registrar(&mensagem("pergunta00000003", 3, MensagemPapel::Usuario, "e agora?", MensagemEstado::Completa));
        assert!(!terminados.ja_terminou(&do_turno_seguinte));
        // A resposta ainda em andamento não conta como terminada.
        terminados.registrar(&do_turno_seguinte);
        assert!(!terminados.ja_terminou(&do_turno_seguinte));
        // Terminou; e um fim mais antigo que chegue depois não desfaz o mais novo.
        terminados.registrar(&Mensagem { estado: MensagemEstado::Parada, ..do_turno_seguinte.clone() });
        terminados.registrar(&resposta("Você disse: oi", MensagemEstado::Completa));
        assert!(terminados.ja_terminou(&do_turno_seguinte));
    }

    #[test]
    fn o_fim_do_turno_de_um_bot_nao_vale_para_outro() {
        let mut terminados = TurnosTerminados::default();
        terminados.registrar(&Mensagem { bot_id: "outrobot00000009".into(), ..resposta("fim", MensagemEstado::Completa) });
        assert!(!terminados.ja_terminou(&resposta("", MensagemEstado::EmAndamento)));
    }
}
