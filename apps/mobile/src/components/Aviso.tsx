import { StyleSheet, Text, View } from 'react-native';

import { cores, espaco } from '@/tema';

interface Props {
  texto: string;
  /** `erro` é anunciado pelo leitor de tela assim que aparece. */
  tipo?: 'erro' | 'informacao';
}

/** Faixa de mensagem dentro da tela: erro de uma ação ou um aviso de estado. */
export function Aviso({ texto, tipo = 'erro' }: Props) {
  const erro = tipo === 'erro';
  return (
    <View
      accessible
      accessibilityRole={erro ? 'alert' : 'text'}
      accessibilityLiveRegion={erro ? 'assertive' : 'polite'}
      style={[estilos.faixa, erro ? estilos.faixaErro : estilos.faixaInformacao]}>
      <Text style={[estilos.texto, erro && estilos.textoErro]}>{texto}</Text>
    </View>
  );
}

const estilos = StyleSheet.create({
  faixa: {
    paddingHorizontal: espaco.m,
    paddingVertical: 10,
    borderRadius: 10,
  },
  faixaErro: {
    backgroundColor: cores.fundoPerigo,
  },
  faixaInformacao: {
    backgroundColor: cores.fundoSuave,
  },
  texto: {
    fontSize: 14,
    color: cores.textoSuave,
  },
  textoErro: {
    color: cores.perigo,
  },
});
