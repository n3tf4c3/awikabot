import { describe, expect, it } from 'vitest';
import { gerarContratoRust } from './contrato-rust';

describe('contrato em Rust', () => {
  // O arquivo é código do app de desktop, mas quem manda nele é este pacote. Se um esquema
  // mudar e o arquivo não for gerado de novo, este teste falha. Para gerar:
  //   pnpm --filter @awikabot/core contrato
  it('o arquivo gerado para o app de desktop está em dia', async () => {
    await expect(gerarContratoRust()).toMatchFileSnapshot('../../../apps/desktop/crates/cliente/src/contrato.rs');
  });

  it('leva as constantes e as variantes que o cliente usa', () => {
    const gerado = gerarContratoRust();
    expect(gerado).toContain('pub const VERSAO_PROTOCOLO: u64 = 1;');
    expect(gerado).toContain('pub const TEXTO: usize = 20000;');
    expect(gerado).toContain('#[serde(tag = "tipo")]\npub enum Evento {');
    expect(gerado).toContain('#[serde(rename = "em_andamento")]\n    EmAndamento,');
    expect(gerado).toContain('pub resolvida_em: Option<u64>,');
    expect(gerado).toContain('pub const MOTOR_PADRAO: &str = "claude-code";');
  });

  it('dá ao campo de resposta com valor padrão o mesmo padrão do esquema', () => {
    // Um servidor anterior ao campo não o manda: o bot dele é do motor padrão, com o esforço padrão.
    const gerado = gerarContratoRust();
    expect(gerado).toContain('fn padrao_bot_motor() -> String {\n    "claude-code".to_owned()\n}');
    expect(gerado).toContain('    #[serde(default = "padrao_bot_motor")]\n    pub motor: String,');
    expect(gerado).toContain('    #[serde(default)]\n    pub esforco: Option<String>,');
  });
});
