//! Grava no executável do Windows o ícone, a versão e a descrição do app.
//!
//! O ícone entra com o número 1, que é o que a GPUI procura para a janela e a barra de tarefas.
//! A versão é a do pacote, que vem de `[workspace.package]`: é a única fonte dela. O manifesto
//! do executável continua sendo o que a GPUI embute.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=recursos/awikabot.ico");
    // Em outros sistemas não há o que gravar: o ícone e a versão vão no pacote do app.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let mut recursos = winresource::WindowsResource::new();
    recursos
        .set_icon_with_id("recursos/awikabot.ico", "1")
        .set("ProductName", "awikabot")
        .set("FileDescription", "awikabot")
        .set("OriginalFilename", "awikabot.exe")
        .set("InternalName", "awikabot")
        .set("LegalCopyright", "Licença MIT")
        // Português do Brasil.
        .set_language(0x0416);
    // Sem os recursos o executável sairia sem ícone e sem versão, e o pacote não poderia conferi-la.
    recursos.compile().expect("gravar o ícone e a versão no executável");
}
