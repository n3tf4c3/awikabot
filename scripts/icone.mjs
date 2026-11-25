// O desenho do ícone do awikabot: a letra a minúscula em azul, com dois olhos dentro, sobre um
// quadrado escuro de cantos arredondados. A haste da letra termina numa ponta, como a de um balão
// de conversa. O desenho é descrito por formas, não por imagem, para sair nítido em cada tamanho.
//
// Este módulo só desenha e escreve PNG. Quem grava os arquivos são os dois geradores, cada um ao
// lado do que gera:
//
//   apps/desktop/crates/app/recursos/gerar-icone.mjs   o .ico do app de desktop
//   apps/mobile/assets/gerar-icones.mjs                os PNG do app de celular
//
// Sem dependência: só o que o Node traz. Mudou o desenho, rode os dois e versione o que saiu.
import { crc32, deflateSync } from 'node:zlib';

// As cores são as do tema escuro do desktop (`tema.rs`): fundo, borda de controle, destaque e texto forte.
export const FUNDO = [0x1e, 0x1e, 0x1e];
export const FIO = [0x3a, 0x3a, 0x3a];
export const AZUL_DA_LETRA = [0x5a, 0xa0, 0xf2];
export const CLARO_DOS_OLHOS = [0xf0, 0xf0, 0xf0];
// As medidas do desenho estão numa grade de 256; `G` passa cada uma para a escala de 0 a 1.
const G = 1 / 256;
// Até este tamanho os olhos alargam, para não virarem um borrão, e o fio da borda some.
export const TAMANHO_PEQUENO = 24;
// O meio da letra na grade: é ele que vai para o centro quando a letra muda de tamanho.
export const MEIO_DA_LETRA = [129, 128];

/** Distância com sinal até um retângulo de cantos arredondados: negativa por dentro. */
function retanguloArredondado(x, y, cx, cy, meiaLargura, meiaAltura, raio) {
  const dx = Math.abs(x - cx) - (meiaLargura - raio);
  const dy = Math.abs(y - cy) - (meiaAltura - raio);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - raio;
}

function dentroDoTriangulo(x, y, [ax, ay], [bx, by], [cx, cy]) {
  const lado = (px, py, qx, qy) => (x - qx) * (py - qy) - (px - qx) * (y - qy);
  const [d1, d2, d3] = [lado(ax, ay, bx, by), lado(bx, by, cx, cy), lado(cx, cy, ax, ay)];
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** O que há da letra num ponto, em coordenadas de 0 a 1: os olhos, o traço, ou nada. */
function parteDaLetra(x, y, pequeno) {
  // Os olhos: duas pílulas em pé dentro do anel, mais largas nos tamanhos pequenos.
  const [meiaLargura, meiaAltura, afastamento] = pequeno ? [9, 16, 15] : [6, 12, 14];
  const noOlho = [114 - afastamento, 114 + afastamento].some(
    (centro) => retanguloArredondado(x, y, centro * G, 128 * G, meiaLargura * G, meiaAltura * G, meiaLargura * G) <= 0,
  );
  if (noOlho) return 'olho';
  // A letra: o anel, a haste à direita com o canto de cima arredondado, e a ponta de balão embaixo.
  const noAnel = Math.abs(Math.hypot(x - 114 * G, y - 128 * G) - 53 * G) <= 15 * G;
  const naHaste =
    x >= 160 * G && x <= 190 * G && y >= 60 * G && y <= 196 * G && !(x > 175 * G && y < 75 * G && Math.hypot(x - 175 * G, y - 75 * G) > 15 * G);
  const naPonta = dentroDoTriangulo(x, y, [190 * G, 168 * G], [212 * G, 196 * G], [190 * G, 196 * G]);
  return noAnel || naHaste || naPonta ? 'traco' : null;
}

/**
 * A cor de um ponto do desenho, em coordenadas de 0 a 1: [r, g, b], ou `null` se é vazio.
 *
 * - `quadro`: `arredondado` é o do desktop, com os cantos vazios e um fio junto à borda; `cheio`
 *   leva o fundo até a borda, para o sistema recortar; `nenhum` deixa só a letra.
 * - `escala`: o tamanho da letra em relação ao desenho do desktop, que é 1. Com outra escala, o
 *   meio da letra vai para o centro.
 * - `umaCor`: letra e olhos na mesma cor, para o ícone de uma tinta só.
 */
export function corDoPonto(x, y, tamanho, { quadro = 'arredondado', escala = 1, umaCor = null } = {}) {
  const ateABorda = retanguloArredondado(x, y, 0.5, 0.5, 0.47, 0.47, 0.22);
  if (quadro === 'arredondado' && ateABorda > 0) return null;
  const pequeno = tamanho <= TAMANHO_PEQUENO;
  const [lx, ly] = escala === 1 ? [x, y] : [(x - 0.5) / escala + MEIO_DA_LETRA[0] * G, (y - 0.5) / escala + MEIO_DA_LETRA[1] * G];
  const parte = parteDaLetra(lx, ly, pequeno);
  if (parte !== null) return umaCor ?? (parte === 'olho' ? CLARO_DOS_OLHOS : AZUL_DA_LETRA);
  if (quadro === 'nenhum') return null;
  // Um fio de dois pontos da grade junto à borda, para o quadrado não sumir sobre um fundo escuro.
  if (quadro === 'arredondado' && !pequeno && ateABorda > -2 * G) return FIO;
  return FUNDO;
}

/** Desenha num quadrado de `tamanho` pixels: RGBA, de cima para baixo, com as bordas suavizadas. */
export function desenhar(tamanho, opcoes = {}) {
  const amostras = tamanho >= 128 ? 4 : 8;
  const pixels = Buffer.alloc(tamanho * tamanho * 4);
  for (let linha = 0; linha < tamanho; linha++) {
    for (let coluna = 0; coluna < tamanho; coluna++) {
      let [r, g, b, cobertos] = [0, 0, 0, 0];
      for (let sy = 0; sy < amostras; sy++) {
        for (let sx = 0; sx < amostras; sx++) {
          const cor = corDoPonto((coluna + (sx + 0.5) / amostras) / tamanho, (linha + (sy + 0.5) / amostras) / tamanho, tamanho, opcoes);
          if (cor === null) continue;
          r += cor[0];
          g += cor[1];
          b += cor[2];
          cobertos += 1;
        }
      }
      const onde = (linha * tamanho + coluna) * 4;
      if (cobertos > 0) {
        pixels[onde] = Math.round(r / cobertos);
        pixels[onde + 1] = Math.round(g / cobertos);
        pixels[onde + 2] = Math.round(b / cobertos);
        pixels[onde + 3] = Math.round((255 * cobertos) / (amostras * amostras));
      }
    }
  }
  return pixels;
}

/**
 * Escreve um PNG a partir de pixels RGBA. Com `semTransparencia`, o arquivo sai sem o canal alfa,
 * que é como a loja da Apple pede o ícone; os pixels têm de estar todos cobertos.
 */
export function png(largura, altura, pixels, { semTransparencia = false } = {}) {
  const pedaco = (tipo, dados) => {
    const corpo = Buffer.concat([Buffer.from(tipo, 'ascii'), dados]);
    const saida = Buffer.alloc(corpo.length + 8);
    saida.writeUInt32BE(dados.length, 0);
    corpo.copy(saida, 4);
    saida.writeUInt32BE(crc32(corpo), corpo.length + 4);
    return saida;
  };
  const canais = semTransparencia ? 3 : 4;
  const cabecalho = Buffer.alloc(13);
  cabecalho.writeUInt32BE(largura, 0);
  cabecalho.writeUInt32BE(altura, 4);
  cabecalho.set([8, semTransparencia ? 2 : 6, 0, 0, 0], 8); // 8 bits por canal, RGB ou RGBA
  const linhas = Buffer.alloc((largura * canais + 1) * altura);
  for (let linha = 0; linha < altura; linha++) {
    const para = linha * (largura * canais + 1) + 1;
    if (!semTransparencia) {
      pixels.copy(linhas, para, linha * largura * 4, (linha + 1) * largura * 4);
      continue;
    }
    for (let coluna = 0; coluna < largura; coluna++) {
      const de = (linha * largura + coluna) * 4;
      if (pixels[de + 3] !== 255) throw new Error('png sem transparência: há pixel que não está todo coberto');
      pixels.copy(linhas, para + coluna * 3, de, de + 3);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pedaco('IHDR', cabecalho),
    pedaco('IDAT', deflateSync(linhas, { level: 9 })),
    pedaco('IEND', Buffer.alloc(0)),
  ]);
}
