import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { useSessao } from '@/hooks/use-sessao';
import { ProvedorDados } from '@/provedores/dados';
import { guardaSessao } from '@/servicos';
import { cores } from '@/tema';

export default function LayoutRaiz() {
  const { fase, sessao } = useSessao();

  useEffect(() => {
    void guardaSessao.carregar();
  }, []);

  // Até o cofre responder não dá para saber se a primeira tela é a lista de bots ou o pareamento.
  if (fase === 'carregando') {
    return (
      <View style={estilos.espera}>
        <ActivityIndicator accessibilityLabel="Abrindo o awikabot" color={cores.primaria} />
      </View>
    );
  }

  const pareado = sessao !== null;
  return (
    <ProvedorDados sessao={sessao}>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerTintColor: cores.primaria,
          headerTitleStyle: { color: cores.texto },
          headerBackButtonDisplayMode: 'minimal',
          contentStyle: { backgroundColor: cores.fundo },
        }}>
        {/* Sem sessão, toda tela de bots leva ao pareamento; com sessão, o pareamento leva à lista. */}
        <Stack.Protected guard={pareado} redirectTo="/parear">
          <Stack.Screen name="index" options={{ title: 'Bots' }} />
          <Stack.Screen name="bots/novo" options={{ title: 'Novo bot' }} />
          <Stack.Screen name="bots/[id]/index" options={{ title: 'Conversa' }} />
          <Stack.Screen name="bots/[id]/editar" options={{ title: 'Editar bot' }} />
        </Stack.Protected>
        <Stack.Protected guard={!pareado} redirectTo="/">
          <Stack.Screen name="parear" options={{ title: 'Parear' }} />
        </Stack.Protected>
      </Stack>
    </ProvedorDados>
  );
}

const estilos = StyleSheet.create({
  espera: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: cores.fundo,
  },
});
