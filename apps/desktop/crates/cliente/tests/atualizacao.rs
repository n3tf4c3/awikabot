//! A atualização do app contra um servidor de mentira, que faz o papel do GitHub: lista de
//! releases, manifesto e pacote. O que se confere é o que o cliente aceita e, principalmente, o
//! que ele recusa.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use awikabot_cliente::atualizacao::{Atualizador, ErroDeAtualizacao, Oferta, Origem, Versao, ocupar_pasta_de_pacotes};
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

/// O pedido da lista de releases, como o cliente o monta: trinta por página, e o número da página.
fn da_lista(pagina: usize) -> String {
    format!("/repos/dono/repositorio/releases?per_page=30&page={pagina}")
}

/// A página pedida, se o pedido é o da lista de releases.
fn pagina_da_lista(pedido: &PedidoRecebido) -> Option<usize> {
    caminho(pedido).strip_prefix("/repos/dono/repositorio/releases?per_page=30&page=")?.parse().ok()
}

const MANIFESTO_DA_0_2_0: &str = "/dono/repositorio/releases/download/desktop-v0.2.0/awikabot-desktop-windows-x64.json";

/// Uma lista de releases que não cabe numa página só. O teste dos scripts de release lê este
/// mesmo arquivo (`testar-ver-atualizacao.ps1`): o app e o script têm de escolher a mesma versão.
const RELEASES_EM_DUAS_PAGINAS: &str = include_str!("casos/releases-em-duas-paginas.json");

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
        "/repos/dono/repositorio/releases?per_page=30&page=1" => RespostaFalsa::json(200, &lista(&[lancamento("desktop-v0.2.0", "")])),
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
        "/repos/dono/repositorio/releases?per_page=30&page=1" => RespostaFalsa::json(200, &lancamentos),
        "/dono/repositorio/releases/download/desktop-v0.10.0/awikabot-desktop-windows-x64.json" => RespostaFalsa::json(200, &do_manifesto),
        _ => RespostaFalsa::html(404),
    });
    let oferta = atualizador(&servidor).consultar(v(0, 9, 5)).expect("consulta").expect("há versão maior");
    assert_eq!((oferta.versao, oferta.etiqueta.as_str()), (v(0, 10, 0), "desktop-v0.10.0"));
}

#[test]
fn acha_a_versao_que_so_aparece_na_segunda_pagina_da_lista() {
    let releases: Vec<serde_json::Value> = serde_json::from_str(RELEASES_EM_DUAS_PAGINAS).expect("a lista de teste");
    // A primeira página vem cheia, e nada nela serve: outros produtos, um rascunho e uma versão de teste.
    let serve = |release: &serde_json::Value| {
        let etiqueta = release["tag_name"].as_str().unwrap_or_default();
        etiqueta.starts_with("desktop-v") && release["draft"] == false && release["prerelease"] == false
    };
    assert!(releases.len() > 30 && !releases[..30].iter().any(serve) && releases[30..].iter().any(serve));

    let do_manifesto = manifesto("0.2.0", PACOTE.len(), &sha256(PACOTE));
    let servidor = ServidorFalso::subir(move |_, pedido| match (pagina_da_lista(pedido), caminho(pedido).as_str()) {
        (Some(pagina), _) => {
            let da_pagina: Vec<&serde_json::Value> = releases.iter().skip((pagina - 1) * 30).take(30).collect();
            RespostaFalsa::json(200, &serde_json::to_string(&da_pagina).expect("a página"))
        }
        (None, MANIFESTO_DA_0_2_0) => RespostaFalsa::json(200, &do_manifesto),
        _ => RespostaFalsa::html(404),
    });
    assert_eq!(atualizador(&servidor).consultar(v(0, 1, 0)), Ok(Some(oferta_certa())));

    // A segunda página veio com menos que uma página cheia: é a última, e a terceira nem é pedida.
    let pedidos: Vec<String> = servidor.pedidos().iter().map(caminho).collect();
    assert_eq!(pedidos, vec![da_lista(1), da_lista(2), MANIFESTO_DA_0_2_0.to_owned()]);
}

#[test]
fn lista_que_nao_acaba_para_no_teto_de_paginas_e_o_cabecalho_link_nao_e_seguido() {
    // Toda página vem cheia e diz, no cabeçalho, que a próxima fica em outro endereço. Só a
    // terceira traz um release do desktop.
    let sem_nada = lista(&vec![lancamento("server-v1.0.0", ""); 30]);
    let mut com_o_desktop = vec![lancamento("server-v1.0.0", ""); 29];
    com_o_desktop.push(lancamento("desktop-v0.2.0", ""));
    let com_o_desktop = lista(&com_o_desktop);
    let do_manifesto = manifesto("0.2.0", PACOTE.len(), &sha256(PACOTE));
    let servidor = ServidorFalso::subir(move |_, pedido| match (pagina_da_lista(pedido), caminho(pedido).as_str()) {
        (Some(pagina), _) => RespostaFalsa::json(200, if pagina == 3 { &com_o_desktop } else { &sem_nada })
            .com_cabecalho("link", r#"</repos/dono/repositorio/armadilha>; rel="next""#),
        (None, MANIFESTO_DA_0_2_0) => RespostaFalsa::json(200, &do_manifesto),
        _ => RespostaFalsa::html(404),
    });
    // Parar no teto não é erro: vale o que foi achado até ali.
    assert_eq!(atualizador(&servidor).consultar(v(0, 1, 0)), Ok(Some(oferta_certa())));

    // Vinte páginas, com o número montado pelo cliente, e o manifesto. Nenhum pedido ao endereço do cabeçalho.
    let pedidos: Vec<String> = servidor.pedidos().iter().map(caminho).collect();
    let mut esperados: Vec<String> = (1..=20).map(da_lista).collect();
    esperados.push(MANIFESTO_DA_0_2_0.to_owned());
    assert_eq!(pedidos, esperados);
}

#[test]
fn erro_numa_pagina_seguinte_nao_vira_oferta_com_a_lista_pela_metade() {
    // A primeira página vem cheia e já traz uma versão maior; a segunda não chega.
    let mut primeira = vec![lancamento("server-v1.0.0", ""); 29];
    primeira.push(lancamento("desktop-v0.2.0", ""));
    let primeira = lista(&primeira);
    let servidor = ServidorFalso::subir(move |_, pedido| match pagina_da_lista(pedido) {
        Some(1) => RespostaFalsa::json(200, &primeira),
        _ => RespostaFalsa::html(500),
    });
    let resultado = atualizador(&servidor).consultar(v(0, 1, 0));
    assert!(matches!(resultado, Err(ErroDeAtualizacao::Rede(_))), "{resultado:?}");
    let pedidos: Vec<String> = servidor.pedidos().iter().map(caminho).collect();
    assert_eq!(pedidos, vec![da_lista(1), da_lista(2)], "nem o manifesto foi pedido");
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
fn dois_downloads_da_mesma_versao_ao_mesmo_tempo_nao_gravam_no_mesmo_arquivo_provisorio() {
    // O pacote chega em duas partes, com uma pausa no meio: os dois downloads ficam abertos juntos,
    // como os de duas instâncias do app com a mesma pasta de dados.
    let pacote = RespostaFalsa::bytes(200, PACOTE).em_duas_partes(Duration::from_millis(600));
    let servidor = servidor_com(pacote, manifesto("0.2.0", PACOTE.len(), &sha256(PACOTE)));
    let pasta = Pasta::nova("juntos");
    let (resultados, provisorios) = std::thread::scope(|escopo| {
        let downloads: Vec<_> = (0..2).map(|_| escopo.spawn(|| baixar(&servidor, &oferta_certa(), &pasta))).collect();
        // O máximo de arquivos provisórios que estiveram na pasta ao mesmo tempo.
        let mut juntos = Vec::new();
        while juntos.len() < 2 && !downloads.iter().all(|download| download.is_finished()) {
            let agora: Vec<String> = pasta.arquivos().into_iter().filter(|nome| nome.ends_with(".part")).collect();
            if agora.len() > juntos.len() {
                juntos = agora;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let resultados: Vec<_> = downloads.into_iter().map(|download| download.join().expect("o download não devia quebrar")).collect();
        (resultados, juntos)
    });

    assert_eq!(provisorios.len(), 2, "cada download grava no arquivo provisório dele: {provisorios:?}");
    let destino = pasta.0.join("awikabot-0.2.0-windows-x64.exe");
    assert_eq!(resultados, vec![Ok(destino.clone()), Ok(destino.clone())], "um download não derruba o outro");
    assert_eq!(std::fs::read(&destino).expect("ler"), PACOTE);
    assert_eq!(pasta.arquivos(), vec!["awikabot-0.2.0-windows-x64.exe"], "nenhum arquivo provisório fica para trás");
}

#[test]
fn a_pasta_de_pacotes_so_e_esvaziada_por_quem_a_usa_sozinho() {
    let dados = Pasta::nova("ocupada");
    let pacotes = dados.0.join("atualizacoes");
    let guardar = |nome: &str| {
        std::fs::create_dir_all(&pacotes).expect("criar a pasta de pacotes");
        std::fs::write(pacotes.join(nome), b"um pacote").expect("gravar");
        pacotes.join(nome)
    };

    // Sem outra instância aberta, o que ficou de uma execução anterior é resto, e sai.
    let resto = guardar("resto-de-outra-execucao.exe");
    let primeira = ocupar_pasta_de_pacotes(&pacotes);
    assert!(!resto.exists(), "quem abre sozinho começa do zero");

    // A primeira instância baixa um pacote. A segunda abre, e o pacote da primeira fica.
    let pronto = guardar("awikabot-0.2.0-windows-x64.exe");
    let segunda = ocupar_pasta_de_pacotes(&pacotes);
    assert!(pronto.exists(), "a segunda instância apagou o pacote que a primeira tinha pronto");

    // A primeira fecha. Com a segunda ainda aberta, uma terceira também não apaga nada.
    drop(primeira);
    let terceira = ocupar_pasta_de_pacotes(&pacotes);
    assert!(pronto.exists(), "ainda há outra instância aberta");

    // Só depois de todas fecharem o pacote vira resto.
    drop(segunda);
    drop(terceira);
    // A trava de quem fechou pode durar um instante a mais: se outro teste deste executável abre
    // um processo bem nessa hora, o processo novo nasce com cópias dos arquivos abertos, e a trava
    // só se solta quando ele troca de programa. Visto na CI do macOS. Enquanto isso, quem abre não
    // apaga nada, que é o lado seguro; a espera curta deixa o instante passar.
    let limite = Instant::now() + Duration::from_secs(5);
    let _quarta = loop {
        let uso = ocupar_pasta_de_pacotes(&pacotes);
        if !pronto.exists() || Instant::now() >= limite {
            break uso;
        }
        drop(uso);
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(!pronto.exists(), "sem ninguém usando, o pacote é resto e sai");
}

/// A pasta de dados do app de mentira, e o papel dele, para o processo que o teste abaixo abre.
const PASTA_DO_APP_DE_MENTIRA: &str = "AWIKABOT_TESTE_PASTA_DO_APP";
const PAPEL_DE_INSTALADOR: &str = "AWIKABOT_TESTE_INSTALADOR";
const APP_DE_MENTIRA: &str = "apoio_o_app_de_mentira_em_outro_processo";

/// Espera um arquivo de aviso aparecer na pasta. Diz se apareceu dentro do prazo.
fn apareceu(pasta: &std::path::Path, aviso: &str) -> bool {
    let limite = Instant::now() + Duration::from_secs(20);
    while !pasta.join(aviso).exists() && Instant::now() < limite {
        std::thread::sleep(Duration::from_millis(20));
    }
    pasta.join(aviso).exists()
}

/// Não testa nada sozinho: é o que roda no outro processo que o teste seguinte abre, este mesmo
/// executável de teste chamado de novo. Sem as variáveis dele, sai na hora.
#[test]
fn apoio_o_app_de_mentira_em_outro_processo() {
    let Some(pasta) = std::env::var_os(PASTA_DO_APP_DE_MENTIRA).map(PathBuf::from) else { return };
    let avisar = |aviso: &str| std::fs::write(pasta.join(aviso), b"").expect("avisar");
    if std::env::var_os(PAPEL_DE_INSTALADOR).is_some() {
        // O instalador: um processo que o app abre e que continua depois de o app sair.
        avisar("instalador-aberto");
        apareceu(&pasta, "fechar-o-instalador");
        avisar("instalador-fechado");
        return;
    }
    // O app: ocupa a pasta de pacotes, abre o instalador como o app de verdade faz, sem esperar por
    // ele, e fica aberto até o teste o matar. O prazo é só para ele não ficar para trás se o teste quebrar.
    let _uso = ocupar_pasta_de_pacotes(&pasta.join("atualizacoes"));
    Command::new(std::env::current_exe().expect("este executável"))
        .args([APP_DE_MENTIRA, "--exact"])
        .env(PAPEL_DE_INSTALADOR, "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .expect("abrir o instalador de mentira");
    assert!(apareceu(&pasta, "instalador-aberto"));
    avisar("app-aberto");
    apareceu(&pasta, "o-teste-mata-antes");
}

#[test]
fn a_trava_da_pasta_de_pacotes_vale_entre_processos_e_o_instalador_nao_a_herda() {
    let dados = Pasta::nova("processos");
    let pacotes = dados.0.join("atualizacoes");
    let mut app = Command::new(std::env::current_exe().expect("este executável"))
        .args([APP_DE_MENTIRA, "--exact"])
        .env(PASTA_DO_APP_DE_MENTIRA, &dados.0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("abrir o app de mentira");
    assert!(apareceu(&dados.0, "app-aberto"), "o app de mentira não abriu");

    // Outro processo está com a pasta, e tem um pacote pronto nela: este, que abre depois, não o apaga.
    let pronto = pacotes.join("awikabot-0.2.0-windows-x64.exe");
    std::fs::create_dir_all(&pacotes).expect("criar a pasta de pacotes");
    std::fs::write(&pronto, b"um pacote").expect("gravar");
    drop(ocupar_pasta_de_pacotes(&pacotes));
    assert!(pronto.exists(), "a instância que abriu depois apagou o pacote da que já estava aberta");

    // O app morre sem avisar, e o instalador que ele abriu continua rodando. A trava se solta com
    // o processo do app e não passou para o instalador: quem abre agora está sozinho, e limpa.
    app.kill().expect("matar o app de mentira");
    app.wait().expect("esperar o app de mentira");
    let limite = Instant::now() + Duration::from_secs(5);
    loop {
        let uso = ocupar_pasta_de_pacotes(&pacotes);
        if !pronto.exists() {
            break;
        }
        drop(uso);
        assert!(Instant::now() < limite, "a trava continuou presa depois de o app morrer, com o instalador aberto");
        std::thread::sleep(Duration::from_millis(50));
    }

    // O instalador esteve aberto durante tudo isso: só agora ele fecha.
    assert!(!dados.0.join("instalador-fechado").exists());
    std::fs::write(dados.0.join("fechar-o-instalador"), b"").expect("avisar");
    assert!(apareceu(&dados.0, "instalador-fechado"), "o instalador de mentira não estava aberto");
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
