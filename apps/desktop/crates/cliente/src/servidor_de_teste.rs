//! Sobe o servidor de verdade para os testes: o pacote de produção (`pnpm server:build`), com o
//! motor simulado e um banco descartável. Só existe com o recurso `teste-suporte`.

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use crate::api::Api;

pub struct ServidorDeTeste {
    processo: Child,
    /// Endereço do servidor, pronto para o cliente.
    pub base: String,
    dados: PathBuf,
    pacote: PathBuf,
    ambiente: Vec<(&'static str, String)>,
}

fn porta_livre() -> u16 {
    TcpListener::bind("127.0.0.1:0").expect("porta livre").local_addr().expect("endereço").port()
}

impl ServidorDeTeste {
    pub fn subir() -> Self {
        let pacote = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../server/dist/server.mjs");
        assert!(pacote.exists(), "falta o pacote do servidor; rode `pnpm server:build` na raiz do repositório");

        // Entre achar uma porta livre e o servidor passar a ouvi-la, outro teste rodando ao lado
        // pode pegá-la. O servidor então sai na partida, e a saída é tentar de novo com outras portas.
        for _ in 0..5 {
            if let Some(servidor) = Self::tentar_subir(&pacote) {
                return servidor;
            }
        }
        panic!("o servidor de teste saiu na partida em cinco tentativas seguidas");
    }

    /// Sobe o servidor em duas portas livres. `None` se o processo saiu antes de responder.
    fn tentar_subir(pacote: &Path) -> Option<Self> {
        let porta = porta_livre();
        let dados = std::env::temp_dir().join(format!("awikabot-teste-rust-{}-{porta}", std::process::id()));
        std::fs::create_dir_all(&dados).expect("pasta de dados do teste");
        let ambiente = vec![
            ("NODE_ENV", "test".to_owned()),
            ("AWIKA_HOST", "127.0.0.1".to_owned()),
            ("AWIKA_PORTA", porta.to_string()),
            ("AWIKA_PORTA_GANCHO", porta_livre().to_string()),
            ("AWIKA_DADOS", dados.display().to_string()),
            ("AWIKA_MOTOR", "simulado".to_owned()),
        ];
        let processo = Command::new("node")
            .arg(pacote)
            .envs(ambiente.iter().cloned())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("o Node precisa estar no PATH para subir o servidor");
        let mut servidor = Self { processo, base: format!("http://127.0.0.1:{porta}"), dados, pacote: pacote.to_owned(), ambiente };

        let api = Api::new();
        let limite = Instant::now() + Duration::from_secs(15);
        loop {
            let respondeu = api.saude(&servidor.base).is_ok();
            // O processo é conferido depois da resposta: se a porta ficou com outro teste, quem
            // respondeu foi o servidor dele, e o daqui já saiu. Ao soltar `servidor`, a pasta de
            // dados desta tentativa é apagada.
            if matches!(servidor.processo.try_wait(), Ok(Some(_))) {
                return None;
            }
            if respondeu {
                return Some(servidor);
            }
            assert!(Instant::now() < limite, "o servidor não respondeu em 15 s");
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    /// O código de uso único, como o comando `parear` do servidor o imprime.
    pub fn codigo_de_pareamento(&self) -> String {
        let saida =
            Command::new("node").arg(&self.pacote).arg("parear").envs(self.ambiente.iter().cloned()).output().expect("comando parear");
        String::from_utf8_lossy(&saida.stdout)
            .split_whitespace()
            .find(|palavra| palavra.len() == 14 && palavra.as_bytes()[4] == b'-' && palavra.as_bytes()[9] == b'-')
            .expect("código na saída do comando parear")
            .to_owned()
    }
}

impl Drop for ServidorDeTeste {
    fn drop(&mut self) {
        let _ = self.processo.kill();
        let _ = self.processo.wait();
        // Só a pasta que este teste criou, com o nome que ele mesmo montou.
        let _ = std::fs::remove_dir_all(&self.dados);
    }
}

// --- Servidor de mentira --------------------------------------------------------------------

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

/// Um pedido HTTP como chegou ao servidor de mentira.
#[derive(Debug, Clone)]
pub struct PedidoRecebido {
    /// A primeira linha, como `GET /v1/eventos HTTP/1.1`.
    pub linha: String,
    pub cabecalhos: Vec<(String, String)>,
    pub recebido_em: Instant,
}

impl PedidoRecebido {
    pub fn cabecalho(&self, nome: &str) -> Option<&str> {
        self.cabecalhos.iter().find(|(chave, _)| chave.eq_ignore_ascii_case(nome)).map(|(_, valor)| valor.as_str())
    }
}

/// O que o servidor de mentira responde a um pedido.
#[derive(Debug, Clone)]
pub struct RespostaFalsa {
    status: u16,
    tipo: &'static str,
    corpo: Vec<u8>,
    /// Quanto a conexão fica aberta depois do corpo, como um fluxo sem novidade.
    segurar: Duration,
    /// Cabeçalhos a mais, como o destino de um redirecionamento.
    cabecalhos: Vec<(String, String)>,
    /// O tamanho que a resposta diz ter, quando não é o do corpo: uma resposta cortada no caminho.
    tamanho_declarado: Option<usize>,
}

impl RespostaFalsa {
    fn com(status: u16, tipo: &'static str, corpo: Vec<u8>) -> Self {
        Self { status, tipo, corpo, segurar: Duration::ZERO, cabecalhos: Vec::new(), tamanho_declarado: None }
    }

    /// Um fluxo de eventos que manda `corpo` e fecha.
    pub fn fluxo(corpo: &str) -> Self {
        Self::com(200, "text/event-stream", corpo.as_bytes().to_vec())
    }

    pub fn json(status: u16, corpo: &str) -> Self {
        Self::com(status, "application/json", corpo.as_bytes().to_vec())
    }

    /// Uma página de erro de proxy ou de túnel: nada do contrato.
    pub fn html(status: u16) -> Self {
        Self::com(status, "text/html", b"<html><body>erro no caminho</body></html>".to_vec())
    }

    /// Um arquivo qualquer, como um pacote para download.
    pub fn bytes(status: u16, corpo: &[u8]) -> Self {
        Self::com(status, "application/octet-stream", corpo.to_vec())
    }

    /// Um redirecionamento para outro endereço.
    pub fn redirecionando(destino: &str) -> Self {
        let mut resposta = Self::com(302, "text/plain", Vec::new());
        resposta.cabecalhos.push(("location".to_owned(), destino.to_owned()));
        resposta
    }

    /// Diz ter `tamanho` bytes, mande o corpo o que mandar: é como uma resposta cortada chega ao cliente.
    pub fn declarando(mut self, tamanho: usize) -> Self {
        self.tamanho_declarado = Some(tamanho);
        self
    }

    pub fn segurando(mut self, duracao: Duration) -> Self {
        self.segurar = duracao;
        self
    }
}

/// Servidor HTTP mínimo, para o que o servidor de verdade não faz a pedido: cair no meio de um
/// fluxo, responder como um proxy, recusar um token. Cada pedido recebe o número dele, a partir de zero.
pub struct ServidorFalso {
    pub base: String,
    pedidos: Arc<Mutex<Vec<PedidoRecebido>>>,
    parar: Arc<AtomicBool>,
    escuta: Option<JoinHandle<()>>,
}

fn atender(
    mut conexao: TcpStream,
    responder: &dyn Fn(usize, &PedidoRecebido) -> RespostaFalsa,
    pedidos: &Mutex<Vec<PedidoRecebido>>,
    parar: &AtomicBool,
) {
    let _ = conexao.set_read_timeout(Some(Duration::from_secs(5)));
    let mut bruto = Vec::new();
    let mut pedaco = [0u8; 1024];
    while !bruto.windows(4).any(|janela| janela == b"\r\n\r\n") {
        match conexao.read(&mut pedaco) {
            Ok(0) | Err(_) => return,
            Ok(lidos) => bruto.extend_from_slice(&pedaco[..lidos]),
        }
    }
    let texto = String::from_utf8_lossy(&bruto).into_owned();
    let mut linhas = texto.split("\r\n");
    let pedido = PedidoRecebido {
        recebido_em: Instant::now(),
        linha: linhas.next().unwrap_or_default().to_owned(),
        cabecalhos: linhas
            .take_while(|linha| !linha.is_empty())
            .filter_map(|linha| linha.split_once(':').map(|(chave, valor)| (chave.trim().to_owned(), valor.trim().to_owned())))
            .collect(),
    };
    // O corpo do pedido é lido inteiro antes de responder. Fechar a conexão com o corpo por ler faz
    // o sistema mandar um RST, e o cliente pode perder a resposta que já estava escrita: num POST
    // cujo corpo chegava depois dos cabeçalhos, isso aparecia de vez em quando como falha de rede.
    let fim_dos_cabecalhos = bruto.windows(4).position(|janela| janela == b"\r\n\r\n").map_or(bruto.len(), |posicao| posicao + 4);
    let corpo_declarado = pedido.cabecalho("content-length").and_then(|valor| valor.parse::<usize>().ok()).unwrap_or(0);
    while bruto.len() < fim_dos_cabecalhos.saturating_add(corpo_declarado) {
        match conexao.read(&mut pedaco) {
            Ok(0) | Err(_) => break,
            Ok(lidos) => bruto.extend_from_slice(&pedaco[..lidos]),
        }
    }
    let numero = {
        let mut lista = pedidos.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        lista.push(pedido.clone());
        lista.len() - 1
    };
    let resposta = responder(numero, &pedido);
    // Um fluxo não tem tamanho: o corpo vai até a conexão fechar.
    let tamanho = if resposta.tipo == "text/event-stream" {
        String::new()
    } else {
        format!("content-length: {}\r\n", resposta.tamanho_declarado.unwrap_or(resposta.corpo.len()))
    };
    let extras: String = resposta.cabecalhos.iter().map(|(nome, valor)| format!("{nome}: {valor}\r\n")).collect();
    let cabecalho =
        format!("HTTP/1.1 {} X\r\ncontent-type: {}\r\n{tamanho}{extras}connection: close\r\n\r\n", resposta.status, resposta.tipo);
    if conexao.write_all(cabecalho.as_bytes()).and_then(|()| conexao.write_all(&resposta.corpo)).and_then(|()| conexao.flush()).is_err() {
        return;
    }
    let fim = Instant::now() + resposta.segurar;
    while Instant::now() < fim && !parar.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(5));
    }
}

impl ServidorFalso {
    pub fn subir(responder: impl Fn(usize, &PedidoRecebido) -> RespostaFalsa + Send + Sync + 'static) -> Self {
        let escuta = TcpListener::bind("127.0.0.1:0").expect("porta livre");
        escuta.set_nonblocking(true).expect("escuta sem bloqueio");
        let base = format!("http://127.0.0.1:{}", escuta.local_addr().expect("endereço").port());
        let pedidos = Arc::new(Mutex::new(Vec::new()));
        let parar = Arc::new(AtomicBool::new(false));
        let responder = Arc::new(responder);
        let (dos_pedidos, de_parar) = (pedidos.clone(), parar.clone());
        let thread = std::thread::spawn(move || {
            while !de_parar.load(Ordering::Relaxed) {
                match escuta.accept() {
                    Ok((conexao, _)) => {
                        let _ = conexao.set_nonblocking(false);
                        let (responder, pedidos, parar) = (responder.clone(), dos_pedidos.clone(), de_parar.clone());
                        std::thread::spawn(move || atender(conexao, responder.as_ref(), &pedidos, &parar));
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(3)),
                }
            }
        });
        Self { base, pedidos, parar, escuta: Some(thread) }
    }

    pub fn pedidos(&self) -> Vec<PedidoRecebido> {
        self.pedidos.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }
}

impl Drop for ServidorFalso {
    fn drop(&mut self) {
        self.parar.store(true, Ordering::Relaxed);
        if let Some(escuta) = self.escuta.take() {
            let _ = escuta.join();
        }
    }
}
