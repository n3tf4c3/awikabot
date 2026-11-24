//! O que o app faz quando o desinstalador o chama com `--esquecer-sessao`: tira do computador a
//! credencial que ele guardou.
//!
//! Sem isso, o token deste computador ficaria no cofre do sistema depois de o app ir embora, e
//! continuaria valendo no servidor. O servidor é avisado por melhor esforço; o cofre é esvaziado
//! de qualquer jeito.

use awikabot_cliente::api::Api;
use awikabot_cliente::sessao::{self, Cofre};

/// A opção de linha de comando que o desinstalador passa ao app.
pub const OPCAO: &str = "--esquecer-sessao";

/// Revoga o token no servidor, se der, e esvazia o cofre. Devolve `false` se a sessão continuou
/// no cofre.
pub fn esquecer_sessao(cofre: &dyn Cofre, api: &Api) -> bool {
    if let Some(guardada) = sessao::carregar(cofre) {
        // Servidor fora do ar, sem rede ou token já recusado: nada disso impede a limpeza daqui.
        let _ = api.revogar_dispositivo(&guardada.credencial());
    }
    // Vale também para um cofre com lixo, que não chega a ser sessão.
    sessao::esquecer(cofre).is_ok()
}

#[cfg(test)]
mod testes {
    use awikabot_cliente::api::ErroApi;
    use awikabot_cliente::contrato::{Dispositivo, PedidoPareamento};
    use awikabot_cliente::servidor_de_teste::ServidorDeTeste;
    use awikabot_cliente::sessao::{CofreEmMemoria, Sessao};

    use super::*;

    #[test]
    fn esvazia_o_cofre_e_o_token_deixa_de_valer_no_servidor() {
        let servidor = ServidorDeTeste::subir();
        let api = Api::new();
        let pedido = PedidoPareamento { codigo: servidor.codigo_de_pareamento(), nome: "Computador de saída".into() };
        let resposta = api.parear(&servidor.base, &pedido).expect("parear");
        let guardada = Sessao { servidor: servidor.base.clone(), token: resposta.token, dispositivo: resposta.dispositivo };
        let cofre = CofreEmMemoria::com(&sessao::serializar(&guardada));
        assert!(api.listar_bots(&guardada.credencial()).is_ok());

        assert!(esquecer_sessao(&cofre, &api));
        assert_eq!(cofre.valor(), None);
        assert_eq!(api.listar_bots(&guardada.credencial()), Err(ErroApi::NaoAutenticado));
    }

    #[test]
    fn esvazia_o_cofre_mesmo_sem_conseguir_falar_com_o_servidor() {
        // Um endereço onde não há ninguém ouvindo.
        let morto = {
            let escuta = std::net::TcpListener::bind("127.0.0.1:0").expect("porta livre");
            format!("http://127.0.0.1:{}", escuta.local_addr().expect("endereço").port())
        };
        let guardada = Sessao {
            servidor: morto,
            token: "t".repeat(43),
            dispositivo: Dispositivo { id: "abcdefgh12345678".into(), nome: "Computador".into(), criado_em: 1 },
        };
        let cofre = CofreEmMemoria::com(&sessao::serializar(&guardada));
        assert!(esquecer_sessao(&cofre, &Api::new()));
        assert_eq!(cofre.valor(), None);
    }

    #[test]
    fn cofre_vazio_ou_com_lixo_tambem_termina_vazio() {
        assert!(esquecer_sessao(&CofreEmMemoria::default(), &Api::new()));
        let com_lixo = CofreEmMemoria::com("isto não é uma sessão");
        assert!(esquecer_sessao(&com_lixo, &Api::new()));
        assert_eq!(com_lixo.valor(), None);
    }

    #[test]
    fn avisa_quando_a_sessao_continuou_no_cofre() {
        let cofre = CofreEmMemoria::com("qualquer coisa");
        cofre.falhar_ao_apagar(true);
        cofre.falhar_ao_gravar(true);
        assert!(!esquecer_sessao(&cofre, &Api::new()));
    }
}
