import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  codexGerenciadoInstalado,
  configuracaoDoCodexPorOpcao,
  configuracaoDoCodexToml,
  requisitosDoCodexToml,
} from './configuracao-codex';

const raiz = mkdtempSync(path.join(os.tmpdir(), 'awika-codex-config-'));
afterAll(() => rmSync(raiz, { recursive: true, force: true }));

describe('configuração do Codex', () => {
  it('fecha a busca na web, os conectores e o que age sem pedido, e prende a política', () => {
    const toml = configuracaoDoCodexToml();
    for (const linha of ['approval_policy = "on-request"', 'sandbox_mode = "read-only"', 'web_search = "disabled"', '[features]', 'apps = false', 'hooks = false', 'view_image = false']) {
      expect(toml).toContain(`${linha}\n`);
    }
    // As chaves soltas vêm antes da primeira tabela: depois dela, cairiam dentro de [features].
    expect(toml.indexOf('web_search')).toBeLessThan(toml.indexOf('[features]'));
    const requisitos = requisitosDoCodexToml();
    for (const linha of ['allowed_approval_policies = ["on-request"]', 'allowed_sandbox_modes = ["read-only"]', 'allowed_web_search_modes = ["disabled"]', 'allowed_approvals_reviewers = ["user"]', 'allow_managed_hooks_only = true']) {
      expect(requisitos).toContain(`${linha}\n`);
    }
  });

  it('fora da imagem, a mesma configuração vai em opções --nome=valor', () => {
    const opcoes = configuracaoDoCodexPorOpcao();
    expect(opcoes).toContain('--config=web_search="disabled"');
    expect(opcoes).toContain('--config=features.apps=false');
    expect(opcoes.every((opcao) => opcao.startsWith('--config='))).toBe(true);
  });

  it('confere que os arquivos de /etc/codex são exatamente os gerados', () => {
    const caminhos = { configuracao: path.join(raiz, 'managed_config.toml'), requisitos: path.join(raiz, 'requirements.toml') };
    expect(codexGerenciadoInstalado(caminhos)).toBe(false);
    writeFileSync(caminhos.configuracao, configuracaoDoCodexToml());
    writeFileSync(caminhos.requisitos, requisitosDoCodexToml());
    expect(codexGerenciadoInstalado(caminhos)).toBe(true);
    writeFileSync(caminhos.configuracao, configuracaoDoCodexToml().replace('web_search = "disabled"', 'web_search = "live"'));
    expect(codexGerenciadoInstalado(caminhos)).toBe(false);
  });
});
