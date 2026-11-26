//! Cliente do servidor do awikabot, sem interface.
//!
//! O contrato (`contrato`) é gerado de `packages/core` e não se edita à mão. O resto segue as
//! mesmas regras do cliente do app de celular, em `apps/mobile/src/lib`.

#[rustfmt::skip]
pub mod contrato;

pub mod api;
pub mod aprovacoes;
pub mod atualizacao;
pub mod catalogo;
pub mod conversa;
pub mod endereco;
pub mod fluxo;
pub mod formulario_bot;
pub(crate) mod opcional_nulo;
pub mod preferencias;
#[cfg(feature = "teste-suporte")]
pub mod servidor_de_teste;
pub mod sessao;
pub mod sse;
