//! Cliente do servidor do awikabot, sem interface.
//!
//! O contrato (`contrato`) é gerado de `packages/core` e não se edita à mão. O resto segue as
//! mesmas regras do cliente do app de celular, em `apps/mobile/src/lib`.

#[rustfmt::skip]
pub mod contrato;

pub mod api;
pub mod conversa;
pub mod endereco;
pub mod fluxo;
pub(crate) mod opcional_nulo;
#[cfg(feature = "teste-suporte")]
pub mod servidor_de_teste;
pub mod sse;
