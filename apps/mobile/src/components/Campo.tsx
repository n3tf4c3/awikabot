import { StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';

import { cores, espaco } from '@/tema';

interface Props extends Omit<TextInputProps, 'value' | 'onChangeText' | 'style'> {
  rotulo: string;
  valor: string;
  aoMudar: (valor: string) => void;
  /** Frase de erro do campo; `undefined` quando está tudo certo. */
  erro?: string;
  /** Texto de ajuda abaixo do campo. */
  ajuda?: string;
  /** Mostra "usados/limite" ao lado da ajuda. Exige `maxLength`. */
  comContador?: boolean;
}

/** Rótulo, caixa de texto e a linha de ajuda ou de erro. */
export function Campo({ rotulo, valor, aoMudar, erro, ajuda, comContador = false, multiline, maxLength, ...resto }: Props) {
  return (
    <View style={estilos.campo}>
      <Text style={estilos.rotulo}>{rotulo}</Text>
      <TextInput
        accessibilityLabel={rotulo}
        accessibilityHint={erro ?? ajuda}
        value={valor}
        onChangeText={aoMudar}
        multiline={multiline}
        maxLength={maxLength}
        placeholderTextColor={cores.textoSuave}
        textAlignVertical={multiline ? 'top' : 'center'}
        style={[estilos.caixa, multiline && estilos.caixaAlta, erro !== undefined && estilos.caixaComErro]}
        {...resto}
      />
      <View style={estilos.rodape}>
        {erro !== undefined ? (
          <Text accessibilityRole="alert" style={[estilos.detalhe, estilos.erro]}>
            {erro}
          </Text>
        ) : (
          <Text style={estilos.detalhe}>{ajuda ?? ''}</Text>
        )}
        {comContador && maxLength !== undefined ? (
          <Text style={estilos.contador}>
            {valor.length}/{maxLength}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const estilos = StyleSheet.create({
  campo: {
    gap: 6,
  },
  rotulo: {
    fontSize: 15,
    fontWeight: '600',
    color: cores.texto,
  },
  caixa: {
    minHeight: 48,
    paddingHorizontal: espaco.m,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: cores.borda,
    borderRadius: 10,
    fontSize: 16,
    color: cores.texto,
    backgroundColor: cores.fundo,
  },
  caixaAlta: {
    minHeight: 140,
    maxHeight: 280,
  },
  caixaComErro: {
    borderColor: cores.perigo,
  },
  rodape: {
    flexDirection: 'row',
    gap: espaco.p,
  },
  detalhe: {
    flex: 1,
    fontSize: 13,
    color: cores.textoSuave,
  },
  erro: {
    color: cores.perigo,
  },
  contador: {
    fontSize: 13,
    color: cores.textoSuave,
  },
});
