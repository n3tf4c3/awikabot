//! Diz ao sistema que o app está aberto, por um objeto com nome que dura enquanto o processo durar.
//!
//! Quem pergunta é o desinstalador: com o app aberto, o Windows não deixa apagar o executável, e
//! a desinstalação ficaria pela metade. Ele confere este nome e pede para fechar o app antes.

/// Cria a marca. Não há o que fazer se o sistema recusar: o app abre do mesmo jeito.
#[cfg(windows)]
pub fn marcar_como_aberto(nome: &str) {
    use windows_sys::Win32::System::Threading::CreateMutexW;

    let largo: Vec<u16> = nome.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: `largo` é um texto UTF-16 terminado em zero que vive até o fim da chamada; os outros
    // dois argumentos são os valores que a API documenta para "sem opções". O identificador
    // devolvido fica de propósito sem fechar: o sistema o solta quando o processo termina, e é
    // essa a duração que a marca deve ter.
    unsafe {
        CreateMutexW(std::ptr::null(), 0, largo.as_ptr());
    }
}

#[cfg(not(windows))]
pub fn marcar_como_aberto(_nome: &str) {}

#[cfg(all(test, windows))]
mod testes {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::OpenMutexW;

    use super::*;

    /// O direito de só perguntar pelo estado do objeto (`SYNCHRONIZE`).
    const SO_CONSULTAR: u32 = 0x0010_0000;

    fn existe(nome: &str) -> bool {
        let largo: Vec<u16> = nome.encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: `largo` termina em zero e vive até o fim da chamada.
        let marca = unsafe { OpenMutexW(SO_CONSULTAR, 0, largo.as_ptr()) };
        if marca.is_null() {
            return false;
        }
        // SAFETY: `marca` acabou de ser devolvida por `OpenMutexW` e não é usada depois daqui.
        unsafe { CloseHandle(marca) };
        true
    }

    #[test]
    fn a_marca_existe_depois_de_criada_e_criar_de_novo_nao_quebra() {
        let nome = format!("awikabot.teste.{}", std::process::id());
        assert!(!existe(&nome), "o nome de teste não devia existir antes");
        marcar_como_aberto(&nome);
        assert!(existe(&nome));
        marcar_como_aberto(&nome);
        assert!(existe(&nome));
    }
}
