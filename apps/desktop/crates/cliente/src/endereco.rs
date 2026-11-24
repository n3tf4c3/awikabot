//! Endereço do servidor informado pela pessoa. A regra é a do app de celular: `https://` sempre,
//! menos `localhost` e endereços de rede privada, que aceitam `http://`.

use std::net::{Ipv4Addr, Ipv6Addr};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MotivoEndereco {
    Vazio,
    /// Esquema que não é `http` nem `https`.
    Esquema,
    /// Usuário ou senha no endereço.
    Credenciais,
    Invalido,
    /// `http://` para um servidor fora da rede local.
    HttpForaDaRedeLocal,
}

enum Host {
    Nome(String),
    V4(Ipv4Addr),
    V6(Ipv6Addr),
}

fn ler_host(texto: &str) -> Option<Host> {
    if let Some(interno) = texto.strip_prefix('[') {
        return interno.strip_suffix(']')?.parse().ok().map(Host::V6);
    }
    if let Ok(v4) = texto.parse::<Ipv4Addr>() {
        return Some(Host::V4(v4));
    }
    let nome = texto.to_ascii_lowercase();
    let rotulos: Vec<&str> = nome.split('.').collect();
    let rotulo_valido = |rotulo: &&str| {
        !rotulo.is_empty()
            && rotulo.len() <= 63
            && rotulo.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            && !rotulo.starts_with('-')
            && !rotulo.ends_with('-')
    };
    // Um nome que termina só em dígitos é um IPv4 mal escrito, não um nome.
    let parece_ip = rotulos.last().is_some_and(|ultimo| ultimo.bytes().all(|byte| byte.is_ascii_digit()));
    (nome.len() <= 253 && rotulos.iter().all(rotulo_valido) && !parece_ip).then_some(Host::Nome(nome))
}

fn na_rede_local(host: &Host) -> bool {
    match host {
        Host::Nome(nome) => nome == "localhost",
        Host::V4(ip) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        Host::V6(ip) => {
            let primeiro = ip.segments()[0];
            ip.is_loopback() || (primeiro & 0xfe00) == 0xfc00 || (primeiro & 0xffc0) == 0xfe80
        }
    }
}

/// Devolve o endereço pronto para receber os caminhos da API: esquema, host, porta e caminho,
/// sem barra no fim. Sem esquema, vale `http` na rede local e `https` fora dela.
pub fn normalizar_endereco(entrada: &str) -> Result<String, MotivoEndereco> {
    let texto = entrada.trim();
    if texto.is_empty() {
        return Err(MotivoEndereco::Vazio);
    }
    let (esquema, resto) = match texto.split_once("://") {
        Some((nome, resto)) => match nome.to_ascii_lowercase().as_str() {
            "http" => (Some("http"), resto),
            "https" => (Some("https"), resto),
            _ => return Err(MotivoEndereco::Esquema),
        },
        None => (None, texto),
    };
    let (autoridade, caminho) = match resto.find('/') {
        Some(indice) => (&resto[..indice], resto[indice..].trim_end_matches('/')),
        None => (resto, ""),
    };
    if autoridade.contains('@') {
        return Err(MotivoEndereco::Credenciais);
    }
    let caminho_valido = caminho.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"/._~-%".contains(&byte));
    if !caminho_valido {
        return Err(MotivoEndereco::Invalido);
    }

    // A porta vem depois do último `:` que não está dentro dos colchetes de um IPv6.
    let (host_texto, porta) = match autoridade.rfind(':') {
        Some(indice) if !autoridade[indice..].contains(']') => {
            let porta: u16 = autoridade[indice + 1..].parse().map_err(|_| MotivoEndereco::Invalido)?;
            if porta == 0 {
                return Err(MotivoEndereco::Invalido);
            }
            (&autoridade[..indice], Some(porta))
        }
        _ => (autoridade, None),
    };
    let host = ler_host(host_texto).ok_or(MotivoEndereco::Invalido)?;

    let local = na_rede_local(&host);
    let esquema = esquema.unwrap_or(if local { "http" } else { "https" });
    if esquema == "http" && !local {
        return Err(MotivoEndereco::HttpForaDaRedeLocal);
    }
    let host = match host {
        Host::Nome(nome) => nome,
        Host::V4(ip) => ip.to_string(),
        Host::V6(ip) => format!("[{ip}]"),
    };
    let porta = porta.map(|porta| format!(":{porta}")).unwrap_or_default();
    Ok(format!("{esquema}://{host}{porta}{caminho}"))
}

#[cfg(test)]
mod testes {
    use super::*;

    #[test]
    fn aceita_https_e_completa_o_esquema() {
        let casos = [
            ("https://bots.exemplo.com", "https://bots.exemplo.com"),
            ("  HTTPS://Bots.Exemplo.com/  ", "https://bots.exemplo.com"),
            ("bots.exemplo.com", "https://bots.exemplo.com"),
            ("bots.exemplo.com:8443/awika/", "https://bots.exemplo.com:8443/awika"),
            ("localhost:8790", "http://localhost:8790"),
            ("http://127.0.0.1:8790", "http://127.0.0.1:8790"),
            ("192.168.0.10:8790", "http://192.168.0.10:8790"),
            ("http://10.0.0.5", "http://10.0.0.5"),
            ("http://172.31.255.1", "http://172.31.255.1"),
            ("http://169.254.10.1", "http://169.254.10.1"),
            ("http://[::1]:8790", "http://[::1]:8790"),
            ("[fd00::1]", "http://[fd00::1]"),
            ("https://192.168.0.10", "https://192.168.0.10"),
        ];
        for (entrada, esperado) in casos {
            assert_eq!(normalizar_endereco(entrada).as_deref(), Ok(esperado), "{entrada}");
        }
    }

    #[test]
    fn recusa_http_fora_da_rede_local() {
        for entrada in [
            "http://bots.exemplo.com",
            "http://8.8.8.8",
            "http://172.32.0.1",
            "http://meu.localhost",
            "http://localhost.exemplo.com",
            "http://[2001:db8::1]",
        ] {
            assert_eq!(normalizar_endereco(entrada), Err(MotivoEndereco::HttpForaDaRedeLocal), "{entrada}");
        }
    }

    #[test]
    fn recusa_o_que_nao_e_endereco_de_servidor() {
        let casos = [
            ("", MotivoEndereco::Vazio),
            ("   ", MotivoEndereco::Vazio),
            ("ftp://bots.exemplo.com", MotivoEndereco::Esquema),
            ("file:///etc/passwd", MotivoEndereco::Esquema),
            ("https://usuario:senha@bots.exemplo.com", MotivoEndereco::Credenciais),
            ("https://bots.exemplo.com/?x=1", MotivoEndereco::Invalido),
            ("https://bots.exemplo.com/#topo", MotivoEndereco::Invalido),
            ("https://bots exemplo.com", MotivoEndereco::Invalido),
            ("https://bots.exemplo.com:0", MotivoEndereco::Invalido),
            ("https://bots.exemplo.com:99999", MotivoEndereco::Invalido),
            ("https://999.1.1.1", MotivoEndereco::Invalido),
            ("https://-exemplo.com", MotivoEndereco::Invalido),
            ("https://", MotivoEndereco::Invalido),
            ("https://[::1", MotivoEndereco::Invalido),
        ];
        for (entrada, motivo) in casos {
            assert_eq!(normalizar_endereco(entrada), Err(motivo), "{entrada}");
        }
    }
}
