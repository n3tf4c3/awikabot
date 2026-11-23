export type MotivoEndereco = 'vazio' | 'invalido' | 'esquema' | 'credenciais' | 'http_fora_da_rede_local';

export type EnderecoServidor = { ok: true; url: string } | { ok: false; motivo: MotivoEndereco };

const MENSAGENS: Readonly<Record<MotivoEndereco, string>> = {
  vazio: 'Informe o endereço do servidor.',
  invalido: 'Endereço inválido. Exemplo: https://bots.exemplo.com',
  esquema: 'O endereço precisa começar com https:// (ou http:// na rede local).',
  credenciais: 'O endereço não pode levar usuário nem senha.',
  http_fora_da_rede_local: 'Use https:// neste endereço. http:// só vale para localhost e endereços da rede local.',
};

export function mensagemDoEndereco(motivo: MotivoEndereco): string {
  return MENSAGENS[motivo];
}

/** Os quatro números de um IPv4 escrito por extenso, ou `null`. */
function octetosIpv4(host: string): number[] | null {
  const partes = host.split('.');
  if (partes.length !== 4) return null;
  const octetos: number[] = [];
  for (const parte of partes) {
    if (!/^(0|[1-9]\d{0,2})$/.test(parte)) return null;
    const numero = Number(parte);
    if (numero > 255) return null;
    octetos.push(numero);
  }
  return octetos;
}

/** Os oito grupos de um IPv6 sem colchetes, ou `null`. Não aceita zona nem IPv4 embutido. */
function gruposIpv6(texto: string): number[] | null {
  const metades = texto.split('::');
  if (metades.length > 2) return null;
  const ler = (parte: string): number[] | null => {
    if (parte === '') return [];
    const grupos: number[] = [];
    for (const grupo of parte.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(grupo)) return null;
      grupos.push(Number.parseInt(grupo, 16));
    }
    return grupos;
  };
  const inicio = ler(metades[0] ?? '');
  if (inicio === null) return null;
  if (metades.length === 1) return inicio.length === 8 ? inicio : null;
  const fim = ler(metades[1] ?? '');
  if (fim === null || inicio.length + fim.length > 7) return null;
  return [...inicio, ...new Array<number>(8 - inicio.length - fim.length).fill(0), ...fim];
}

function nomeDeHostValido(host: string): boolean {
  if (host.length > 253) return false;
  return host.split('.').every((rotulo) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(rotulo));
}

type Host = { tipo: 'ipv4'; octetos: number[] } | { tipo: 'ipv6'; grupos: number[] } | { tipo: 'nome' };

function lerHost(host: string): Host | null {
  if (host.startsWith('[')) {
    if (!host.endsWith(']')) return null;
    const grupos = gruposIpv6(host.slice(1, -1));
    return grupos ? { tipo: 'ipv6', grupos } : null;
  }
  // Só números e pontos tem de ser um IPv4 completo: "10.0.1" não é nome de host.
  if (/^[0-9.]+$/.test(host)) {
    const octetos = octetosIpv4(host);
    return octetos ? { tipo: 'ipv4', octetos } : null;
  }
  return nomeDeHostValido(host) ? { tipo: 'nome' } : null;
}

/**
 * O nome exato `localhost`, loopback, redes privadas (RFC 1918), link-local e os equivalentes em IPv6.
 * Nenhum outro nome entra, nem `algo.localhost`: nada garante que o sistema resolva esse nome
 * para o próprio aparelho.
 */
function naRedeLocal(host: string, lido: Host): boolean {
  if (lido.tipo === 'nome') return host === 'localhost';
  if (lido.tipo === 'ipv4') {
    const [a = 0, b = 0] = lido.octetos;
    return (
      a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
    );
  }
  const primeiro = lido.grupos[0] ?? 0;
  const loopback = lido.grupos.every((grupo, indice) => grupo === (indice === 7 ? 1 : 0));
  return loopback || (primeiro & 0xfe00) === 0xfc00 || (primeiro & 0xffc0) === 0xfe80;
}

/**
 * Valida o endereço digitado e devolve a URL base, sem barra no fim.
 * Exige `https://`; `http://` só passa para localhost e endereços da rede local.
 * Sem esquema, assume `http://` para a rede local e `https://` para o resto.
 */
export function normalizarEnderecoServidor(texto: string): EnderecoServidor {
  const limpo = texto.trim();
  if (limpo === '') return { ok: false, motivo: 'vazio' };
  if (/\s/.test(limpo)) return { ok: false, motivo: 'invalido' };

  let esquema: 'http' | 'https' | null = null;
  let resto = limpo;
  const comEsquema = /^([a-z][a-z0-9+.-]*):\/\//i.exec(limpo);
  if (comEsquema) {
    const nome = (comEsquema[1] ?? '').toLowerCase();
    if (nome !== 'http' && nome !== 'https') return { ok: false, motivo: 'esquema' };
    esquema = nome;
    resto = limpo.slice(comEsquema[0].length);
  }

  const partes = /^([^/?#]*)(\/[^?#]*)?$/.exec(resto);
  if (!partes) return { ok: false, motivo: 'invalido' };
  const autoridade = partes[1] ?? '';
  const caminho = (partes[2] ?? '').replace(/\/+$/, '');
  if (autoridade.includes('@')) return { ok: false, motivo: 'credenciais' };
  if (!/^[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(caminho)) return { ok: false, motivo: 'invalido' };

  const comPorta = /^(.*?)(?::(\d{1,5}))?$/.exec(autoridade);
  const host = (comPorta?.[1] ?? '').toLowerCase();
  const porta = comPorta?.[2] === undefined ? null : Number(comPorta[2]);
  if (porta !== null && (porta < 1 || porta > 65535)) return { ok: false, motivo: 'invalido' };
  const lido = lerHost(host);
  if (!lido) return { ok: false, motivo: 'invalido' };

  const local = naRedeLocal(host, lido);
  esquema ??= local ? 'http' : 'https';
  if (esquema === 'http' && !local) return { ok: false, motivo: 'http_fora_da_rede_local' };

  const portaPadrao = esquema === 'https' ? 443 : 80;
  const sufixoPorta = porta === null || porta === portaPadrao ? '' : `:${porta}`;
  return { ok: true, url: `${esquema}://${host}${sufixoPorta}${caminho}` };
}
