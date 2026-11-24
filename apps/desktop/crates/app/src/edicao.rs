//! O texto de um campo e o que cada tecla faz com ele: cursor, seleção, limite e desfazer.
//!
//! Sem interface: o campo (`campo.rs`) traduz teclas e mouse para estas operações e desenha o
//! resultado. As posições são em bytes, sempre num limite de caractere.

use std::ops::Range;

use unicode_segmentation::UnicodeSegmentation;

/// Quantos passos o desfazer guarda.
const PASSOS_GUARDADOS: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Movimento {
    Esquerda,
    Direita,
    PalavraEsquerda,
    PalavraDireita,
    /// Início e fim do parágrafo em que o cursor está.
    InicioDaLinha,
    FimDaLinha,
    Inicio,
    Fim,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Foto {
    texto: String,
    ancora: usize,
    cursor: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tipo {
    Digitar,
    Apagar,
    Outro,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Classe {
    Palavra,
    Espaco,
    Pontuacao,
}

fn classe(letra: char) -> Classe {
    if letra.is_alphanumeric() || letra == '_' {
        Classe::Palavra
    } else if letra.is_whitespace() {
        Classe::Espaco
    } else {
        Classe::Pontuacao
    }
}

fn tamanho_utf16(texto: &str) -> usize {
    texto.encode_utf16().count()
}

#[derive(Debug)]
pub struct Edicao {
    texto: String,
    /// Onde a seleção começou; igual ao cursor quando não há seleção.
    ancora: usize,
    cursor: usize,
    /// Tamanho máximo, contado como o contrato conta: em caracteres (pontos de código).
    limite: usize,
    varias_linhas: bool,
    desfeitos: Vec<Foto>,
    refeitos: Vec<Foto>,
    ultima: Option<Tipo>,
}

impl Edicao {
    pub fn new(limite: usize, varias_linhas: bool) -> Self {
        Self {
            texto: String::new(),
            ancora: 0,
            cursor: 0,
            limite,
            varias_linhas,
            desfeitos: Vec::new(),
            refeitos: Vec::new(),
            ultima: None,
        }
    }

    pub fn texto(&self) -> &str {
        &self.texto
    }

    pub fn cursor(&self) -> usize {
        self.cursor
    }

    pub fn selecao(&self) -> Range<usize> {
        self.ancora.min(self.cursor)..self.ancora.max(self.cursor)
    }

    pub fn tem_selecao(&self) -> bool {
        self.ancora != self.cursor
    }

    /// O cursor está no começo da seleção: ela foi feita da direita para a esquerda.
    pub fn selecao_invertida(&self) -> bool {
        self.cursor < self.ancora
    }

    pub fn selecionado(&self) -> &str {
        &self.texto[self.selecao()]
    }

    /// Troca o conteúdo inteiro, põe o cursor no fim e esquece o histórico. O limite vale aqui também.
    pub fn definir(&mut self, texto: &str) {
        self.texto.clear();
        self.trocar(0..0, texto);
        self.desfeitos.clear();
        self.refeitos.clear();
        self.ultima = None;
    }

    // --- Posições ----------------------------------------------------------------

    fn anterior(&self, posicao: usize) -> usize {
        self.texto[..posicao].grapheme_indices(true).next_back().map_or(0, |(indice, _)| indice)
    }

    fn seguinte(&self, posicao: usize) -> usize {
        self.texto[posicao..].graphemes(true).next().map_or(self.texto.len(), |grafema| posicao + grafema.len())
    }

    /// A posição válida mais próxima, sem cair no meio de um caractere.
    fn ajustar(&self, posicao: usize) -> usize {
        let mut posicao = posicao.min(self.texto.len());
        while !self.texto.is_char_boundary(posicao) {
            posicao -= 1;
        }
        posicao
    }

    fn palavra_a_esquerda(&self, posicao: usize) -> usize {
        let mut letras = self.texto[..posicao].char_indices().rev().peekable();
        while letras.next_if(|(_, letra)| classe(*letra) == Classe::Espaco).is_some() {}
        let Some((mut inicio, primeira)) = letras.next() else { return 0 };
        let da_palavra = classe(primeira);
        while let Some((indice, _)) = letras.next_if(|(_, letra)| classe(*letra) == da_palavra) {
            inicio = indice;
        }
        inicio
    }

    fn palavra_a_direita(&self, posicao: usize) -> usize {
        let mut letras = self.texto[posicao..].char_indices().peekable();
        if let Some((_, primeira)) = letras.peek().copied() {
            let da_palavra = classe(primeira);
            if da_palavra != Classe::Espaco {
                while letras.next_if(|(_, letra)| classe(*letra) == da_palavra).is_some() {}
            }
        }
        while letras.next_if(|(_, letra)| classe(*letra) == Classe::Espaco).is_some() {}
        letras.peek().map_or(self.texto.len(), |(indice, _)| posicao + indice)
    }

    fn inicio_da_linha(&self, posicao: usize) -> usize {
        self.texto[..posicao].rfind('\n').map_or(0, |quebra| quebra + 1)
    }

    fn fim_da_linha(&self, posicao: usize) -> usize {
        self.texto[posicao..].find('\n').map_or(self.texto.len(), |quebra| posicao + quebra)
    }

    /// Os limites da palavra, do espaço ou da pontuação em volta de uma posição.
    fn palavra_em(&self, posicao: usize) -> Range<usize> {
        let posicao = self.ajustar(posicao);
        let Some(letra) = self.texto[posicao..].chars().next().or_else(|| self.texto[..posicao].chars().next_back()) else {
            return 0..0;
        };
        let da_palavra = classe(letra);
        let inicio = self.texto[..posicao]
            .char_indices()
            .rev()
            .take_while(|(_, letra)| classe(*letra) == da_palavra)
            .last()
            .map_or(posicao, |(indice, _)| indice);
        let fim = self.texto[posicao..]
            .char_indices()
            .find(|(_, letra)| classe(*letra) != da_palavra)
            .map_or(self.texto.len(), |(indice, _)| posicao + indice);
        inicio..fim
    }

    // --- Cursor e seleção --------------------------------------------------------

    pub fn mover(&mut self, movimento: Movimento, selecionando: bool) {
        let alvo = match movimento {
            // Sem a tecla de selecionar, a seta desfaz a seleção e para na ponta dela.
            Movimento::Esquerda if self.tem_selecao() && !selecionando => self.selecao().start,
            Movimento::Direita if self.tem_selecao() && !selecionando => self.selecao().end,
            Movimento::Esquerda => self.anterior(self.cursor),
            Movimento::Direita => self.seguinte(self.cursor),
            Movimento::PalavraEsquerda => self.palavra_a_esquerda(self.cursor),
            Movimento::PalavraDireita => self.palavra_a_direita(self.cursor),
            Movimento::InicioDaLinha => self.inicio_da_linha(self.cursor),
            Movimento::FimDaLinha => self.fim_da_linha(self.cursor),
            Movimento::Inicio => 0,
            Movimento::Fim => self.texto.len(),
        };
        self.mover_para(alvo, selecionando);
    }

    pub fn mover_para(&mut self, posicao: usize, selecionando: bool) {
        self.cursor = self.ajustar(posicao);
        if !selecionando {
            self.ancora = self.cursor;
        }
        self.ultima = None;
    }

    pub fn selecionar_tudo(&mut self) {
        self.ancora = 0;
        self.cursor = self.texto.len();
        self.ultima = None;
    }

    pub fn selecionar_palavra(&mut self, posicao: usize) {
        let palavra = self.palavra_em(posicao);
        self.ancora = palavra.start;
        self.cursor = palavra.end;
        self.ultima = None;
    }

    // --- Mudanças ----------------------------------------------------------------

    fn foto(&self) -> Foto {
        Foto { texto: self.texto.clone(), ancora: self.ancora, cursor: self.cursor }
    }

    /// Guarda o estado atual antes de uma mudança. Letras digitadas em seguida, e apagadas em
    /// seguida, contam como um passo só.
    fn registrar(&mut self, tipo: Tipo) {
        let continua = tipo != Tipo::Outro && self.ultima == Some(tipo);
        if !continua {
            self.desfeitos.push(self.foto());
            if self.desfeitos.len() > PASSOS_GUARDADOS {
                self.desfeitos.remove(0);
            }
        }
        self.refeitos.clear();
        self.ultima = Some(tipo);
    }

    /// Num campo de uma linha, quebra de linha vira espaço; num de várias, as três formas de
    /// quebra viram uma só. Os outros caracteres de controle viram espaço.
    fn limpar(&self, novo: &str) -> String {
        let quebra = if self.varias_linhas { '\n' } else { ' ' };
        let mut limpo = String::with_capacity(novo.len());
        let mut letras = novo.chars().peekable();
        while let Some(letra) = letras.next() {
            match letra {
                '\r' => {
                    letras.next_if_eq(&'\n');
                    limpo.push(quebra);
                }
                '\n' => limpo.push(quebra),
                outra if outra.is_control() => limpo.push(' '),
                outra => limpo.push(outra),
            }
        }
        limpo
    }

    /// Troca um trecho por outro texto, sem mexer no histórico, e devolve quantos bytes entraram.
    /// O que passa do limite fica de fora.
    fn trocar(&mut self, faixa: Range<usize>, novo: &str) -> usize {
        let faixa = self.ajustar(faixa.start)..self.ajustar(faixa.end.max(faixa.start));
        let limpo = self.limpar(novo);
        let cabem = self.limite.saturating_sub(self.texto.chars().count() - self.texto[faixa.clone()].chars().count());
        let entram = limpo.char_indices().nth(cabem).map_or(limpo.len(), |(indice, _)| indice);
        self.texto.replace_range(faixa.clone(), &limpo[..entram]);
        self.cursor = faixa.start + entram;
        self.ancora = self.cursor;
        entram
    }

    /// O que a pessoa digitou ou colou: entra no lugar da seleção, ou no cursor.
    pub fn inserir(&mut self, novo: &str) {
        // Uma letra depois da outra é um passo só; espaço, texto colado e troca de seleção abrem outro.
        let de_digitacao = !self.tem_selecao() && novo.graphemes(true).count() == 1 && !novo.chars().all(char::is_whitespace);
        self.registrar(if de_digitacao { Tipo::Digitar } else { Tipo::Outro });
        self.trocar(self.selecao(), novo);
    }

    /// Troca um trecho escolhido pelo sistema (texto em composição, correção). Devolve quantos bytes entraram.
    pub fn trocar_faixa(&mut self, faixa: Range<usize>, novo: &str) -> usize {
        self.registrar(Tipo::Digitar);
        self.trocar(faixa, novo)
    }

    fn apagar_faixa(&mut self, faixa: Range<usize>) {
        if faixa.is_empty() {
            return;
        }
        self.registrar(if self.tem_selecao() { Tipo::Outro } else { Tipo::Apagar });
        self.trocar(faixa, "");
    }

    /// A tecla de apagar: a seleção, ou o caractere antes (`para_tras`) ou depois do cursor.
    pub fn apagar(&mut self, para_tras: bool) {
        let faixa = if self.tem_selecao() {
            self.selecao()
        } else if para_tras {
            self.anterior(self.cursor)..self.cursor
        } else {
            self.cursor..self.seguinte(self.cursor)
        };
        self.apagar_faixa(faixa);
    }

    pub fn apagar_palavra(&mut self, para_tras: bool) {
        let faixa = if self.tem_selecao() {
            self.selecao()
        } else if para_tras {
            self.palavra_a_esquerda(self.cursor)..self.cursor
        } else {
            self.cursor..self.palavra_a_direita(self.cursor)
        };
        // Cada palavra apagada é um passo do desfazer.
        self.ultima = None;
        self.apagar_faixa(faixa);
    }

    /// O texto selecionado, para a área de transferência. `None` sem seleção.
    pub fn copiar(&self) -> Option<String> {
        self.tem_selecao().then(|| self.selecionado().to_owned())
    }

    pub fn recortar(&mut self) -> Option<String> {
        let recortado = self.copiar()?;
        self.registrar(Tipo::Outro);
        self.trocar(self.selecao(), "");
        Some(recortado)
    }

    fn restaurar(&mut self, foto: Foto) {
        self.texto = foto.texto;
        self.ancora = foto.ancora;
        self.cursor = foto.cursor;
        self.ultima = None;
    }

    /// Devolve `false` quando não há o que desfazer.
    pub fn desfazer(&mut self) -> bool {
        let Some(foto) = self.desfeitos.pop() else { return false };
        self.refeitos.push(self.foto());
        self.restaurar(foto);
        true
    }

    pub fn refazer(&mut self) -> bool {
        let Some(foto) = self.refeitos.pop() else { return false };
        self.desfeitos.push(self.foto());
        self.restaurar(foto);
        true
    }

    // --- Conversa com o sistema, que conta em unidades UTF-16 ---------------------

    pub fn para_utf16(&self, posicao: usize) -> usize {
        tamanho_utf16(&self.texto[..posicao])
    }

    pub fn de_utf16(&self, alvo: usize) -> usize {
        let mut contadas = 0;
        for (indice, letra) in self.texto.char_indices() {
            if contadas >= alvo {
                return indice;
            }
            contadas += letra.len_utf16();
        }
        self.texto.len()
    }

    pub fn faixa_de_utf16(&self, faixa: &Range<usize>) -> Range<usize> {
        self.de_utf16(faixa.start)..self.de_utf16(faixa.end)
    }

    pub fn faixa_para_utf16(&self, faixa: &Range<usize>) -> Range<usize> {
        self.para_utf16(faixa.start)..self.para_utf16(faixa.end)
    }
}

#[cfg(test)]
mod testes {
    use super::*;

    fn com(texto: &str) -> Edicao {
        let mut edicao = Edicao::new(200, false);
        edicao.definir(texto);
        edicao
    }

    fn digitar(edicao: &mut Edicao, texto: &str) {
        for grafema in texto.graphemes(true) {
            edicao.inserir(grafema);
        }
    }

    #[test]
    fn o_limite_conta_caracteres_como_o_contrato() {
        // "ação" tem quatro caracteres e seis bytes.
        let mut edicao = Edicao::new(5, false);
        edicao.definir("ação e reação");
        assert_eq!((edicao.texto(), edicao.cursor()), ("ação ", "ação ".len()));
        // Um emoji é um caractere, embora valha duas unidades UTF-16 e quatro bytes.
        let mut edicao = Edicao::new(3, false);
        edicao.definir("😀😀");
        assert_eq!(edicao.texto(), "😀😀");
        edicao.inserir("a");
        assert_eq!(edicao.texto(), "😀😀a");
        edicao.inserir("b");
        assert_eq!(edicao.texto(), "😀😀a", "o que passa do limite fica de fora");
    }

    #[test]
    fn trocar_a_selecao_libera_o_espaco_dela_no_limite() {
        let mut edicao = Edicao::new(6, false);
        edicao.definir("abcdef");
        edicao.mover_para(2, false);
        edicao.mover_para(4, true);
        edicao.inserir("XYZ");
        assert_eq!((edicao.texto(), edicao.cursor()), ("abXYef", 4));
    }

    #[test]
    fn quebra_de_linha_vira_espaco_no_campo_de_uma_linha_e_fica_no_de_varias() {
        assert_eq!(com("uma\r\nduas\ttres\nfim").texto(), "uma duas tres fim");
        let mut area = Edicao::new(200, true);
        area.definir("uma\r\nduas\rtres\n\tfim");
        assert_eq!(area.texto(), "uma\nduas\ntres\n fim");
    }

    #[test]
    fn o_cursor_anda_por_caractere_inteiro() {
        // O "e" com acento à parte são dois caracteres e um só passo do cursor.
        let mut edicao = com("ae\u{301}😀");
        edicao.mover(Movimento::Esquerda, false);
        assert_eq!(edicao.cursor(), "ae\u{301}".len());
        edicao.mover(Movimento::Esquerda, false);
        assert_eq!(edicao.cursor(), 1);
        edicao.mover(Movimento::Direita, false);
        assert_eq!(edicao.cursor(), "ae\u{301}".len());
        // O sistema conversa em unidades UTF-16: o emoji vale duas.
        assert_eq!(edicao.para_utf16(edicao.texto().len()), 5);
        assert_eq!(edicao.de_utf16(3), "ae\u{301}".len());
        assert_eq!(edicao.de_utf16(5), edicao.texto().len());
        assert_eq!(edicao.de_utf16(99), edicao.texto().len());
    }

    #[test]
    fn seleciona_com_as_setas_e_a_seta_sozinha_para_na_ponta_da_selecao() {
        let mut edicao = com("abcdef");
        edicao.mover(Movimento::Esquerda, true);
        edicao.mover(Movimento::Esquerda, true);
        assert_eq!((edicao.selecao(), edicao.selecionado(), edicao.selecao_invertida()), (4..6, "ef", true));
        edicao.mover(Movimento::Esquerda, false);
        assert_eq!((edicao.cursor(), edicao.tem_selecao()), (4, false));

        edicao.mover(Movimento::Inicio, true);
        assert_eq!(edicao.selecionado(), "abcd");
        edicao.mover(Movimento::Direita, false);
        assert_eq!((edicao.cursor(), edicao.tem_selecao()), (4, false));

        edicao.selecionar_tudo();
        assert_eq!(edicao.selecionado(), "abcdef");
    }

    #[test]
    fn anda_e_apaga_por_palavra() {
        let mut edicao = com("olá, mundo  cão_2");
        edicao.mover(Movimento::PalavraEsquerda, false);
        assert_eq!(&edicao.texto()[edicao.cursor()..], "cão_2");
        edicao.mover(Movimento::PalavraEsquerda, false);
        assert_eq!(&edicao.texto()[edicao.cursor()..], "mundo  cão_2");
        edicao.mover(Movimento::PalavraEsquerda, false);
        assert_eq!(&edicao.texto()[edicao.cursor()..], ", mundo  cão_2");
        edicao.mover(Movimento::PalavraDireita, false);
        assert_eq!(&edicao.texto()[edicao.cursor()..], "mundo  cão_2");
        edicao.mover(Movimento::PalavraDireita, false);
        assert_eq!(&edicao.texto()[edicao.cursor()..], "cão_2");
        edicao.mover(Movimento::PalavraDireita, false);
        assert_eq!(edicao.cursor(), edicao.texto().len());

        edicao.apagar_palavra(true);
        assert_eq!(edicao.texto(), "olá, mundo  ");
        edicao.mover(Movimento::Inicio, false);
        edicao.apagar_palavra(false);
        assert_eq!(edicao.texto(), ", mundo  ");
    }

    #[test]
    fn inicio_e_fim_da_linha_ficam_no_paragrafo() {
        let mut area = Edicao::new(200, true);
        area.definir("um\ndois\ntrês");
        area.mover_para("um\ndo".len(), false);
        area.mover(Movimento::InicioDaLinha, false);
        assert_eq!(area.cursor(), "um\n".len());
        area.mover(Movimento::FimDaLinha, true);
        assert_eq!(area.selecionado(), "dois");
        area.mover(Movimento::Fim, false);
        assert_eq!(area.cursor(), area.texto().len());
        area.mover(Movimento::Inicio, false);
        assert_eq!(area.cursor(), 0);
    }

    #[test]
    fn duplo_clique_seleciona_a_palavra_o_espaco_ou_a_pontuacao() {
        let mut edicao = com("olá, mundo");
        edicao.selecionar_palavra(1);
        assert_eq!(edicao.selecionado(), "olá");
        edicao.selecionar_palavra("olá".len());
        assert_eq!(edicao.selecionado(), ",");
        edicao.selecionar_palavra("olá,".len());
        assert_eq!(edicao.selecionado(), " ");
        edicao.selecionar_palavra(edicao.texto().len());
        assert_eq!(edicao.selecionado(), "mundo");
        let mut vazio = com("");
        vazio.selecionar_palavra(0);
        assert!(!vazio.tem_selecao());
    }

    #[test]
    fn apagar_tira_a_selecao_ou_um_caractere() {
        let mut edicao = com("abcdef");
        edicao.apagar(true);
        assert_eq!(edicao.texto(), "abcde");
        edicao.mover(Movimento::Inicio, false);
        edicao.apagar(true);
        assert_eq!(edicao.texto(), "abcde", "no começo não há o que apagar para trás");
        edicao.apagar(false);
        assert_eq!(edicao.texto(), "bcde");
        edicao.mover(Movimento::Direita, true);
        edicao.mover(Movimento::Direita, true);
        edicao.apagar(false);
        assert_eq!((edicao.texto(), edicao.cursor()), ("de", 0));
    }

    #[test]
    fn copiar_e_recortar_so_com_selecao() {
        let mut edicao = com("abcdef");
        assert_eq!(edicao.copiar(), None);
        assert_eq!(edicao.recortar(), None);
        edicao.mover(Movimento::PalavraEsquerda, true);
        assert_eq!(edicao.copiar().as_deref(), Some("abcdef"));
        assert_eq!(edicao.texto(), "abcdef", "copiar não mexe no texto");
        assert_eq!(edicao.recortar().as_deref(), Some("abcdef"));
        assert_eq!(edicao.texto(), "");
        assert!(edicao.desfazer());
        assert_eq!(edicao.texto(), "abcdef");
    }

    #[test]
    fn desfazer_volta_palavra_por_palavra_e_refazer_refaz() {
        let mut edicao = Edicao::new(200, false);
        digitar(&mut edicao, "olá mundo");
        assert!(edicao.desfazer());
        assert_eq!(edicao.texto(), "olá ");
        assert!(edicao.desfazer());
        assert_eq!(edicao.texto(), "olá");
        assert!(edicao.desfazer());
        assert_eq!(edicao.texto(), "");
        assert!(!edicao.desfazer(), "não há mais o que desfazer");

        assert!(edicao.refazer());
        assert!(edicao.refazer());
        assert_eq!((edicao.texto(), edicao.cursor()), ("olá ", "olá ".len()));
        // Uma mudança nova depois de desfazer descarta o que podia ser refeito.
        digitar(&mut edicao, "x");
        assert!(!edicao.refazer());
        assert_eq!(edicao.texto(), "olá x");
    }

    #[test]
    fn desfazer_devolve_a_selecao_que_foi_trocada() {
        let mut edicao = com("abcdef");
        edicao.mover_para(1, false);
        edicao.mover_para(3, true);
        edicao.inserir("colado de fora");
        assert_eq!(edicao.texto(), "acolado de foradef");
        assert!(edicao.desfazer());
        assert_eq!((edicao.texto(), edicao.selecao()), ("abcdef", 1..3));
    }

    #[test]
    fn apagar_em_seguida_e_um_passo_so_e_mover_o_cursor_abre_outro() {
        let mut edicao = com("abcdef");
        edicao.apagar(true);
        edicao.apagar(true);
        edicao.mover(Movimento::Esquerda, false);
        edicao.apagar(true);
        assert_eq!(edicao.texto(), "abd");
        assert!(edicao.desfazer());
        assert_eq!(edicao.texto(), "abcd");
        assert!(edicao.desfazer());
        assert_eq!(edicao.texto(), "abcdef");
    }

    #[test]
    fn definir_esquece_o_historico() {
        let mut edicao = Edicao::new(200, false);
        digitar(&mut edicao, "rascunho");
        edicao.definir("");
        assert!(!edicao.desfazer(), "a mensagem enviada não volta com o desfazer");
    }

    #[test]
    fn posicao_fora_do_texto_ou_no_meio_de_um_caractere_e_ajustada() {
        let mut edicao = com("aé");
        edicao.mover_para(2, false);
        assert_eq!(edicao.cursor(), 1, "não para no meio do é");
        edicao.mover_para(99, false);
        assert_eq!(edicao.cursor(), edicao.texto().len());
        assert_eq!(edicao.trocar_faixa(1..99, "b"), 1);
        assert_eq!(edicao.texto(), "ab");
    }
}
