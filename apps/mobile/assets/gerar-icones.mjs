// Gera os arquivos de ícone e de abertura do app de celular, versionados em `assets/images`. O
// desenho está em `scripts/icone.mjs`, que o gerador do app de desktop também usa.
//
//   node apps/mobile/assets/gerar-icones.mjs            regrava os quatro PNG
//   node apps/mobile/assets/gerar-icones.mjs amostra.png  grava também uma amostra
//
// Sem dependência: só o que o Node traz. Mudou o desenho, rode de novo e versione os PNG. Os
// nomes dos arquivos e a cor de fundo do ícone do Android estão no `app.json`.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FUNDO, desenhar, png } from '../../../scripts/icone.mjs';

const LADO = 1024;
// No iOS o fundo vai até a borda e o sistema recorta os cantos: a letra cresce o mesmo tanto que
// o quadrado cresceu para chegar à borda.
const ESCALA_NO_IOS = 1 / 0.94;
// No Android o aparelho mostra só os dois terços do meio de cada camada, recortados do jeito
// dele. A letra encolhe para caber no círculo seguro, que tem 66 dos 108 pontos da camada.
const ESCALA_NO_ANDROID = 0.72;
const BRANCO = [0xff, 0xff, 0xff];

const arquivos = [
  // iOS e o ícone geral: sem transparência, que é como a loja da Apple pede.
  { nome: 'icon.png', lado: LADO, opcoes: { quadro: 'cheio', escala: ESCALA_NO_IOS }, semTransparencia: true },
  // Android, camada da frente: só a letra. O fundo é a cor `adaptiveIcon.backgroundColor` do `app.json`.
  { nome: 'android-icon-foreground.png', lado: LADO, opcoes: { quadro: 'nenhum', escala: ESCALA_NO_ANDROID } },
  // Android, ícone temático: o sistema usa só o contorno e pinta com as cores do aparelho.
  { nome: 'android-icon-monochrome.png', lado: LADO, opcoes: { quadro: 'nenhum', escala: ESCALA_NO_ANDROID, umaCor: BRANCO } },
  // Abertura: o ícone como no desktop, com os cantos vazios, mostrado com 96 pontos de largura.
  { nome: 'splash-icon.png', lado: 512, opcoes: {} },
];

/** Cola uma imagem RGBA numa folha, reduzida por média, sobre o que já estiver lá. */
function colar(folha, larguraDaFolha, pixels, lado, x0, y0, ladoNaFolha) {
  const passo = lado / ladoNaFolha;
  for (let y = 0; y < ladoNaFolha; y++) {
    for (let x = 0; x < ladoNaFolha; x++) {
      let [r, g, b, a] = [0, 0, 0, 0];
      for (let sy = 0; sy < passo; sy++) {
        for (let sx = 0; sx < passo; sx++) {
          const de = ((y * passo + sy) * lado + x * passo + sx) * 4;
          const alfa = pixels[de + 3];
          r += pixels[de] * alfa;
          g += pixels[de + 1] * alfa;
          b += pixels[de + 2] * alfa;
          a += alfa;
        }
      }
      const para = ((y0 + y) * larguraDaFolha + x0 + x) * 4;
      const cobertura = a / (255 * passo * passo);
      for (const [canal, soma] of [r, g, b].entries()) {
        const cor = a > 0 ? soma / a : 0;
        folha[para + canal] = Math.round(cor * cobertura + folha[para + canal] * (1 - cobertura));
      }
    }
  }
}

/**
 * Uma folha para conferir o resultado: o arquivo do iOS inteiro e com os cantos que o sistema
 * recorta, o do Android num círculo, e o temático com cores de exemplo.
 */
function amostra(desenhos) {
  const CINZA = [0xf3, 0xf3, 0xf3];
  const [margem, quadro] = [32, 256];
  const [largura, altura] = [margem + 4 * (quadro + margem), quadro + 2 * margem];
  const folha = Buffer.alloc(largura * altura * 4);
  for (let ponto = 0; ponto < largura * altura; ponto++) folha.set([...CINZA, 255], ponto * 4);
  /** Pinta de uma cor os pontos de um quadro que a regra escolher, em coordenadas de 0 a 1. */
  const pintar = (x0, y0, lado, cor, escolhe) => {
    for (let y = 0; y < lado; y++) {
      for (let x = 0; x < lado; x++) {
        if (escolhe((x + 0.5) / lado, (y + 0.5) / lado)) folha.set([...cor, 255], ((y0 + y) * largura + x0 + x) * 4);
      }
    }
  };
  const foraDoCirculo = (x, y) => Math.hypot(x - 0.5, y - 0.5) > 0.5;
  const foraDosCantos = (raio) => (x, y) => {
    const [dx, dy] = [Math.abs(x - 0.5) - (0.5 - raio), Math.abs(y - 0.5) - (0.5 - raio)];
    return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) > raio;
  };
  // O miolo de uma camada do Android: 680 dos 1024 pontos, perto dos dois terços que o aparelho mostra.
  const MIOLO = 680;
  const miolo = (pixels) => {
    const de = (LADO - MIOLO) / 2;
    const corte = Buffer.alloc(MIOLO * MIOLO * 4);
    for (let y = 0; y < MIOLO; y++) pixels.copy(corte, y * MIOLO * 4, ((de + y) * LADO + de) * 4, ((de + y) * LADO + de + MIOLO) * 4);
    return corte;
  };
  const noAndroid = MIOLO / 4;
  const recuo = (quadro - noAndroid) / 2;
  let x = margem;
  // iOS: o arquivo, e com os cantos que o sistema recorta.
  colar(folha, largura, desenhos['icon.png'], LADO, x, margem, quadro);
  x += quadro + margem;
  colar(folha, largura, desenhos['icon.png'], LADO, x, margem, quadro);
  pintar(x, margem, quadro, CINZA, foraDosCantos(0.225));
  x += quadro + margem;
  // Android: a cor de fundo mais a camada da frente, num círculo.
  pintar(x + recuo, margem + recuo, noAndroid, FUNDO, () => true);
  colar(folha, largura, miolo(desenhos['android-icon-foreground.png']), MIOLO, x + recuo, margem + recuo, noAndroid);
  pintar(x + recuo, margem + recuo, noAndroid, CINZA, foraDoCirculo);
  x += quadro + margem;
  // Android temático: a camada de uma cor, pintada com cores de exemplo.
  const umaCor = miolo(desenhos['android-icon-monochrome.png']);
  for (let ponto = 0; ponto < umaCor.length; ponto += 4) umaCor.set([0x1d, 0x3a, 0x6b], ponto);
  pintar(x + recuo, margem + recuo, noAndroid, [0xdb, 0xe4, 0xf3], () => true);
  colar(folha, largura, umaCor, MIOLO, x + recuo, margem + recuo, noAndroid);
  pintar(x + recuo, margem + recuo, noAndroid, CINZA, foraDoCirculo);
  return png(largura, altura, folha);
}

const pasta = join(dirname(fileURLToPath(import.meta.url)), 'images');
const desenhos = {};
for (const { nome, lado, opcoes, semTransparencia = false } of arquivos) {
  desenhos[nome] = desenhar(lado, opcoes);
  writeFileSync(join(pasta, nome), png(lado, lado, desenhos[nome], { semTransparencia }));
  console.log(`${nome} gravado, com ${lado} por ${lado}`);
}
if (process.argv[2]) {
  writeFileSync(process.argv[2], amostra(desenhos));
  console.log(`amostra gravada em ${process.argv[2]}`);
}
