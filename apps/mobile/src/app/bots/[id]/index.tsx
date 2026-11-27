import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useState } from 'react';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LIMITES, type Mensagem } from '@awikabot/core';

import { Aviso } from '@/components/Aviso';
import { Botao } from '@/components/Botao';
import { BotaoCabecalho } from '@/components/BotaoCabecalho';
import { CartaoAprovacao, DesfechoAprovacao } from '@/components/CartaoAprovacao';
import { useConversa } from '@/hooks/use-conversa';
import { useTecladoAberto } from '@/hooks/use-teclado-aberto';
import { chaveDoItem, ehAprovacao } from '@/lib/aprovacoes';
import { rotuloDoEstado } from '@/lib/conversa';
import { cores, espaco } from '@/tema';

function Balao({ mensagem }: { mensagem: Mensagem }) {
  const daPessoa = mensagem.papel === 'usuario';
  const respondendo = mensagem.estado === 'em_andamento';
  const rotulo = rotuloDoEstado(mensagem.estado);
  const temTexto = mensagem.texto !== '';
  return (
    <View style={[estilos.linha, daPessoa ? estilos.linhaDaPessoa : estilos.linhaDoBot]}>
      {temTexto || respondendo ? (
        <View
          accessible
          accessibilityLabel={`${daPessoa ? 'Você' : 'Bot'}: ${temTexto ? mensagem.texto : 'respondendo'}`}
          style={[estilos.balao, daPessoa ? estilos.balaoDaPessoa : estilos.balaoDoBot]}>
          {temTexto ? (
            <Text selectable style={[estilos.texto, daPessoa && estilos.textoDaPessoa]}>
              {mensagem.texto}
            </Text>
          ) : (
            <Text style={estilos.respondendo}>respondendo…</Text>
          )}
        </View>
      ) : null}
      {rotulo !== null ? (
        <Text style={[estilos.rotuloDoEstado, mensagem.estado === 'falhou' && estilos.rotuloDeFalha]}>{rotulo}</Text>
      ) : null}
    </View>
  );
}

export default function Conversa() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const alturaDoCabecalho = useHeaderHeight();
  const margens = useSafeAreaInsets();
  const tecladoAberto = useTecladoAberto();
  const conversa = useConversa(id);
  const [texto, definirTexto] = useState('');

  async function enviar(): Promise<void> {
    const aceito = await conversa.enviar(texto);
    // O texto só sai da caixa quando o servidor aceita: se falhar, a pessoa não digita de novo.
    if (aceito) definirTexto('');
  }

  return (
    <KeyboardAvoidingView style={estilos.tela} behavior="padding" keyboardVerticalOffset={alturaDoCabecalho}>
      <Stack.Screen
        options={{
          title: conversa.bot?.nome ?? 'Conversa',
          headerRight: () => (
            <BotaoCabecalho
              rotulo="Editar"
              dica="Abre os dados do bot"
              aoTocar={() => router.push({ pathname: '/bots/[id]/editar', params: { id } })}
            />
          ),
        }}
      />
      {conversa.semEventos || conversa.erro !== null || conversa.aviso !== null || conversa.aprovacoesSemConferir ? (
        <View style={estilos.avisos}>
          {conversa.semEventos ? <Aviso tipo="informacao" texto="Sem conexão com o servidor. Tentando de novo…" /> : null}
          {conversa.aviso !== null ? <Aviso tipo="informacao" texto={conversa.aviso} /> : null}
          {conversa.erro !== null ? <Aviso texto={conversa.erro} /> : null}
          {conversa.falhaDeCarga ? <Botao rotulo="Tentar de novo" variante="secundaria" aoTocar={conversa.tentarDeNovo} /> : null}
          {conversa.aprovacoesSemConferir ? (
            <>
              <Aviso texto="Não foi possível buscar os pedidos de aprovação. Pode haver um pedido esperando por você." />
              <Botao rotulo="Buscar pedidos de novo" variante="secundaria" aoTocar={conversa.conferirAprovacoes} />
            </>
          ) : null}
        </View>
      ) : null}
      {conversa.itens.length === 0 ? (
        <View style={estilos.vazio}>
          {conversa.carregando && conversa.erro === null ? (
            <ActivityIndicator accessibilityLabel="Carregando a conversa" color={cores.primaria} />
          ) : (
            <Text style={estilos.vazioTexto}>
              {conversa.carregando ? 'A conversa não foi carregada.' : 'Nenhuma mensagem ainda. Escreva a primeira abaixo.'}
            </Text>
          )}
        </View>
      ) : (
        <FlatList
          inverted
          data={conversa.itens}
          keyExtractor={chaveDoItem}
          renderItem={({ item }) => {
            if (!ehAprovacao(item)) return <Balao mensagem={item} />;
            if (item.estado !== 'pendente') return <DesfechoAprovacao aprovacao={item} />;
            return (
              <CartaoAprovacao
                aprovacao={item}
                enviando={conversa.decidindo?.id === item.id ? conversa.decidindo.decisao : null}
                bloqueado={conversa.decidindo !== null}
                aoDecidir={(decisao) => conversa.decidir(item.id, decisao)}
              />
            );
          }}
          contentContainerStyle={estilos.lista}
          keyboardShouldPersistTaps="handled"
          // Lista invertida: o "fim" é o topo da tela, onde entram as mensagens mais antigas.
          onEndReached={conversa.carregarAnteriores}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            conversa.carregandoAnteriores ? (
              <ActivityIndicator accessibilityLabel="Carregando mensagens anteriores" color={cores.primaria} style={estilos.anteriores} />
            ) : undefined
          }
        />
      )}
      <View style={[estilos.compositor, { paddingBottom: tecladoAberto ? espaco.p : Math.max(margens.bottom, espaco.p) }]}>
        <TextInput
          accessibilityLabel="Mensagem"
          placeholder="Mensagem"
          placeholderTextColor={cores.textoSuave}
          value={texto}
          onChangeText={definirTexto}
          multiline
          maxLength={LIMITES.texto}
          editable={!conversa.enviando}
          style={estilos.entrada}
        />
        {conversa.turnoAtivo ? (
          <Botao
            rotulo="Parar"
            dica="Interrompe a resposta do bot"
            variante="perigo"
            aoTocar={conversa.parar}
            ocupado={conversa.parando}
            style={estilos.acao}
          />
        ) : (
          <Botao
            rotulo="Enviar"
            aoTocar={() => void enviar()}
            ocupado={conversa.enviando}
            desativado={texto.trim() === ''}
            style={estilos.acao}
          />
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const estilos = StyleSheet.create({
  tela: {
    flex: 1,
    backgroundColor: cores.fundo,
  },
  avisos: {
    paddingHorizontal: espaco.m,
    paddingTop: espaco.p,
    gap: espaco.p,
  },
  vazio: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: espaco.gg,
  },
  vazioTexto: {
    fontSize: 15,
    textAlign: 'center',
    color: cores.textoSuave,
  },
  lista: {
    paddingHorizontal: espaco.m,
    paddingVertical: espaco.p,
  },
  anteriores: {
    paddingVertical: espaco.m,
  },
  linha: {
    marginVertical: 4,
    gap: 2,
  },
  linhaDaPessoa: {
    alignItems: 'flex-end',
  },
  linhaDoBot: {
    alignItems: 'flex-start',
  },
  balao: {
    maxWidth: '85%',
    paddingHorizontal: espaco.m,
    paddingVertical: espaco.p,
    borderRadius: 16,
  },
  balaoDaPessoa: {
    backgroundColor: cores.primaria,
    borderBottomRightRadius: 4,
  },
  balaoDoBot: {
    backgroundColor: cores.fundoSuave,
    borderBottomLeftRadius: 4,
  },
  texto: {
    fontSize: 16,
    lineHeight: 22,
    color: cores.texto,
  },
  textoDaPessoa: {
    color: cores.sobrePrimaria,
  },
  respondendo: {
    fontSize: 15,
    fontStyle: 'italic',
    color: cores.textoSuave,
  },
  rotuloDoEstado: {
    paddingHorizontal: 4,
    fontSize: 12,
    color: cores.textoSuave,
  },
  rotuloDeFalha: {
    color: cores.perigo,
  },
  compositor: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: espaco.p,
    paddingHorizontal: espaco.m,
    paddingTop: espaco.p,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: cores.borda,
    backgroundColor: cores.fundo,
  },
  entrada: {
    flex: 1,
    minHeight: 48,
    maxHeight: 140,
    paddingHorizontal: espaco.m,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: cores.borda,
    borderRadius: 10,
    fontSize: 16,
    color: cores.texto,
  },
  acao: {
    minWidth: 88,
  },
});
