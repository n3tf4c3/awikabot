//! Analisador de Server-Sent Events. Mesma regra de `apps/mobile/src/lib/sse.ts`.

/// Um evento de `text/event-stream` já montado.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventoSse {
    /// Último `id:` visto no fluxo até este evento, ou `None` se nenhum veio.
    pub id: Option<String>,
    /// Valor de `event:`; `message` quando o servidor não manda o campo.
    pub evento: String,
    /// Linhas de `data:` juntadas com `\n`.
    pub dados: String,
}

/// Guarda o que ficou pela metade entre um pedaço e outro: o corte pode cair em qualquer lugar,
/// inclusive no meio de um caractere UTF-8 ou de um `\r\n`.
#[derive(Debug, Default)]
pub struct AnalisadorSse {
    resto: Vec<u8>,
    comecou: bool,
    /// A linha anterior terminou em `\r` no fim do pedaço: um `\n` logo a seguir é do mesmo fim de linha.
    pular_lf: bool,
    dados: Vec<String>,
    tipo: String,
    ultimo_id: Option<String>,
}

impl AnalisadorSse {
    pub fn new() -> Self {
        Self::default()
    }

    /// Recebe um pedaço qualquer do fluxo e devolve os eventos que ele completou.
    pub fn alimentar(&mut self, pedaco: &[u8]) -> Vec<EventoSse> {
        let mut saida = Vec::new();
        for &byte in pedaco {
            if self.pular_lf {
                self.pular_lf = false;
                if byte == b'\n' {
                    continue;
                }
            }
            match byte {
                b'\n' => self.fechar_linha(&mut saida),
                b'\r' => {
                    self.fechar_linha(&mut saida);
                    self.pular_lf = true;
                }
                _ => self.resto.push(byte),
            }
        }
        saida
    }

    fn fechar_linha(&mut self, saida: &mut Vec<EventoSse>) {
        let bytes = std::mem::take(&mut self.resto);
        let mut linha = String::from_utf8_lossy(&bytes).into_owned();
        if !self.comecou {
            self.comecou = true;
            if let Some(sem_marca) = linha.strip_prefix('\u{feff}') {
                linha = sem_marca.to_owned();
            }
        }

        if linha.is_empty() {
            if !self.dados.is_empty() {
                saida.push(EventoSse {
                    id: self.ultimo_id.clone(),
                    evento: if self.tipo.is_empty() { "message".to_owned() } else { self.tipo.clone() },
                    dados: self.dados.join("\n"),
                });
            }
            self.dados.clear();
            self.tipo.clear();
            return;
        }
        if linha.starts_with(':') {
            return;
        }
        let (campo, valor) = match linha.split_once(':') {
            Some((campo, valor)) => (campo, valor.strip_prefix(' ').unwrap_or(valor)),
            None => (linha.as_str(), ""),
        };
        match campo {
            "data" => self.dados.push(valor.to_owned()),
            "event" => self.tipo = valor.to_owned(),
            "id" if !valor.contains('\0') => self.ultimo_id = Some(valor.to_owned()),
            _ => {}
        }
    }
}

#[cfg(test)]
mod testes {
    use super::*;

    fn evento(id: Option<&str>, evento: &str, dados: &str) -> EventoSse {
        EventoSse { id: id.map(str::to_owned), evento: evento.to_owned(), dados: dados.to_owned() }
    }

    #[test]
    fn monta_evento_com_id_tipo_e_dados() {
        let mut analisador = AnalisadorSse::new();
        let eventos = analisador.alimentar(b"event: evento\ndata: {\"tipo\":\"ressincronizar\"}\nid: abc-1\n\n");
        assert_eq!(eventos, vec![evento(Some("abc-1"), "evento", "{\"tipo\":\"ressincronizar\"}")]);
    }

    #[test]
    fn o_sinal_de_vida_com_dados_vazios_e_entregue_e_leva_o_id() {
        let mut analisador = AnalisadorSse::new();
        assert_eq!(analisador.alimentar(b"id: abc-0\nevent: ping\ndata: \n\n"), vec![evento(Some("abc-0"), "ping", "")]);
        // O id fica valendo para os eventos seguintes que não trazem um.
        assert_eq!(analisador.alimentar(b"event: ping\ndata: \n\n"), vec![evento(Some("abc-0"), "ping", "")]);
    }

    #[test]
    fn o_corte_pode_cair_em_qualquer_lugar() {
        let inteiro = "event: evento\r\ndata: ol\u{e1} mundo\r\ndata: segunda linha\r\nid: e-7\r\n\r\n".as_bytes();
        let esperado = vec![evento(Some("e-7"), "evento", "ol\u{e1} mundo\nsegunda linha")];
        for corte in 0..=inteiro.len() {
            let mut analisador = AnalisadorSse::new();
            let mut eventos = analisador.alimentar(&inteiro[..corte]);
            eventos.extend(analisador.alimentar(&inteiro[corte..]));
            assert_eq!(eventos, esperado, "corte em {corte}");
        }
        // Byte a byte também.
        let mut analisador = AnalisadorSse::new();
        let eventos: Vec<_> = inteiro.iter().flat_map(|byte| analisador.alimentar(&[*byte])).collect();
        assert_eq!(eventos, esperado);
    }

    #[test]
    fn ignora_comentario_bloco_sem_dados_e_marca_de_ordem() {
        let mut analisador = AnalisadorSse::new();
        let eventos = analisador.alimentar("\u{feff}: comentário\nevent: so-tipo\n\ndata: x\n\n".as_bytes());
        assert_eq!(eventos, vec![evento(None, "message", "x")]);
    }

    #[test]
    fn id_com_caractere_nulo_nao_vale() {
        let mut analisador = AnalisadorSse::new();
        assert_eq!(analisador.alimentar(b"id: a\0b\ndata: x\n\n"), vec![evento(None, "message", "x")]);
    }
}
