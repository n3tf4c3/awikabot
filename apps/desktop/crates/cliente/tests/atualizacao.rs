//! A atualização do app contra um servidor de mentira, que faz o papel do GitHub: lista de
//! releases, manifesto e pacote. O que se confere é o que o cliente aceita e, principalmente, o
//! que ele recusa.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use awikabot_cliente::atualizacao::{Atualizador, ErroDeAtualizacao, Oferta, Origem, Versao};
use awikabot_cliente::servidor_de_teste::{PedidoRecebido, RespostaFalsa, ServidorFalso};
use sha2::{Digest, Sha256};

const PLATAFORMA: &str = "windows-x64";
const PACOTE: &[u8] = b"conteudo do instalador de teste, que nao e um executavel de verdade";

fn v(maior: u64, menor: u64, correcao: u64) -> Versao {
    Versao { maior, menor, correcao }
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

fn manifesto(versao: &str, tamanho: usize, hash: &str) -> String {
    format!(
        r#"{{"versao":"{versao}","plataforma":"{PLATAFORMA}","arquivo":"awikabot-{versao}-{PLATAFORMA}.exe","tamanho":{tamanho},"sha256":"{hash}"}}"#
    )
}

/// Um release da lista, com o manifesto desta plataforma entre os arquivos.
fn lancamento(etiqueta: &str, extras: &str) -> String {
    format!(r#"{{"tag_name":"{etiqueta}","assets":[{{"name":"awikabot-desktop-{PLATAFORMA}.json"}},{{"name":"outro.txt"}}]{extras}}}"#)
}

fn lista(lancamentos: &[String]) -> String {
    format!("[{}]", lancamentos.join(","))
}

/// O caminho pedido, sem o método e a versão do protocolo.
fn caminho(pedido: &PedidoRecebido) -> String {
    pedido.linha.split(' ').nth(1).unwrap_or_default().to_owned()
}

/// Uma pasta vazia só deste teste, apagada no fim.
struct Pasta(PathBuf);

impl Pasta {
    fn nova(nome: &str) -> Self {
        static CONTADOR: AtomicUsize = AtomicUsize::new(0);
        let unica = format!("awikabot-teste-atualizacao-{}-{}-{nome}", std::process::id(), CONTADOR.fetch_add(1, Ordering::Relaxed));
        let pasta = std::env::temp_dir().join(unica);
        std::fs::create_dir_all(&pasta).expect("criar a pasta do teste");
        Self(pasta)
    }

    fn arquivos(&self) -> Vec<String> {
        let mut nomes: Vec<String> = std::fs::read_dir(&self.0)
            .expect("listar")
            .map(|item| item.expect("item").file_name().to_string_lossy().into_owned())
            .collect();
        nomes.sort();
        nomes
    }
}

impl Drop for Pasta {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Um servidor que publica a versão 0.2.0 com o pacote de teste, do jeito certo.
fn servidor_com(pacote: RespostaFalsa, do_manifesto: String) -> ServidorFalso {
    ServidorFalso::subir(move |_, pedido| match caminho(pedido).as_str() {
        "/repos/dono/repositorio/releases?per_page=30" => RespostaFalsa::json(200, &lista(&[lancamento("desktop-v0.2.0", "")])),
        "/dono/repositorio/releases/download/desktop-v0.2.0/awikabot-desktop-windows-x64.json" => RespostaFalsa::json(200, &do_manifesto),
        "/dono/repositorio/releases/download/desktop-v0.2.0/awikabot-0.2.0-windows-x64.exe" => pacote.clone(),
        _ => RespostaFalsa::html(404),
    })
}

fn servidor_certo() -> ServidorFalso {
    servidor_com(RespostaFalsa::bytes(200, PACOTE), manifesto("0.2.0", PACOTE.len(), &sha256(PACOTE)))
}

fn atualizador(servidor: &ServidorFalso) -> Atualizador {
    Atualizador::new(Origem::de_teste(&servidor.base), PLATAFORMA)
}

fn oferta_certa() -> Oferta {
    Oferta {
        versao: v(0, 2, 0),
        etiqueta: "desktop-v0.2.0".into(),
        arquivo: "awikabot-0.2.0-windows-x64.exe".into(),
        tamanho: PACOTE.len() as u64,
        sha256: sha256(PACOTE),
    }
}

fn baixar(servidor: &ServidorFalso, oferta: &Oferta, pasta: &Pasta) -> Result<PathBuf, ErroDeAtualizacao> {
    atualizador(servidor).baixar(oferta, &pasta.0, &AtomicBool::new(false), &mut |_| {})
}

#[test]
fn oferece_a_versao_maior_e_nao_manda_nada_que_identifique_a_pessoa() {
    let servidor = servidor_certo();
    assert_eq!(atualizador(&servidor).consultar(v(0, 1, 0)), Ok(Some(oferta_certa())));

    let pedidos = servidor.pedidos();
    assert_eq!(pedidos.len(), 2, "a lista e o manifesto: {pedidos:?}");
    for pedido in &pedidos {
        assert_eq!(pedido.cabecalho("authorization"), None, "consultar versão não leva credencial");
        assert_eq!(pedido.cabecalho("cookie"), None);
        assert!(pedido.cabecalho("user-agent").is_some_and(|agente| agente.starts_with("awikabot-desktop/")));
    }
}

#[test]
fn versao_igual_ou_menor_nao_e_oferta_e_nem_o_manifesto_e_pedido() {
    let servidor = servidor_certo();
    for atual in [v(0, 2, 0), v(0, 2, 1), v(0, 10, 0), v(1, 0, 0)] {
        assert_eq!(atualizador(&servidor).consultar(atual), Ok(None), "{atual}");
    }
    assert!(servidor.pedidos().iter().all(|pedido| caminho(pedido).starts_with("/repos/")), "só a lista foi pedida");
}

#[test]
fn escolhe_a_maior_versao_valida_e_ignora_o_que_nao_e_release_do_desktop() {
    let lancamentos = lista(&[
        lancamento("desktop-v0.3.0", ""),
        lancamento("desktop-v0.10.0", ""),
        lancamento("desktop-v0.9.0", ""),
        // Não valem: rascunho, versão de teste, outro produto, etiqueta fora do formato.
        lancamento("desktop-v9.0.0", r#","draft":true"#),
        lancamento("desktop-v8.0.0", r#","prerelease":true"#),
        lancamento("v7.0.0", ""),
        lancamento("server-v6.0.0", ""),
        lancamento("desktop-v5.0", ""),
        lancamento("desktop-v5.0.0-beta", ""),
        lancamento("desktop-v5.0.0/../../x", ""),
        // Não vale: release sem pacote para esta plataforma.
        r#"{"tag_name":"desktop-v4.0.0","assets":[{"name":"awikabot-desktop-macos-arm64.json"}]}"#.to_owned(),
        r#"{"tag_name":"desktop-v3.0.0"}"#.to_owned(),
    ]);
    let pacote = b"dez";
    let do_manifesto = manifesto("0.10.0", pacote.len(), &sha256(pacote));
    let servidor = ServidorFalso::subir(move |_, pedido| match caminho(pedido).as_str() {
        "/repos/dono/repositorio/releases?per_page=30" => RespostaFalsa::json(200, &lancamentos),
        "/dono/repositorio/releases/download/desktop-v0.10.0/awikabot-desktop-windows-x64.json" => RespostaFalsa::json(200, &do_manifesto),
        _ => RespostaFalsa::html(404),
    });
    let oferta = atualizador(&servidor).consultar(v(0, 9, 5)).expect("consulta").expect("há versão maior");
    assert_eq!((oferta.versao, oferta.etiqueta.as_str()), (v(0, 10, 0), "desktop-v0.10.0"));
}

#[test]
fn manifesto_que_nao_bate_com_a_versao_pedida_e_recusado() {
    let bom = sha256(PACOTE);
    let ruins = [
        ("de outra versão", manifesto("0.3.0", 10, &bom)),
        ("de outra plataforma", manifesto("0.2.0", 10, &bom).replace(r#""plataforma":"windows-x64""#, r#""plataforma":"macos-arm64""#)),
        ("arquivo com outro nome", manifesto("0.2.0", 10, &bom).replace("awikabot-0.2.0-windows-x64.exe", "outro.exe")),
        (
            "arquivo com caminho",
            manifesto("0.2.0", 10, &bom).replace("awikabot-0.2.0-windows-x64.exe", "../awikabot-0.2.0-windows-x64.exe"),
        ),
        ("tamanho zero", manifesto("0.2.0", 0, &bom)),
        ("tamanho absurdo", manifesto("0.2.0", 2_000_000_000, &bom)),
        ("hash curto", manifesto("0.2.0", 10, &bom[..63])),
        ("hash em maiúsculas", manifesto("0.2.0", 10, &bom.to_uppercase())),
        ("hash com outra coisa", manifesto("0.2.0", 10, &format!("{}zz", &bom[..62]))),
        ("sem campo", r#"{"versao":"0.2.0"}"#.to_owned()),
        ("não é JSON", "<html>pagina de erro</html>".to_owned()),
    ];
    for (caso, do_manifesto) in ruins {
        let servidor = servidor_com(RespostaFalsa::bytes(200, PACOTE), do_manifesto);
        let resultado = atualizador(&servidor).consultar(v(0, 1, 0));
        assert!(matches!(resultado, Err(ErroDeAtualizacao::RespostaInvalida(_))), "{caso}: {resultado:?}");
    }
}

#[test]
fn erro_e_resposta_estranha_na_lista_de_versoes_nao_viram_oferta() {
    type Caso = (&'static str, fn() -> RespostaFalsa);
    let casos: [Caso; 5] = [
        ("limite de pedidos", || RespostaFalsa::json(403, r#"{"message":"API rate limit exceeded"}"#)),
        ("erro do servidor", || RespostaFalsa::html(500)),
        ("página no lugar da lista", || RespostaFalsa::json(200, "<html></html>")),
        ("objeto no lugar da lista", || RespostaFalsa::json(200, r#"{"message":"Not Found"}"#)),
        // A lista não é buscada em outro endereço só porque alguém no caminho mandou.
        ("redirecionamento", || RespostaFalsa::redirecionando("/repos/dono/repositorio/outra-lista")),
    ];
    for (caso, resposta) in casos {
        let servidor = ServidorFalso::subir(move |_, _| resposta());
        let resultado = atualizador(&servidor).consultar(v(0, 1, 0));
        assert!(matches!(resultado, Err(ErroDeAtualizacao::Rede(_) | ErroDeAtualizacao::RespostaInvalida(_))), "{caso}: {resultado:?}");
        assert_eq!(servidor.pedidos().len(), 1, "{caso}: nenhum outro pedido devia ter saído");
    }
}

#[test]
fn baixa_confere_e_so_entao_da_o_nome_final_ao_arquivo() {
    let servidor = servidor_certo();
    let pasta = Pasta::nova("certo");
    let andamento = Arc::new(Mutex::new(Vec::new()));
    let (do_andamento, cancelar) = (andamento.clone(), AtomicBool::new(false));
    let baixado = atualizador(&servidor)
        .baixar(&oferta_certa(), &pasta.0, &cancelar, &mut |recebidos| do_andamento.lock().expect("trava").push(recebidos))
        .expect("download");

    assert_eq!(baixado, pasta.0.join("awikabot-0.2.0-windows-x64.exe"));
    assert_eq!(std::fs::read(&baixado).expect("ler"), PACOTE);
    assert_eq!(pasta.arquivos(), vec!["awikabot-0.2.0-windows-x64.exe"], "o arquivo provisório não fica para trás");
    assert_eq!(andamento.lock().expect("trava").last(), Some(&(PACOTE.len() as u64)));

    // Baixar de novo troca o arquivo que já estava lá pelo que acabou de ser conferido.
    std::fs::write(&baixado, b"resto de uma tentativa antiga").expect("gravar");
    assert_eq!(baixar(&servidor, &oferta_certa(), &pasta), Ok(baixado.clone()));
    assert_eq!(std::fs::read(&baixado).expect("ler"), PACOTE);
}

#[test]
fn pacote_que_nao_e_o_publicado_nao_fica_no_disco() {
    let trocado: Vec<u8> = PACOTE.iter().rev().copied().collect();
    let mut maior = PACOTE.to_vec();
    maior.extend_from_slice(b" e mais um pouco");
    let casos: [(&str, RespostaFalsa); 5] = [
        ("mesmo tamanho, outro conteúdo", RespostaFalsa::bytes(200, &trocado)),
        ("maior que o publicado", RespostaFalsa::bytes(200, &maior)),
        ("menor que o publicado", RespostaFalsa::bytes(200, &PACOTE[..PACOTE.len() - 5])),
        ("cortado no caminho", RespostaFalsa::bytes(200, &PACOTE[..20]).declarando(PACOTE.len())),
        ("página de erro no lugar do pacote", RespostaFalsa::html(502)),
    ];
    for (caso, pacote) in casos {
        let servidor = servidor_com(pacote, manifesto("0.2.0", PACOTE.len(), &sha256(PACOTE)));
        let pasta = Pasta::nova("ruim");
        let resultado = baixar(&servidor, &oferta_certa(), &pasta);
        match caso {
            "mesmo tamanho, outro conteúdo" => assert_eq!(resultado, Err(ErroDeAtualizacao::HashErrado), "{caso}"),
            "maior que o publicado" | "menor que o publicado" => {
                assert!(matches!(resultado, Err(ErroDeAtualizacao::TamanhoErrado { .. })), "{caso}: {resultado:?}");
            }
            _ => assert!(
                matches!(resultado, Err(ErroDeAtualizacao::Rede(_) | ErroDeAtualizacao::TamanhoErrado { .. })),
                "{caso}: {resultado:?}"
            ),
        }
        assert_eq!(pasta.arquivos(), Vec::<String>::new(), "{caso}: nada devia ficar na pasta");
    }
}

#[test]
fn se_o_publicado_mudou_desde_a_consulta_nada_e_baixado() {
    // O manifesto de agora diz outro hash: o que a pessoa viu no aviso não é mais o que está lá.
    let outro = sha256(b"outro pacote, publicado depois");
    let servidor = servidor_com(RespostaFalsa::bytes(200, PACOTE), manifesto("0.2.0", PACOTE.len(), &outro));
    let pasta = Pasta::nova("mudou");
    assert_eq!(baixar(&servidor, &oferta_certa(), &pasta), Err(ErroDeAtualizacao::OfertaMudou));
    assert_eq!(pasta.arquivos(), Vec::<String>::new());
    assert!(servidor.pedidos().iter().all(|pedido| !caminho(pedido).ends_with(".exe")), "o pacote nem foi pedido");
}

#[test]
fn download_cancelado_nao_deixa_arquivo() {
    let servidor = servidor_certo();
    let pasta = Pasta::nova("cancelado");
    let resultado = atualizador(&servidor).baixar(&oferta_certa(), &pasta.0, &AtomicBool::new(true), &mut |_| {});
    assert_eq!(resultado, Err(ErroDeAtualizacao::Cancelado));
    assert_eq!(pasta.arquivos(), Vec::<String>::new());
}

#[test]
fn segue_o_redirecionamento_do_arquivo_como_o_github_entrega() {
    let do_manifesto = manifesto("0.2.0", PACOTE.len(), &sha256(PACOTE));
    let servidor = ServidorFalso::subir(move |_, pedido| match caminho(pedido).as_str() {
        "/dono/repositorio/releases/download/desktop-v0.2.0/awikabot-desktop-windows-x64.json" => {
            RespostaFalsa::redirecionando("/guardado/manifesto")
        }
        "/guardado/manifesto" => RespostaFalsa::json(200, &do_manifesto),
        "/dono/repositorio/releases/download/desktop-v0.2.0/awikabot-0.2.0-windows-x64.exe" => {
            RespostaFalsa::redirecionando("/guardado/pacote")
        }
        "/guardado/pacote" => RespostaFalsa::bytes(200, PACOTE),
        _ => RespostaFalsa::html(404),
    });
    let pasta = Pasta::nova("redirecionado");
    let baixado = baixar(&servidor, &oferta_certa(), &pasta).expect("download");
    assert_eq!(std::fs::read(baixado).expect("ler"), PACOTE);
}
