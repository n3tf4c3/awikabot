import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Bot } from '@awikabot/core';

import { Aviso } from '@/components/Aviso';
import { Botao } from '@/components/Botao';
import { BotaoCabecalho } from '@/components/BotaoCabecalho';
import { useListaBots } from '@/hooks/use-lista-bots';
import { useSessao } from '@/hooks/use-sessao';
import { rotuloDaSituacao, situacaoDoBot, type SituacaoDoBot } from '@/lib/aprovacoes';
import { desparearAparelho } from '@/lib/pareamento';
import { api, guardaSessao } from '@/servicos';
import { cores, espaco } from '@/tema';

function confirmarDespareamento(servidor: string, aoConfirmar: () => void): void {
  Alert.alert(
    'Desparear este aparelho?',
    `O app vai esquecer o servidor ${servidor} e o acesso guardado aqui, e pedir ao servidor que deixe de aceitá-lo. Para voltar, será preciso um novo código de pareamento.`,
    [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Desparear', style: 'destructive', onPress: aoConfirmar },
    ],
  );
}

function LinhaBot({ bot, situacao, aoAbrir }: { bot: Bot; situacao: SituacaoDoBot | null; aoAbrir: (id: string) => void }) {
  const rotulo = situacao === null ? null : rotuloDaSituacao(situacao);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Conversar com ${bot.nome}${rotulo === null ? '' : `, ${rotulo}`}`}
      onPress={() => aoAbrir(bot.id)}
      style={({ pressed }) => [estilos.linha, pressed && estilos.linhaPressionada]}>
      <Text style={estilos.nome} numberOfLines={1}>
        {bot.nome}
      </Text>
      {bot.modelo !== null ? (
        <Text style={estilos.detalhe} numberOfLines={1}>
          {bot.modelo}
        </Text>
      ) : null}
      {rotulo !== null ? (
        <Text style={[estilos.detalhe, situacao === 'aguardando_aprovacao' ? estilos.aguardando : estilos.respondendo]}>{rotulo}</Text>
      ) : null}
    </Pressable>
  );
}

function Separador() {
  return <View style={estilos.separador} />;
}

export default function ListaDeBots() {
  const router = useRouter();
  const margens = useSafeAreaInsets();
  const { sessao } = useSessao();
  const { bots, aprovacoes, erro, atualizando, atualizar } = useListaBots();
  const [despareando, definirDespareando] = useState(false);

  const abrir = (id: string): void => router.push({ pathname: '/bots/[id]', params: { id } });
  const servidor = sessao?.servidor ?? '';

  function desparear(): void {
    definirDespareando(true);
    // O servidor é avisado primeiro, por poucos segundos. Com ou sem resposta, a sessão sai do
    // aparelho e o layout raiz leva à tela de pareamento.
    desparearAparelho(api, guardaSessao)
      .catch(() => {
        Alert.alert('Não foi possível apagar o acesso guardado', 'Feche o app, abra de novo e repita o despareamento.');
      })
      .finally(() => definirDespareando(false));
  }

  return (
    <View style={estilos.tela}>
      <Stack.Screen
        options={{
          headerRight: () =>
            despareando ? (
              <ActivityIndicator accessibilityLabel="Despareando" color={cores.primaria} />
            ) : (
              <BotaoCabecalho
                rotulo="Desparear"
                dica="Esquece o servidor neste aparelho e revoga o acesso dele"
                aoTocar={() => confirmarDespareamento(servidor, desparear)}
              />
            ),
        }}
      />
      {erro !== null ? (
        <View style={estilos.aviso}>
          <Aviso texto={erro} />
        </View>
      ) : null}
      {bots === null && erro === null ? (
        <View style={estilos.centro}>
          <ActivityIndicator accessibilityLabel="Carregando os bots" color={cores.primaria} />
        </View>
      ) : (
        <FlatList
          data={bots ?? []}
          keyExtractor={(bot) => bot.id}
          renderItem={({ item }) => <LinhaBot bot={item} situacao={situacaoDoBot(item, aprovacoes)} aoAbrir={abrir} />}
          ItemSeparatorComponent={Separador}
          refreshControl={<RefreshControl refreshing={atualizando} onRefresh={atualizar} tintColor={cores.primaria} />}
          contentContainerStyle={estilos.lista}
          ListEmptyComponent={
            <View style={estilos.vazio}>
              <Text style={estilos.vazioTitulo}>{bots === null ? 'Não deu para carregar os bots' : 'Nenhum bot ainda'}</Text>
              <Text style={estilos.vazioTexto}>
                {bots === null ? 'Puxe a lista para baixo para tentar de novo.' : 'Toque em "Novo bot" para criar o primeiro.'}
              </Text>
            </View>
          }
        />
      )}
      <View style={[estilos.rodape, { paddingBottom: Math.max(margens.bottom, espaco.g) }]}>
        <Botao rotulo="Novo bot" aoTocar={() => router.push('/bots/novo')} desativado={despareando} />
      </View>
    </View>
  );
}

const estilos = StyleSheet.create({
  tela: {
    flex: 1,
    backgroundColor: cores.fundo,
  },
  aviso: {
    paddingHorizontal: espaco.g,
    paddingTop: espaco.m,
  },
  centro: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lista: {
    flexGrow: 1,
    paddingVertical: espaco.p,
  },
  linha: {
    minHeight: 60,
    paddingHorizontal: espaco.g,
    paddingVertical: espaco.m,
    justifyContent: 'center',
    gap: 2,
  },
  linhaPressionada: {
    backgroundColor: cores.fundoSuave,
  },
  nome: {
    fontSize: 17,
    fontWeight: '600',
    color: cores.texto,
  },
  detalhe: {
    fontSize: 14,
    color: cores.textoSuave,
  },
  respondendo: {
    color: cores.primaria,
  },
  aguardando: {
    fontWeight: '700',
    color: cores.perigo,
  },
  separador: {
    height: StyleSheet.hairlineWidth,
    marginLeft: espaco.g,
    backgroundColor: cores.borda,
  },
  vazio: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: espaco.p,
    padding: espaco.gg,
  },
  vazioTitulo: {
    fontSize: 17,
    fontWeight: '600',
    color: cores.texto,
  },
  vazioTexto: {
    fontSize: 15,
    textAlign: 'center',
    color: cores.textoSuave,
  },
  rodape: {
    paddingHorizontal: espaco.g,
    paddingTop: espaco.m,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: cores.borda,
    backgroundColor: cores.fundo,
  },
});
