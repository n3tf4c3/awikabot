// Gera o ícone do app de desktop: a letra a minúscula em azul, com dois olhos dentro, sobre um
// quadrado escuro de cantos arredondados. A haste da letra termina numa ponta, como a de um balão
// de conversa. O desenho é descrito por formas, não por imagem, para sair nítido em cada tamanho,
// e o arquivo gerado fica versionado ao lado deste script.
//
//   node apps/desktop/crates/app/recursos/gerar-icone.mjs            regrava awikabot.ico
//   node apps/desktop/crates/app/recursos/gerar-icone.mjs amostra.png  grava também uma amostra
//
// Sem dependência: só o que o Node traz. Mudou o desenho, rode de novo e versione o .ico.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const TAMANHOS = [16, 20, 24, 32, 40, 48, 64, 128, 256];
// As cores são as do tema escuro do app (`tema.rs`): fundo, borda de controle, destaque e texto forte.
const FUNDO = [0x1e, 0x1e, 0x1e];
const FIO = [0x3a, 0x3a, 0x3a];
const AZUL_DA_LETRA = [0x5a, 0xa0, 0xf2];
const CLARO_DOS_OLHOS = [0xf0, 0xf0, 0xf0];
// As medidas do desenho estão numa grade de 256; `G` passa cada uma para a escala de 0 a 1.
const G = 1 / 256;
// Até este tamanho os olhos alargam, para não virarem um borrão, e o fio da borda some.
const TAMANHO_PEQUENO = 24;

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

/** A cor de um ponto do desenho, em coordenadas de 0 a 1: [r, g, b, a], ou `null` se é vazio. */
function corDoPonto(x, y, tamanho) {
  const ateABorda = retanguloArredondado(x, y, 0.5, 0.5, 0.47, 0.47, 0.22);
  if (ateABorda > 0) return null;
  const pequeno = tamanho <= TAMANHO_PEQUENO;
  // Os olhos: duas pílulas em pé dentro do anel, mais largas nos tamanhos pequenos.
  const [meiaLargura, meiaAltura, afastamento] = pequeno ? [9, 16, 15] : [6, 12, 14];
  const noOlho = [114 - afastamento, 114 + afastamento].some(
    (centro) => retanguloArredondado(x, y, centro * G, 128 * G, meiaLargura * G, meiaAltura * G, meiaLargura * G) <= 0,
  );
  if (noOlho) return CLARO_DOS_OLHOS;
  // A letra: o anel, a haste à direita com o canto de cima arredondado, e a ponta de balão embaixo.
  const noAnel = Math.abs(Math.hypot(x - 114 * G, y - 128 * G) - 53 * G) <= 15 * G;
  const naHaste =
    x >= 160 * G && x <= 190 * G && y >= 60 * G && y <= 196 * G && !(x > 175 * G && y < 75 * G && Math.hypot(x - 175 * G, y - 75 * G) > 15 * G);
  const naPonta = dentroDoTriangulo(x, y, [190 * G, 168 * G], [212 * G, 196 * G], [190 * G, 196 * G]);
  if (noAnel || naHaste || naPonta) return AZUL_DA_LETRA;
  // Um fio de dois pontos da grade junto à borda, para o quadrado não sumir sobre um fundo escuro.
  if (!pequeno && ateABorda > -2 * G) return FIO;
  return FUNDO;
}

/** Desenha num quadrado de `tamanho` pixels: RGBA, de cima para baixo, com as bordas suavizadas. */
function desenhar(tamanho) {
  const amostras = tamanho >= 128 ? 4 : 8;
  const pixels = Buffer.alloc(tamanho * tamanho * 4);
  for (let linha = 0; linha < tamanho; linha++) {
    for (let coluna = 0; coluna < tamanho; coluna++) {
      let [r, g, b, cobertos] = [0, 0, 0, 0];
      for (let sy = 0; sy < amostras; sy++) {
        for (let sx = 0; sx < amostras; sx++) {
          const cor = corDoPonto((coluna + (sx + 0.5) / amostras) / tamanho, (linha + (sy + 0.5) / amostras) / tamanho, tamanho);
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

function png(largura, altura, pixels) {
  const pedaco = (tipo, dados) => {
    const corpo = Buffer.concat([Buffer.from(tipo, 'ascii'), dados]);
    const saida = Buffer.alloc(corpo.length + 8);
    saida.writeUInt32BE(dados.length, 0);
    corpo.copy(saida, 4);
    saida.writeUInt32BE(crc32(corpo), corpo.length + 4);
    return saida;
  };
  const cabecalho = Buffer.alloc(13);
  cabecalho.writeUInt32BE(largura, 0);
  cabecalho.writeUInt32BE(altura, 4);
  cabecalho.set([8, 6, 0, 0, 0], 8); // 8 bits por canal, RGBA
  const linhas = Buffer.alloc((largura * 4 + 1) * altura);
  for (let linha = 0; linha < altura; linha++) {
    pixels.copy(linhas, linha * (largura * 4 + 1) + 1, linha * largura * 4, (linha + 1) * largura * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pedaco('IHDR', cabecalho),
    pedaco('IDAT', deflateSync(linhas, { level: 9 })),
    pedaco('IEND', Buffer.alloc(0)),
  ]);
}

/** Uma imagem do .ico no formato clássico: BGRA de baixo para cima, mais a máscara de um bit. */
function bitmapDoIco(tamanho, pixels) {
  const cabecalho = Buffer.alloc(40);
  cabecalho.writeUInt32LE(40, 0);
  cabecalho.writeInt32LE(tamanho, 4);
  cabecalho.writeInt32LE(tamanho * 2, 8); // a altura conta a imagem e a máscara
  cabecalho.writeUInt16LE(1, 12);
  cabecalho.writeUInt16LE(32, 14);
  const cores = Buffer.alloc(tamanho * tamanho * 4);
  for (let linha = 0; linha < tamanho; linha++) {
    for (let coluna = 0; coluna < tamanho; coluna++) {
      const de = ((tamanho - 1 - linha) * tamanho + coluna) * 4;
      const para = (linha * tamanho + coluna) * 4;
      cores[para] = pixels[de + 2];
      cores[para + 1] = pixels[de + 1];
      cores[para + 2] = pixels[de];
      cores[para + 3] = pixels[de + 3];
    }
  }
  // A transparência vem do canal alfa; a máscara fica zerada, com as linhas em múltiplos de 4 bytes.
  const mascara = Buffer.alloc((((tamanho + 31) >> 5) << 2) * tamanho);
  cabecalho.writeUInt32LE(cores.length + mascara.length, 20);
  return Buffer.concat([cabecalho, cores, mascara]);
}

function ico(imagens) {
  const indice = Buffer.alloc(6 + 16 * imagens.length);
  indice.writeUInt16LE(1, 2); // tipo: ícone
  indice.writeUInt16LE(imagens.length, 4);
  let posicao = indice.length;
  imagens.forEach(({ tamanho, dados }, qual) => {
    const entrada = 6 + 16 * qual;
    indice[entrada] = tamanho === 256 ? 0 : tamanho; // 0 quer dizer 256
    indice[entrada + 1] = tamanho === 256 ? 0 : tamanho;
    indice.writeUInt16LE(1, entrada + 4);
    indice.writeUInt16LE(32, entrada + 6);
    indice.writeUInt32LE(dados.length, entrada + 8);
    indice.writeUInt32LE(posicao, entrada + 12);
    posicao += dados.length;
  });
  return Buffer.concat([indice, ...imagens.map((imagem) => imagem.dados)]);
}

/** Uma folha com o ícone em vários tamanhos, sobre fundo claro e escuro, para aprovar o desenho. */
function amostra() {
  const [largura, altura, margem] = [640, 300, 20];
  const folha = Buffer.alloc(largura * altura * 4);
  for (let y = 0; y < altura; y++) {
    for (let x = 0; x < largura; x++) {
      const fundo = y < altura / 2 ? 0xf3 : 0x20;
      folha.set([fundo, fundo, fundo, 255], (y * largura + x) * 4);
    }
  }
  for (const topo of [margem, altura / 2 + margem]) {
    let x = margem;
    for (const tamanho of [128, 64, 48, 32, 24, 16]) {
      const pixels = desenhar(tamanho);
      for (let linha = 0; linha < tamanho; linha++) {
        for (let coluna = 0; coluna < tamanho; coluna++) {
          const de = (linha * tamanho + coluna) * 4;
          const para = ((topo + linha) * largura + x + coluna) * 4;
          const alfa = pixels[de + 3] / 255;
          for (let canal = 0; canal < 3; canal++) {
            folha[para + canal] = Math.round(pixels[de + canal] * alfa + folha[para + canal] * (1 - alfa));
          }
        }
      }
      x += tamanho + margem;
    }
  }
  return png(largura, altura, folha);
}

const pasta = dirname(fileURLToPath(import.meta.url));
// O tamanho de 256 vai comprimido, como o Windows espera; os menores, no formato clássico.
const imagens = TAMANHOS.map((tamanho) => {
  const pixels = desenhar(tamanho);
  return { tamanho, dados: tamanho === 256 ? png(tamanho, tamanho, pixels) : bitmapDoIco(tamanho, pixels) };
});
writeFileSync(join(pasta, 'awikabot.ico'), ico(imagens));
console.log(`awikabot.ico gravado, com ${TAMANHOS.length} tamanhos`);
if (process.argv[2]) {
  writeFileSync(process.argv[2], amostra());
  console.log(`amostra gravada em ${process.argv[2]}`);
}
