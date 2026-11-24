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
            .arg(&pacote)
            .envs(ambiente.iter().cloned())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("o Node precisa estar no PATH para subir o servidor");
        let servidor = Self { processo, base: format!("http://127.0.0.1:{porta}"), dados, pacote, ambiente };

        let api = Api::new();
        let limite = Instant::now() + Duration::from_secs(15);
        while api.saude(&servidor.base).is_err() {
            assert!(Instant::now() < limite, "o servidor não respondeu em 15 s");
            std::thread::sleep(Duration::from_millis(100));
        }
        servidor
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
