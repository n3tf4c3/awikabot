import { StyleSheet, Text, View } from 'react-native';

import { rotuloProtocolo } from '@/lib/rotulo-protocolo';

export default function Inicio() {
  return (
    <View style={estilos.tela}>
      <Text style={estilos.titulo}>awikabot</Text>
      <Text style={estilos.detalhe}>{rotuloProtocolo()}</Text>
    </View>
  );
}

const estilos = StyleSheet.create({
  tela: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#FFFFFF',
  },
  titulo: {
    fontSize: 28,
    fontWeight: '600',
    color: '#111111',
  },
  detalhe: {
    fontSize: 16,
    color: '#555555',
  },
});
