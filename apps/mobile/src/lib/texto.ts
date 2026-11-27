/**
 * Quantos caracteres o contrato conta num texto. O esquema do `core` conta pontos de código: um
 * emoji é um caractere, mesmo ocupando duas unidades no texto do JavaScript, que é o que `length`
 * mede. O contador da tela usa esta conta, para dizer o mesmo que a validação.
 */
export function contarCaracteres(texto: string): number {
  return Array.from(texto).length;
}

/**
 * O teto do campo nativo, que conta unidades e não caracteres. Cada caractere ocupa no máximo duas
 * unidades, então o dobro do limite nunca barra um texto que o contrato aceita. Quem diz que o
 * texto passou do limite é a validação do formulário, na medida certa; o teto só impede o exagero.
 */
export function tetoDoCampoNativo(limite: number): number {
  return limite * 2;
}
