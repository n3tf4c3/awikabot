import { Pressable, StyleSheet, Text } from 'react-native';

import { cores } from '@/tema';

interface Props {
  rotulo: string;
  aoTocar: () => void;
  dica?: string;
}

/** Ação de texto para o cabeçalho da tela. */
export function BotaoCabecalho({ rotulo, aoTocar, dica }: Props) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={rotulo}
      accessibilityHint={dica}
      hitSlop={12}
      onPress={aoTocar}
      style={({ pressed }) => [estilos.botao, pressed && estilos.pressionado]}>
      <Text style={estilos.rotulo}>{rotulo}</Text>
    </Pressable>
  );
}

const estilos = StyleSheet.create({
  botao: {
    minHeight: 36,
    paddingHorizontal: 6,
    justifyContent: 'center',
  },
  pressionado: {
    opacity: 0.6,
  },
  rotulo: {
    fontSize: 16,
    color: cores.primaria,
  },
});
