//! Os pedidos de aprovação que o app conhece: os pendentes e os resolvidos nesta execução.
//!
//! É a mesma regra de `apps/mobile/src/lib/aprovacoes.ts`. O pedido resolvido não muda mais: uma
//! cópia pendente que chega atrasada (lista velha, evento repetido) não desfaz o desfecho que o
//! app já conhece. E uma lista que pode ser mais velha que um evento só acrescenta o que o app
//! não conhecia; não tira nem troca nada.

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashSet};

use crate::contrato::{Aprovacao, AprovacaoEstado, Bot, Mensagem};

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Aprovacoes {
    por_id: BTreeMap<String, Aprovacao>,
    /// Sobe a cada evento de aprovação. Quem busca a lista de pendentes guarda o valor antes do
    /// pedido: se subiu no meio, a lista pode ser mais velha que o evento e não manda em nada.
    revisao: u64,
}

fn pendente(aprovacao: &Aprovacao) -> bool {
    aprovacao.estado == AprovacaoEstado::Pendente
}

/// Da mais antiga para a mais nova; o id desempata as que nasceram no mesmo instante.
fn por_criacao(a: &Aprovacao, b: &Aprovacao) -> Ordering {
    a.criada_em.cmp(&b.criada_em).then_with(|| a.id.cmp(&b.id))
}

impl Aprovacoes {
    pub fn revisao(&self) -> u64 {
        self.revisao
    }

    /// Guarda a aprovação recebida, a não ser que o app já tenha o desfecho dela ou a mesma cópia.
    fn guardar(&mut self, recebida: Aprovacao) {
        match self.por_id.get(&recebida.id) {
            Some(local) if local.estado == recebida.estado || !pendente(local) => {}
            _ => {
                self.por_id.insert(recebida.id.clone(), recebida);
            }
        }
    }

    /// `aprovacao_pedida` ou `aprovacao_resolvida` do fluxo. Sempre sobe a revisão. A resolvida de
    /// um pedido desconhecido entra do mesmo jeito.
    pub fn aplicar_evento(&mut self, aprovacao: Aprovacao) {
        self.guardar(aprovacao);
        self.revisao += 1;
    }

    /// A aprovação já resolvida que o servidor devolveu a uma decisão. Não sobe a revisão.
    pub fn aplicar_decisao(&mut self, aprovacao: Aprovacao) {
        self.guardar(aprovacao);
    }

    /// A lista de `GET /v1/aprovacoes`. `revisao_no_pedido` é a revisão que o app tinha ao pedir a
    /// lista. Devolve `true` se a lista estava em dia; com `false`, quem chamou busca de novo.
    ///
    /// Lista em dia: o pendente local que não está nela deixou de ser pendente no servidor e sai.
    /// Lista possivelmente velha (chegou evento de aprovação durante o pedido): só entram os
    /// pedidos que o app não conhecia; nada sai e nada é trocado.
    pub fn aplicar_pendentes(&mut self, pendentes: Vec<Aprovacao>, revisao_no_pedido: u64) -> bool {
        let em_dia = self.revisao == revisao_no_pedido;
        if em_dia {
            let na_lista: HashSet<&str> = pendentes.iter().map(|aprovacao| aprovacao.id.as_str()).collect();
            self.por_id.retain(|id, local| !pendente(local) || na_lista.contains(id.as_str()));
        }
        for recebida in pendentes {
            if em_dia || !self.por_id.contains_key(&recebida.id) {
                self.guardar(recebida);
            }
        }
        em_dia
    }

    pub fn obter(&self, id: &str) -> Option<&Aprovacao> {
        self.por_id.get(id)
    }

    /// As aprovações de um bot, da mais antiga para a mais nova (criada_em, depois id).
    pub fn do_bot(&self, bot_id: &str) -> Vec<&Aprovacao> {
        let mut do_bot: Vec<&Aprovacao> = self.por_id.values().filter(|aprovacao| aprovacao.bot_id == bot_id).collect();
        do_bot.sort_by(|a, b| por_criacao(a, b));
        do_bot
    }

    pub fn tem_pendente(&self, bot_id: &str) -> bool {
        self.por_id.values().any(|aprovacao| aprovacao.bot_id == bot_id && pendente(aprovacao))
    }
}

/// O que a lista de bots diz de um bot que não está parado.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Situacao {
    AguardandoAprovacao,
    Respondendo,
}

impl Situacao {
    /// O texto da lista de bots, igual ao do app de celular.
    pub fn rotulo(self) -> &'static str {
        match self {
            Self::AguardandoAprovacao => "aguardando aprovação",
            Self::Respondendo => "respondendo…",
        }
    }
}

/// Pedido de aprovação pendente vem antes de "respondendo": o bot está parado à espera da pessoa,
/// e é isso que ela precisa saber.
pub fn situacao_do_bot(bot: &Bot, aprovacoes: &Aprovacoes) -> Option<Situacao> {
    if aprovacoes.tem_pendente(&bot.id) {
        return Some(Situacao::AguardandoAprovacao);
    }
    bot.turno_ativo.then_some(Situacao::Respondendo)
}

/// A palavra da linha compacta de um pedido resolvido; `None` enquanto está pendente.
pub fn rotulo_do_desfecho(estado: AprovacaoEstado) -> Option<&'static str> {
    match estado {
        AprovacaoEstado::Pendente => None,
        AprovacaoEstado::Aprovada => Some("Aprovada"),
        AprovacaoEstado::Negada => Some("Negada"),
        AprovacaoEstado::Expirada => Some("Expirada"),
    }
}

/// Uma linha da conversa: uma mensagem ou um pedido de aprovação. Os dois têm ids do mesmo
/// formato; é a variante que os separa.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Item<'a> {
    Mensagem(&'a Mensagem),
    Aprovacao(&'a Aprovacao),
}

/// Põe cada aprovação logo depois da resposta do bot em que ela surgiu. Ordem crescente: a
/// conversa do desktop vai da mais antiga para a mais nova, ao contrário da lista invertida do
/// celular. Cada mensagem vem seguida das aprovações que surgiram nela, a mais antiga primeiro.
/// O pedido pendente cuja mensagem o app ainda não tem fica no fim da conversa, à vista; o
/// resolvido nessa situação não aparece, porque não haveria onde encaixá-lo.
pub fn intercalar<'a>(mensagens: &'a [Mensagem], aprovacoes: &[&'a Aprovacao]) -> Vec<Item<'a>> {
    let mut da_mais_antiga: Vec<&'a Aprovacao> = aprovacoes.to_vec();
    da_mais_antiga.sort_by(|a, b| por_criacao(a, b));

    let mut itens = Vec::with_capacity(mensagens.len() + da_mais_antiga.len());
    for mensagem in mensagens {
        itens.push(Item::Mensagem(mensagem));
        itens.extend(
            da_mais_antiga.iter().filter(|aprovacao| aprovacao.mensagem_id == mensagem.id).map(|aprovacao| Item::Aprovacao(aprovacao)),
        );
    }
    let conhecidas: HashSet<&str> = mensagens.iter().map(|mensagem| mensagem.id.as_str()).collect();
    itens.extend(
        da_mais_antiga
            .iter()
            .filter(|aprovacao| pendente(aprovacao) && !conhecidas.contains(aprovacao.mensagem_id.as_str()))
            .map(|aprovacao| Item::Aprovacao(aprovacao)),
    );
    itens
}

#[cfg(test)]
mod testes {
    use super::*;
    use crate::contrato::{MensagemEstado, MensagemPapel};

    use AprovacaoEstado::{Aprovada, Expirada, Negada, Pendente};

    const BOT_A: &str = "bot0000000000001";
    const BOT_B: &str = "bot0000000000002";

    fn id_mensagem(seq: u64) -> String {
        format!("msg{seq:013}")
    }

    /// Aprovação `n`, pendente, do bot A, criada no instante `n`.
    fn aprovacao(n: u64) -> Aprovacao {
        Aprovacao {
            id: format!("apr{n:013}"),
            bot_id: BOT_A.into(),
            mensagem_id: id_mensagem(2),
            ferramenta: "Bash".into(),
            resumo: format!("comando {n}"),
            estado: Pendente,
            criada_em: n,
            resolvida_em: None,
        }
    }

    fn resolvida(n: u64, estado: AprovacaoEstado) -> Aprovacao {
        Aprovacao { estado, resolvida_em: Some(n + 100), ..aprovacao(n) }
    }

    fn do_bot_b(aprovacao: Aprovacao) -> Aprovacao {
        Aprovacao { bot_id: BOT_B.into(), ..aprovacao }
    }

    fn na_mensagem(seq: u64, aprovacao: Aprovacao) -> Aprovacao {
        Aprovacao { mensagem_id: id_mensagem(seq), ..aprovacao }
    }

    fn mensagem(seq: u64, estado: MensagemEstado) -> Mensagem {
        Mensagem {
            id: id_mensagem(seq),
            bot_id: BOT_A.into(),
            seq,
            papel: if seq % 2 == 1 { MensagemPapel::Usuario } else { MensagemPapel::Bot },
            texto: format!("texto {seq}"),
            estado,
            criada_em: seq,
        }
    }

    fn bot(turno_ativo: bool) -> Bot {
        Bot {
            id: BOT_A.into(),
            nome: "Ajudante".into(),
            instrucoes: String::new(),
            modelo: None,
            criado_em: 1,
            atualizado_em: 1,
            turno_ativo,
        }
    }

    /// O estado depois de cada aprovação chegar por evento, na ordem dada.
    fn com(aprovacoes: impl IntoIterator<Item = Aprovacao>) -> Aprovacoes {
        let mut estado = Aprovacoes::default();
        for aprovacao in aprovacoes {
            estado.aplicar_evento(aprovacao);
        }
        estado
    }

    /// O resumo e o estado de tudo o que o app conhece, na ordem dos ids.
    fn estados(estado: &Aprovacoes) -> Vec<(&str, AprovacaoEstado)> {
        estado.por_id.values().map(|aprovacao| (aprovacao.resumo.as_str(), aprovacao.estado)).collect()
    }

    // --- aplicar_evento ---------------------------------------------------------------------

    #[test]
    fn aprovacao_pedida_guarda_o_pedido_pendente_e_sobe_a_revisao() {
        let mut estado = Aprovacoes::default();
        assert_eq!(estado.revisao(), 0);
        estado.aplicar_evento(aprovacao(1));
        assert_eq!(estado.obter(&aprovacao(1).id), Some(&aprovacao(1)));
        assert_eq!(estado.revisao(), 1);
    }

    #[test]
    fn aprovacao_resolvida_troca_o_pendente_pelo_desfecho() {
        for desfecho in [Aprovada, Negada, Expirada] {
            let mut estado = com([aprovacao(1)]);
            estado.aplicar_evento(resolvida(1, desfecho));
            assert_eq!(estado.obter(&aprovacao(1).id), Some(&resolvida(1, desfecho)), "{desfecho:?}");
            assert_eq!(estado.revisao(), 2);
        }
    }

    #[test]
    fn aprovacao_resolvida_de_um_pedido_desconhecido_entra_do_mesmo_jeito() {
        let mut estado = Aprovacoes::default();
        estado.aplicar_evento(resolvida(7, Expirada));
        assert_eq!(estados(&estado), vec![("comando 7", Expirada)]);
        assert_eq!(estado.revisao(), 1);
    }

    #[test]
    fn pedido_resolvido_nao_volta_a_pendente_com_um_aprovacao_pedida_atrasado() {
        let mut estado = com([aprovacao(1), resolvida(1, Negada)]);
        let revisao = estado.revisao();
        estado.aplicar_evento(aprovacao(1));
        assert_eq!(estado.obter(&aprovacao(1).id), Some(&resolvida(1, Negada)));
        assert_eq!(estado.revisao(), revisao + 1);
    }

    #[test]
    fn um_desfecho_nao_troca_outro() {
        let mut estado = com([aprovacao(1), resolvida(1, Expirada)]);
        estado.aplicar_evento(resolvida(1, Aprovada));
        assert_eq!(estados(&estado), vec![("comando 1", Expirada)]);
    }

    /// No celular, o estado é um valor que não se altera e cada função devolve outro. Aqui a
    /// mudança é no lugar, e o que precisa valer é o mesmo: a cópia tirada antes não acompanha.
    #[test]
    fn a_copia_tirada_antes_nao_muda() {
        let antes = com([aprovacao(1)]);
        let mut depois = antes.clone();
        depois.aplicar_evento(resolvida(1, Aprovada));
        assert_eq!(estados(&antes), vec![("comando 1", Pendente)]);
        assert_eq!(antes.revisao(), 1);
        assert_ne!(antes, depois);
    }

    // --- aplicar_decisao --------------------------------------------------------------------

    #[test]
    fn a_decisao_guarda_a_aprovacao_resolvida_sem_mexer_na_revisao() {
        let mut estado = com([aprovacao(1)]);
        let revisao = estado.revisao();
        estado.aplicar_decisao(resolvida(1, Aprovada));
        assert_eq!(estados(&estado), vec![("comando 1", Aprovada)]);
        assert_eq!(estado.revisao(), revisao);
    }

    #[test]
    fn a_decisao_nao_desfaz_o_desfecho_que_ja_chegou_por_evento() {
        let expirada = com([aprovacao(1), resolvida(1, Expirada)]);
        let mut estado = expirada.clone();
        estado.aplicar_decisao(resolvida(1, Aprovada));
        assert_eq!(estado, expirada);
    }

    // --- aplicar_pendentes ------------------------------------------------------------------

    #[test]
    fn a_primeira_lista_poe_os_pendentes_no_estado() {
        let mut estado = Aprovacoes::default();
        assert!(estado.aplicar_pendentes(vec![aprovacao(1), do_bot_b(aprovacao(2))], 0));
        assert_eq!(estados(&estado), vec![("comando 1", Pendente), ("comando 2", Pendente)]);
        assert_eq!(estado.revisao(), 0);
    }

    #[test]
    fn lista_em_dia_tira_o_pendente_que_nao_veio_nela() {
        // Ele deixou de ser pendente no servidor.
        let mut estado = com([aprovacao(1), aprovacao(2)]);
        let revisao = estado.revisao();
        assert!(estado.aplicar_pendentes(vec![aprovacao(2)], revisao));
        assert_eq!(estados(&estado), vec![("comando 2", Pendente)]);
        assert_eq!(estado.revisao(), revisao);
    }

    #[test]
    fn lista_em_dia_e_vazia_tira_todos_os_pendentes_e_deixa_os_resolvidos() {
        let mut estado = com([aprovacao(1), aprovacao(2), resolvida(1, Aprovada)]);
        let revisao = estado.revisao();
        assert!(estado.aplicar_pendentes(Vec::new(), revisao));
        assert_eq!(estados(&estado), vec![("comando 1", Aprovada)]);
    }

    #[test]
    fn lista_igual_ao_que_o_app_ja_tem_nao_muda_nada() {
        let antes = com([aprovacao(1), aprovacao(2)]);
        let mut estado = antes.clone();
        assert!(estado.aplicar_pendentes(vec![aprovacao(1), aprovacao(2)], antes.revisao()));
        assert_eq!(estado, antes);
    }

    #[test]
    fn pendente_da_lista_nao_desfaz_o_desfecho_que_o_app_ja_conhece() {
        let mut estado = com([aprovacao(1), resolvida(1, Negada)]);
        let revisao = estado.revisao();
        assert!(estado.aplicar_pendentes(vec![aprovacao(1)], revisao));
        assert_eq!(estados(&estado), vec![("comando 1", Negada)]);
    }

    // Lista que pode ser mais velha que um evento.

    #[test]
    fn lista_velha_nao_tira_o_pedido_que_chegou_por_evento_durante_a_busca() {
        let mut estado = com([aprovacao(1)]);
        let revisao_no_pedido = estado.revisao();
        // A lista foi montada só com o pedido 1; o 2 nasceu depois e chegou por evento antes dela.
        estado.aplicar_evento(aprovacao(2));
        assert!(!estado.aplicar_pendentes(vec![aprovacao(1)], revisao_no_pedido));
        assert_eq!(estados(&estado), vec![("comando 1", Pendente), ("comando 2", Pendente)]);
    }

    #[test]
    fn lista_velha_nao_devolve_a_pendente_o_pedido_resolvido_por_evento_durante_a_busca() {
        let mut estado = com([aprovacao(1)]);
        let revisao_no_pedido = estado.revisao();
        estado.aplicar_evento(resolvida(1, Aprovada));
        assert!(!estado.aplicar_pendentes(vec![aprovacao(1)], revisao_no_pedido));
        assert_eq!(estados(&estado), vec![("comando 1", Aprovada)]);
    }

    #[test]
    fn lista_velha_nao_tira_nenhum_pendente_nem_o_que_de_fato_ja_foi_resolvido() {
        // Isso fica para a busca seguinte.
        let mut estado = com([aprovacao(1), aprovacao(2)]);
        let revisao_no_pedido = estado.revisao();
        estado.aplicar_evento(aprovacao(3));
        assert!(!estado.aplicar_pendentes(vec![aprovacao(2)], revisao_no_pedido));
        assert_eq!(estados(&estado), vec![("comando 1", Pendente), ("comando 2", Pendente), ("comando 3", Pendente)]);
    }

    #[test]
    fn lista_velha_ainda_acrescenta_o_pedido_que_o_app_nao_conhecia() {
        let mut estado = com([aprovacao(1)]);
        let revisao_no_pedido = estado.revisao();
        estado.aplicar_evento(aprovacao(2));
        assert!(!estado.aplicar_pendentes(vec![aprovacao(1), aprovacao(9)], revisao_no_pedido));
        assert_eq!(estados(&estado), vec![("comando 1", Pendente), ("comando 2", Pendente), ("comando 9", Pendente)]);
    }

    #[test]
    fn lista_velha_nao_troca_o_que_o_app_ja_tem() {
        let mut estado = com([aprovacao(1)]);
        let revisao_no_pedido = estado.revisao();
        estado.aplicar_evento(aprovacao(2));
        // Outra cópia do mesmo pedido, seja qual for: a local fica, e nem o estado dela é trocado.
        let outra_copia = Aprovacao { resumo: "outro resumo".into(), ..aprovacao(1) };
        assert!(!estado.aplicar_pendentes(vec![outra_copia, resolvida(2, Aprovada)], revisao_no_pedido));
        assert_eq!(estado.obter(&aprovacao(1).id), Some(&aprovacao(1)));
        assert_eq!(estado.obter(&aprovacao(2).id), Some(&aprovacao(2)));
    }

    #[test]
    fn a_busca_seguinte_em_dia_faz_a_limpeza() {
        let mut estado = com([aprovacao(1), aprovacao(2)]);
        let revisao_no_pedido = estado.revisao();
        estado.aplicar_evento(aprovacao(3));
        assert!(!estado.aplicar_pendentes(vec![aprovacao(2)], revisao_no_pedido));
        let revisao = estado.revisao();
        assert!(estado.aplicar_pendentes(vec![aprovacao(2), aprovacao(3)], revisao));
        assert_eq!(estados(&estado), vec![("comando 2", Pendente), ("comando 3", Pendente)]);
    }

    // --- do_bot, obter, tem_pendente --------------------------------------------------------

    #[test]
    fn do_bot_devolve_so_as_do_bot_da_mais_antiga_para_a_mais_nova() {
        let estado = com([aprovacao(3), aprovacao(1), do_bot_b(aprovacao(2)), resolvida(4, Negada)]);
        let criadas = |bot_id: &str| estado.do_bot(bot_id).iter().map(|aprovacao| aprovacao.criada_em).collect::<Vec<_>>();
        assert_eq!(criadas(BOT_A), vec![1, 3, 4]);
        assert_eq!(criadas(BOT_B), vec![2]);
        assert!(estado.do_bot("bot0000000000009").is_empty());
    }

    #[test]
    fn do_bot_segue_o_instante_da_criacao_e_nao_o_id() {
        let estado = com([Aprovacao { criada_em: 9, ..aprovacao(1) }, Aprovacao { criada_em: 5, ..aprovacao(2) }]);
        let resumos: Vec<_> = estado.do_bot(BOT_A).iter().map(|aprovacao| aprovacao.resumo.as_str()).collect();
        assert_eq!(resumos, vec!["comando 2", "comando 1"]);
    }

    #[test]
    fn do_bot_desempata_pelo_id_quando_duas_nasceram_no_mesmo_instante() {
        let estado = com([Aprovacao { criada_em: 5, ..aprovacao(2) }, Aprovacao { criada_em: 5, ..aprovacao(1) }]);
        let resumos: Vec<_> = estado.do_bot(BOT_A).iter().map(|aprovacao| aprovacao.resumo.as_str()).collect();
        assert_eq!(resumos, vec!["comando 1", "comando 2"]);
    }

    #[test]
    fn obter_acha_pelo_id() {
        let estado = com([aprovacao(1), resolvida(2, Negada)]);
        assert_eq!(estado.obter(&aprovacao(2).id), Some(&resolvida(2, Negada)));
        assert_eq!(estado.obter("apr0000000000009"), None);
    }

    #[test]
    fn tem_pendente_so_conta_pedido_pendente_do_proprio_bot() {
        assert!(!Aprovacoes::default().tem_pendente(BOT_A));
        assert!(com([aprovacao(1)]).tem_pendente(BOT_A));
        assert!(!com([aprovacao(1)]).tem_pendente(BOT_B));
        assert!(!com([resolvida(1, Aprovada)]).tem_pendente(BOT_A));
        assert!(com([resolvida(1, Aprovada), aprovacao(2)]).tem_pendente(BOT_A));
    }

    // --- situacao_do_bot --------------------------------------------------------------------

    #[test]
    fn bot_parado_e_sem_pedido_nao_tem_situacao() {
        assert_eq!(situacao_do_bot(&bot(false), &Aprovacoes::default()), None);
    }

    #[test]
    fn bot_com_turno_ativo_esta_respondendo() {
        assert_eq!(situacao_do_bot(&bot(true), &Aprovacoes::default()), Some(Situacao::Respondendo));
    }

    #[test]
    fn pedido_pendente_vem_antes_de_respondendo() {
        assert_eq!(situacao_do_bot(&bot(true), &com([aprovacao(1)])), Some(Situacao::AguardandoAprovacao));
    }

    #[test]
    fn pedido_pendente_aparece_mesmo_se_o_app_ainda_nao_sabe_do_turno() {
        assert_eq!(situacao_do_bot(&bot(false), &com([aprovacao(1)])), Some(Situacao::AguardandoAprovacao));
    }

    #[test]
    fn pedido_de_outro_bot_ou_ja_resolvido_nao_conta() {
        assert_eq!(situacao_do_bot(&bot(true), &com([do_bot_b(aprovacao(1))])), Some(Situacao::Respondendo));
        assert_eq!(situacao_do_bot(&bot(true), &com([resolvida(1, Aprovada)])), Some(Situacao::Respondendo));
        assert_eq!(situacao_do_bot(&bot(false), &com([resolvida(1, Expirada)])), None);
    }

    #[test]
    fn os_rotulos_sao_os_da_lista_de_bots() {
        assert_eq!(Situacao::AguardandoAprovacao.rotulo(), "aguardando aprovação");
        assert_eq!(Situacao::Respondendo.rotulo(), "respondendo…");
    }

    // --- rotulo_do_desfecho -----------------------------------------------------------------

    #[test]
    fn nomeia_cada_desfecho_e_nao_rotula_o_pendente() {
        assert_eq!(rotulo_do_desfecho(Aprovada), Some("Aprovada"));
        assert_eq!(rotulo_do_desfecho(Negada), Some("Negada"));
        assert_eq!(rotulo_do_desfecho(Expirada), Some("Expirada"));
        assert_eq!(rotulo_do_desfecho(Pendente), None);
    }

    // --- intercalar -------------------------------------------------------------------------

    /// Mensagens 1 a 4, da mais antiga para a mais nova, como a janela usa.
    fn mensagens() -> Vec<Mensagem> {
        vec![
            mensagem(1, MensagemEstado::Completa),
            mensagem(2, MensagemEstado::Completa),
            mensagem(3, MensagemEstado::Completa),
            mensagem(4, MensagemEstado::EmAndamento),
        ]
    }

    fn chaves(itens: &[Item<'_>]) -> Vec<String> {
        itens
            .iter()
            .map(|item| match item {
                Item::Mensagem(mensagem) => format!("m{}", mensagem.seq),
                Item::Aprovacao(aprovacao) => format!("a{}", aprovacao.criada_em),
            })
            .collect()
    }

    #[test]
    fn sem_aprovacoes_devolve_as_mensagens_como_vieram() {
        let mensagens = mensagens();
        let itens = intercalar(&mensagens, &[]);
        assert_eq!(itens, mensagens.iter().map(Item::Mensagem).collect::<Vec<_>>());
        assert!(intercalar(&[], &[]).is_empty());
    }

    #[test]
    fn poe_o_pedido_pendente_depois_da_resposta_em_andamento_no_fim_da_conversa() {
        let mensagens = mensagens();
        let pendente = na_mensagem(4, aprovacao(1));
        assert_eq!(chaves(&intercalar(&mensagens, &[&pendente])), ["m1", "m2", "m3", "m4", "a1"]);
    }

    #[test]
    fn poe_cada_pedido_logo_depois_da_resposta_em_que_surgiu_do_mais_antigo_para_o_mais_novo() {
        let mensagens = mensagens();
        let (a3, a1, a2) = (na_mensagem(4, aprovacao(3)), na_mensagem(2, resolvida(1, Aprovada)), na_mensagem(2, resolvida(2, Negada)));
        // É a mesma conversa do teste do celular, lida na ordem em que aconteceu.
        assert_eq!(chaves(&intercalar(&mensagens, &[&a3, &a2, &a1])), ["m1", "m2", "a1", "a2", "m3", "m4", "a3"]);
    }

    #[test]
    fn pedido_pendente_de_mensagem_que_o_app_ainda_nao_tem_fica_no_fim_da_conversa_a_vista() {
        let mensagens = mensagens();
        let sem_mensagem = na_mensagem(6, aprovacao(1));
        assert_eq!(chaves(&intercalar(&mensagens, &[&sem_mensagem])), ["m1", "m2", "m3", "m4", "a1"]);
        let (a1, a2) = (aprovacao(1), aprovacao(2));
        assert_eq!(chaves(&intercalar(&[], &[&a2, &a1])), ["a1", "a2"]);
    }

    #[test]
    fn pedido_sem_mensagem_conhecida_fica_depois_de_todos_os_encaixados() {
        let mensagens = mensagens();
        // O pedido sem mensagem é o mais antigo de todos, e mesmo assim vai para o fim.
        let (sem_mensagem, encaixado) = (na_mensagem(6, aprovacao(1)), na_mensagem(4, aprovacao(2)));
        assert_eq!(chaves(&intercalar(&mensagens, &[&sem_mensagem, &encaixado])), ["m1", "m2", "m3", "m4", "a2", "a1"]);
    }

    #[test]
    fn pedido_resolvido_de_mensagem_que_o_app_nao_tem_nao_aparece() {
        let mensagens = mensagens();
        let resolvido = na_mensagem(6, resolvida(1, Expirada));
        assert_eq!(chaves(&intercalar(&mensagens, &[&resolvido])), ["m1", "m2", "m3", "m4"]);
    }

    #[test]
    fn reaproveita_os_objetos_de_mensagem_e_de_aprovacao() {
        let mensagens = mensagens();
        let pendente = na_mensagem(4, aprovacao(1));
        let itens = intercalar(&mensagens, &[&pendente]);
        assert!(matches!(itens[3], Item::Mensagem(mensagem) if std::ptr::eq(mensagem, &mensagens[3])));
        assert!(matches!(itens[4], Item::Aprovacao(aprovacao) if std::ptr::eq(aprovacao, &pendente)));
    }

    #[test]
    fn a_variante_separa_mensagem_de_aprovacao_com_o_mesmo_id() {
        // Mensagem e aprovação têm ids do mesmo formato; no celular, o tipo entra na chave da lista.
        let da_conversa = [mensagem(1, MensagemEstado::Completa)];
        let com_o_mesmo_id = Aprovacao { id: id_mensagem(1), mensagem_id: id_mensagem(1), ..aprovacao(1) };
        let itens = intercalar(&da_conversa, &[&com_o_mesmo_id]);
        assert_eq!(itens, vec![Item::Mensagem(&da_conversa[0]), Item::Aprovacao(&com_o_mesmo_id)]);
        assert_ne!(itens[0], itens[1]);
    }

    #[test]
    fn intercala_o_que_o_estado_devolve_para_o_bot() {
        let mensagens = mensagens();
        let estado = com([
            na_mensagem(4, aprovacao(3)),
            na_mensagem(2, aprovacao(1)),
            do_bot_b(aprovacao(2)),
            na_mensagem(2, resolvida(1, Aprovada)),
        ]);
        assert_eq!(chaves(&intercalar(&mensagens, &estado.do_bot(BOT_A))), ["m1", "m2", "a1", "m3", "m4", "a3"]);
    }
}
