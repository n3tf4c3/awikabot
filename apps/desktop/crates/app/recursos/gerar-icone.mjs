// Gera o ícone do app de desktop, o `awikabot.ico` versionado ao lado deste script. O desenho
// está em `scripts/icone.mjs`, que o gerador do app de celular também usa.
//
//   node apps/desktop/crates/app/recursos/gerar-icone.mjs            regrava awikabot.ico
//   node apps/desktop/crates/app/recursos/gerar-icone.mjs amostra.png  grava também uma amostra
//
// Sem dependência: só o que o Node traz. Mudou o desenho, rode de novo e versione o .ico.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { desenhar, png } from '../../../../../scripts/icone.mjs';

const TAMANHOS = [16, 20, 24, 32, 40, 48, 64, 128, 256];

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
