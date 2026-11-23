import { ActivityIndicator, Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';

import { cores, espaco } from '@/tema';

interface Props {
  rotulo: string;
  aoTocar: () => void;
  /** `perigo` para a ação que interrompe ou desfaz algo. */
  variante?: 'primaria' | 'secundaria' | 'perigo';
  desativado?: boolean;
  /** Mostra o indicador de espera e bloqueia novos toques. */
  ocupado?: boolean;
  /** Descrição para leitor de tela, quando o rótulo sozinho não basta. */
  dica?: string;
  style?: StyleProp<ViewStyle>;
}

export function Botao({ rotulo, aoTocar, variante = 'primaria', desativado = false, ocupado = false, dica, style }: Props) {
  const parado = desativado || ocupado;
  const cheio = variante !== 'secundaria';
  const corDeFundo = variante === 'perigo' ? cores.perigo : variante === 'primaria' ? cores.primaria : cores.fundo;
  const corDoTexto = cheio ? cores.sobrePrimaria : cores.primaria;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={rotulo}
      accessibilityHint={dica}
      accessibilityState={{ disabled: parado, busy: ocupado }}
      disabled={parado}
      onPress={aoTocar}
      style={({ pressed }) => [
        estilos.botao,
        { backgroundColor: corDeFundo },
        !cheio && estilos.contorno,
        pressed && estilos.pressionado,
        parado && estilos.parado,
        style,
      ]}>
      {ocupado ? <ActivityIndicator color={corDoTexto} /> : <Text style={[estilos.rotulo, { color: corDoTexto }]}>{rotulo}</Text>}
    </Pressable>
  );
}

const estilos = StyleSheet.create({
  botao: {
    minHeight: 48,
    paddingHorizontal: espaco.g,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  contorno: {
    borderWidth: 1,
    borderColor: cores.primaria,
  },
  pressionado: {
    opacity: 0.8,
  },
  parado: {
    opacity: 0.5,
  },
  rotulo: {
    fontSize: 16,
    fontWeight: '600',
  },
});
