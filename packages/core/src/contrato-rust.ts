// Gera os tipos do contrato em Rust, para o app de desktop, a partir dos esquemas deste pacote.
// Não é exportado pelo `index.ts`: só o teste `contrato-rust.test.ts` o usa, para manter o
// arquivo gerado em dia.
import { z, type ZodType } from 'zod';
import * as core from './index';

type Json = Record<string, unknown>;

/** O que o servidor devolve. A ordem aqui é a ordem no arquivo gerado. */
const RESPOSTAS: Record<string, ZodType> = {
  Saude: core.EsquemaSaude,
  InfoDoServidor: core.EsquemaInfoDoServidor,
  Erro: core.EsquemaErro,
  Dispositivo: core.EsquemaDispositivo,
  RespostaPareamento: core.EsquemaRespostaPareamento,
  ModeloSugerido: core.EsquemaModeloSugerido,
  EsforcoDoMotor: core.EsquemaEsforcoDoMotor,
  MotorDoCatalogo: core.EsquemaMotorDoCatalogo,
  Catalogo: core.EsquemaCatalogo,
  Bot: core.EsquemaBot,
  ListaBots: core.EsquemaListaBots,
  Mensagem: core.EsquemaMensagem,
  ListaMensagens: core.EsquemaListaMensagens,
  RespostaTurno: core.EsquemaRespostaTurno,
  Aprovacao: core.EsquemaAprovacao,
  ListaAprovacoes: core.EsquemaListaAprovacoes,
  Evento: core.EsquemaEvento,
};

/** O que o cliente manda, como a pessoa digita: antes de o servidor normalizar. */
const PEDIDOS: Record<string, ZodType> = {
  PedidoPareamento: core.EsquemaPedidoPareamento,
  BotEntrada: core.EsquemaBotEntrada,
  BotEdicao: core.EsquemaBotEdicao,
  PedidoTurno: core.EsquemaPedidoTurno,
  DecisaoAprovacao: core.EsquemaDecisaoAprovacao,
};

const emSnake = (nome: string): string => nome.replace(/[A-Z]/g, (letra) => `_${letra.toLowerCase()}`);
const emCamel = (nome: string): string => nome.replace(/_([a-z0-9])/g, (_tudo, letra: string) => letra.toUpperCase());
const emPascal = (nome: string): string => {
  const camel = emCamel(nome.toLowerCase() === nome ? nome : emSnake(nome));
  return camel.charAt(0).toUpperCase() + camel.slice(1);
};
const emConstante = (nome: string): string => emSnake(nome).toUpperCase();

function paraJson(esquemas: Record<string, ZodType>, io: 'input' | 'output'): Record<string, Json> {
  const registro = z.registry<{ id: string }>();
  for (const [id, esquema] of Object.entries(esquemas)) registro.add(esquema, { id });
  return z.toJSONSchema(registro, { target: 'draft-7', io }).schemas as Record<string, Json>;
}

function ehObjeto(valor: unknown): valor is Json {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

/** Separa `T | null` em `T`. Devolve `null` se o esquema não for dessa forma. */
function semNulo(esquema: Json): Json | null {
  const opcoes = esquema.anyOf;
  if (!Array.isArray(opcoes) || opcoes.length !== 2) return null;
  const naoNulos = opcoes.filter((opcao) => ehObjeto(opcao) && opcao.type !== 'null');
  return naoNulos.length === 1 && ehObjeto(naoNulos[0]) ? naoNulos[0] : null;
}

function valoresDeTexto(esquema: Json): string[] | null {
  if (esquema.type !== 'string') return null;
  if (typeof esquema.const === 'string') return [esquema.const];
  if (Array.isArray(esquema.enum) && esquema.enum.every((valor) => typeof valor === 'string')) return esquema.enum as string[];
  return null;
}

class Gerador {
  private readonly blocos: string[] = [];

  private enumDeTexto(nome: string, valores: string[]): void {
    const linhas = valores.map((valor) => `    #[serde(rename = "${valor}")]\n    ${emPascal(valor)},`);
    this.blocos.push(
      `#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]\npub enum ${nome} {\n${linhas.join('\n')}\n}`,
    );
  }

  /** O tipo Rust de um campo. Enums de texto ganham um tipo próprio, com o nome do dono e do campo. */
  private tipo(esquema: Json, dono: string, campo: string): string {
    if (typeof esquema.$ref === 'string') return esquema.$ref;
    const interno = semNulo(esquema);
    if (interno) return `Option<${this.tipo(interno, dono, campo)}>`;

    const valores = valoresDeTexto(esquema);
    if (valores) {
      const nome = `${dono}${emPascal(campo)}`;
      this.enumDeTexto(nome, valores);
      return nome;
    }
    switch (esquema.type) {
      case 'string':
        return 'String';
      case 'boolean':
        return 'bool';
      case 'integer':
        return [esquema.minimum, esquema.exclusiveMinimum].some((piso) => typeof piso === 'number' && piso >= 0) ? 'u64' : 'i64';
      case 'array':
        if (ehObjeto(esquema.items)) return `Vec<${this.tipo(esquema.items, dono, campo)}>`;
        break;
      default:
        break;
    }
    throw new Error(`contrato-rust: não sei representar ${dono}.${campo}: ${JSON.stringify(esquema)}`);
  }

  /** As linhas dos campos de um objeto, na ordem do esquema. `ignorar` é o campo que marca a variante. */
  private campos(esquema: Json, dono: string, recuo: string, publico: boolean, ignorar?: string): string[] {
    const propriedades = ehObjeto(esquema.properties) ? esquema.properties : {};
    const obrigatorios = new Set(Array.isArray(esquema.required) ? (esquema.required as string[]) : []);
    const linhas: string[] = [];
    for (const [nome, bruto] of Object.entries(propriedades)) {
      if (nome === ignorar || !ehObjeto(bruto)) continue;
      let tipo = this.tipo(bruto, dono, nome);
      const atributos: string[] = [];
      if (obrigatorios.has(nome) && 'default' in bruto) {
        // Campo de resposta com valor padrão: um servidor anterior a ele não o manda, e o
        // cliente fica com o mesmo valor que o esquema dá.
        if (bruto.default === null && tipo.startsWith('Option<')) {
          atributos.push('default');
        } else if (typeof bruto.default === 'string' && tipo === 'String') {
          const funcao = `padrao${emSnake(dono)}_${emSnake(nome)}`;
          this.blocos.push(`fn ${funcao}() -> String {\n    ${JSON.stringify(bruto.default)}.to_owned()\n}`);
          atributos.push(`default = "${funcao}"`);
        } else {
          throw new Error(`contrato-rust: não sei o valor padrão de ${dono}.${nome}: ${JSON.stringify(bruto.default)}`);
        }
      } else if (!obrigatorios.has(nome)) {
        if (tipo.startsWith('Option<') && !('default' in bruto)) {
          // Ausente e nulo dizem coisas diferentes: "não mexer" e "apagar o valor".
          tipo = `Option<${tipo}>`;
          atributos.push('default', 'skip_serializing_if = "Option::is_none"', 'with = "crate::opcional_nulo"');
        } else {
          if (!tipo.startsWith('Option<')) tipo = `Option<${tipo}>`;
          atributos.push('default', 'skip_serializing_if = "Option::is_none"');
        }
      }
      const emRust = emSnake(nome);
      if (emCamel(emRust) !== nome) atributos.unshift(`rename = "${nome}"`);
      if (atributos.length > 0) linhas.push(`${recuo}#[serde(${atributos.join(', ')})]`);
      linhas.push(`${recuo}${publico ? 'pub ' : ''}${emRust}: ${tipo},`);
    }
    return linhas;
  }

  private estrutura(nome: string, esquema: Json): void {
    const campos = this.campos(esquema, nome, '    ', true);
    this.blocos.push(
      `#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]\n#[serde(rename_all = "camelCase")]\npub struct ${nome} {\n${campos.join('\n')}\n}`,
    );
  }

  /** Uma união marcada por um campo de texto fixo vira um enum com esse campo como marca. */
  private uniao(nome: string, variantes: Json[]): void {
    const primeira = variantes[0];
    const marca = Object.entries(ehObjeto(primeira?.properties) ? primeira.properties : {}).find(
      ([, campo]) => ehObjeto(campo) && typeof campo.const === 'string',
    )?.[0];
    if (!marca) throw new Error(`contrato-rust: união ${nome} sem campo que marque a variante`);

    const linhas: string[] = [];
    for (const variante of variantes) {
      const propriedades = ehObjeto(variante.properties) ? variante.properties : {};
      const valor = ehObjeto(propriedades[marca]) ? propriedades[marca].const : undefined;
      if (typeof valor !== 'string') throw new Error(`contrato-rust: variante de ${nome} sem "${marca}" fixo`);
      const nomeDaVariante = emPascal(valor);
      const campos = this.campos(variante, `${nome}${nomeDaVariante}`, '        ', false, marca);
      linhas.push(
        campos.length === 0
          ? `    #[serde(rename = "${valor}")]\n    ${nomeDaVariante},`
          : `    #[serde(rename = "${valor}", rename_all = "camelCase")]\n    ${nomeDaVariante} {\n${campos.join('\n')}\n    },`,
      );
    }
    this.blocos.push(
      `#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]\n#[serde(tag = "${marca}")]\npub enum ${nome} {\n${linhas.join('\n')}\n}`,
    );
  }

  declarar(esquemas: Record<string, Json>): void {
    for (const [nome, esquema] of Object.entries(esquemas)) {
      if (Array.isArray(esquema.oneOf)) this.uniao(nome, esquema.oneOf.filter(ehObjeto));
      else if (esquema.type === 'object') this.estrutura(nome, esquema);
      else throw new Error(`contrato-rust: ${nome} não é objeto nem união`);
    }
  }

  texto(): string {
    return this.blocos.join('\n\n');
  }
}

/** O conteúdo de `apps/desktop/crates/cliente/src/contrato.rs`. */
export function gerarContratoRust(): string {
  const limites = Object.entries(core.LIMITES).map(([nome, valor]) => `    pub const ${emConstante(nome)}: usize = ${valor};`);
  const gerador = new Gerador();
  gerador.declarar(paraJson(RESPOSTAS, 'output'));
  gerador.declarar(paraJson(PEDIDOS, 'input'));

  return `// Gerado de packages/core/src/index.ts. Não editar à mão.
// Para atualizar: pnpm --filter @awikabot/core contrato
// O teste do core falha enquanto este arquivo estiver diferente do que o contrato diz.

use serde::{Deserialize, Serialize};

/// Versão do contrato entre servidor e clientes.
pub const VERSAO_PROTOCOLO: u64 = ${core.VERSAO_PROTOCOLO};
/// Intervalo do sinal de vida do fluxo de eventos, em milissegundos.
pub const INTERVALO_PING_MS: u64 = ${core.INTERVALO_PING_MS};
/// Quanto um pedido de aprovação espera pela pessoa, em milissegundos.
pub const ESPERA_APROVACAO_MS: u64 = ${core.ESPERA_APROVACAO_MS};
/// O motor do bot que não diz o seu.
pub const MOTOR_PADRAO: &str = ${JSON.stringify(core.MOTOR_PADRAO)};

/// Limites que o servidor aplica. O cliente usa os mesmos nos campos.
pub mod limites {
${limites.join('\n')}
}

${gerador.texto()}
`;
}
