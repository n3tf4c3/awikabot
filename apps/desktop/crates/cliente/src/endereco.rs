//! Endereço do servidor informado pela pessoa.
//!
//! É a mesma regra de `apps/mobile/src/lib/endereco-servidor.ts`, passo a passo: `https://` sempre,
//! menos `localhost` e endereços de rede privada, que aceitam `http://`. Os dois lados são
//! testados contra a mesma tabela, em `packages/core/casos/endereco-servidor.json`; mudar a regra
//! num deles sem mudar no outro quebra o teste.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MotivoEndereco {
    Vazio,
    Invalido,
    /// Esquema que não é `http` nem `https`.
    Esquema,
    /// Usuário ou senha no endereço.
    Credenciais,
    /// `http://` para um servidor fora da rede local.
    HttpForaDaRedeLocal,
}

impl MotivoEndereco {
    /// O nome do motivo no app de celular e na tabela de casos.
    pub fn codigo(self) -> &'static str {
        match self {
            Self::Vazio => "vazio",
            Self::Invalido => "invalido",
            Self::Esquema => "esquema",
            Self::Credenciais => "credenciais",
            Self::HttpForaDaRedeLocal => "http_fora_da_rede_local",
        }
    }

    /// O texto que a pessoa lê, igual ao do app de celular.
    pub fn mensagem(self) -> &'static str {
        match self {
            Self::Vazio => "Informe o endereço do servidor.",
            Self::Invalido => "Endereço inválido. Exemplo: https://bots.exemplo.com",
            Self::Esquema => "O endereço precisa começar com https:// (ou http:// na rede local).",
            Self::Credenciais => "O endereço não pode levar usuário nem senha.",
            Self::HttpForaDaRedeLocal => "Use https:// neste endereço. http:// só vale para localhost e endereços da rede local.",
        }
    }
}

enum Host {
    Ipv4([u16; 4]),
    Ipv6([u16; 8]),
    Nome,
}

/// Os quatro números de um IPv4 escrito por extenso. Zero à esquerda não vale.
fn octetos_ipv4(host: &str) -> Option<[u16; 4]> {
    let partes: Vec<&str> = host.split('.').collect();
    let mut octetos = [0u16; 4];
    if partes.len() != 4 {
        return None;
    }
    for (indice, parte) in partes.iter().enumerate() {
        let so_digitos = !parte.is_empty() && parte.len() <= 3 && parte.bytes().all(|byte| byte.is_ascii_digit());
        if !so_digitos || (parte.len() > 1 && parte.starts_with('0')) {
            return None;
        }
        let numero: u16 = parte.parse().ok()?;
        if numero > 255 {
            return None;
        }
        octetos[indice] = numero;
    }
    Some(octetos)
}

/// Os grupos de um lado do `::`, ou de um IPv6 escrito inteiro.
fn ler_grupos(parte: &str) -> Option<Vec<u16>> {
    if parte.is_empty() {
        return Some(Vec::new());
    }
    parte
        .split(':')
        .map(|grupo| {
            let valido = (1..=4).contains(&grupo.len()) && grupo.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
            valido.then(|| u16::from_str_radix(grupo, 16).ok()).flatten()
        })
        .collect()
}

/// Os oito grupos de um IPv6 sem colchetes. Não aceita zona nem IPv4 embutido.
fn grupos_ipv6(texto: &str) -> Option<[u16; 8]> {
    let metades: Vec<&str> = texto.split("::").collect();
    if metades.len() > 2 {
        return None;
    }
    let inicio = ler_grupos(metades[0])?;
    let todos = if metades.len() == 1 {
        inicio
    } else {
        let fim = ler_grupos(metades[1])?;
        if inicio.len() + fim.len() > 7 {
            return None;
        }
        let zeros = vec![0u16; 8 - inicio.len() - fim.len()];
        [inicio, zeros, fim].concat()
    };
    todos.try_into().ok()
}

fn nome_de_host_valido(host: &str) -> bool {
    let rotulo_valido = |rotulo: &str| {
        let bytes = rotulo.as_bytes();
        let alfanumerico = |byte: &u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
        (1..=63).contains(&bytes.len())
            && bytes.first().is_some_and(alfanumerico)
            && bytes.last().is_some_and(alfanumerico)
            && bytes.iter().all(|byte| alfanumerico(byte) || *byte == b'-')
    };
    host.chars().count() <= 253 && host.split('.').all(rotulo_valido)
}

fn ler_host(host: &str) -> Option<Host> {
    if let Some(aberto) = host.strip_prefix('[') {
        return grupos_ipv6(aberto.strip_suffix(']')?).map(Host::Ipv6);
    }
    // Só números e pontos tem de ser um IPv4 completo: "10.0.1" não é nome de host.
    if !host.is_empty() && host.bytes().all(|byte| byte.is_ascii_digit() || byte == b'.') {
        return octetos_ipv4(host).map(Host::Ipv4);
    }
    nome_de_host_valido(host).then_some(Host::Nome)
}

/// O nome exato `localhost`, loopback, redes privadas, link-local e os equivalentes em IPv6.
/// Nenhum outro nome entra, nem `algo.localhost`: nada garante que o sistema resolva esse nome
/// para o próprio computador.
fn na_rede_local(host: &str, lido: &Host) -> bool {
    match lido {
        Host::Nome => host == "localhost",
        Host::Ipv4([a, b, ..]) => {
            *a == 127 || *a == 10 || (*a == 172 && (16..=31).contains(b)) || (*a == 192 && *b == 168) || (*a == 169 && *b == 254)
        }
        Host::Ipv6(grupos) => {
            let loopback = grupos.iter().enumerate().all(|(indice, grupo)| *grupo == u16::from(indice == 7));
            loopback || (grupos[0] & 0xfe00) == 0xfc00 || (grupos[0] & 0xffc0) == 0xfe80
        }
    }
}

/// Separa o esquema de um endereço que começa com `nome://`, se o nome tiver a forma de um esquema.
fn separar_esquema(texto: &str) -> Option<(&str, &str)> {
    let (nome, resto) = texto.split_once("://")?;
    let mut bytes = nome.bytes();
    let forma_de_esquema = bytes.next().is_some_and(|byte| byte.is_ascii_alphabetic())
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || b"+.-".contains(&byte));
    forma_de_esquema.then_some((nome, resto))
}

/// Devolve a URL base do servidor, sem barra no fim. Sem esquema, vale `http://` na rede local e
/// `https://` no resto.
pub fn normalizar_endereco(entrada: &str) -> Result<String, MotivoEndereco> {
    let limpo = entrada.trim();
    if limpo.is_empty() {
        return Err(MotivoEndereco::Vazio);
    }
    if limpo.chars().any(char::is_whitespace) {
        return Err(MotivoEndereco::Invalido);
    }

    let (esquema, resto) = match separar_esquema(limpo) {
        Some((nome, resto)) => match nome.to_ascii_lowercase().as_str() {
            "http" => (Some("http"), resto),
            "https" => (Some("https"), resto),
            _ => return Err(MotivoEndereco::Esquema),
        },
        None => (None, limpo),
    };

    // Autoridade até a primeira barra; depois dela, só caminho, sem busca nem fragmento.
    let fim_da_autoridade = resto.find(['/', '?', '#']).unwrap_or(resto.len());
    let (autoridade, depois) = resto.split_at(fim_da_autoridade);
    if depois.contains(['?', '#']) {
        return Err(MotivoEndereco::Invalido);
    }
    let caminho = depois.trim_end_matches('/');
    if autoridade.contains('@') {
        return Err(MotivoEndereco::Credenciais);
    }
    if !caminho.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._~!$&'()*+,;=:@%/-".contains(&byte)) {
        return Err(MotivoEndereco::Invalido);
    }

    // A porta é o que vem depois do último `:`, se forem de um a cinco dígitos.
    let (host, porta) = match autoridade.rsplit_once(':') {
        Some((host, digitos)) if (1..=5).contains(&digitos.len()) && digitos.bytes().all(|byte| byte.is_ascii_digit()) => {
            (host, Some(digitos.parse::<u32>().map_err(|_| MotivoEndereco::Invalido)?))
        }
        _ => (autoridade, None),
    };
    if porta.is_some_and(|porta| !(1..=65535).contains(&porta)) {
        return Err(MotivoEndereco::Invalido);
    }
    let host = host.to_lowercase();
    let lido = ler_host(&host).ok_or(MotivoEndereco::Invalido)?;

    let local = na_rede_local(&host, &lido);
    let esquema = esquema.unwrap_or(if local { "http" } else { "https" });
    if esquema == "http" && !local {
        return Err(MotivoEndereco::HttpForaDaRedeLocal);
    }
    let porta_padrao = if esquema == "https" { 443 } else { 80 };
    let sufixo = porta.filter(|porta| *porta != porta_padrao).map(|porta| format!(":{porta}")).unwrap_or_default();
    Ok(format!("{esquema}://{host}{sufixo}{caminho}"))
}

#[cfg(test)]
mod testes {
    use serde::Deserialize;

    use super::*;

    #[derive(Deserialize)]
    struct Caso {
        entrada: String,
        url: Option<String>,
        motivo: Option<String>,
    }

    #[derive(Deserialize)]
    struct Tabela {
        casos: Vec<Caso>,
    }

    /// A tabela que o app de celular também testa. Quem diverge dela, diverge do outro app.
    #[test]
    fn segue_a_mesma_tabela_do_app_de_celular() {
        let texto = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../packages/core/casos/endereco-servidor.json"));
        let tabela: Tabela = serde_json::from_str(texto).expect("tabela de casos");
        assert!(tabela.casos.len() >= 90, "a tabela encolheu: {} casos", tabela.casos.len());
        for caso in tabela.casos {
            let obtido = normalizar_endereco(&caso.entrada);
            match (&caso.url, &caso.motivo) {
                (Some(url), None) => assert_eq!(obtido.as_deref(), Ok(url.as_str()), "entrada {:?}", caso.entrada),
                (None, Some(motivo)) => {
                    assert_eq!(obtido.as_ref().map_err(|motivo| motivo.codigo()), Err(motivo.as_str()), "entrada {:?}", caso.entrada)
                }
                _ => panic!("caso sem url nem motivo, ou com os dois: {:?}", caso.entrada),
            }
        }
    }

    #[test]
    fn o_endereco_normalizado_nao_muda_ao_ser_normalizado_de_novo() {
        // É o que a sessão guardada confere ao ser lida: o endereço tem de ser igual à própria forma normal.
        for entrada in ["bots.exemplo.com:8787/api/", "LOCALHOST:80", "HTTP://[FD00::1]:8790/", "https://Bots.Exemplo.COM:443/Awika/"] {
            let normal = normalizar_endereco(entrada).expect("endereço válido");
            assert_eq!(normalizar_endereco(&normal).as_deref(), Ok(normal.as_str()), "{entrada}");
        }
    }

    #[test]
    fn todo_motivo_tem_mensagem_e_codigo() {
        use MotivoEndereco::*;
        for motivo in [Vazio, Invalido, Esquema, Credenciais, HttpForaDaRedeLocal] {
            assert!(!motivo.mensagem().is_empty());
            assert!(!motivo.codigo().is_empty());
        }
        assert!(HttpForaDaRedeLocal.mensagem().contains("https://"));
    }
}
