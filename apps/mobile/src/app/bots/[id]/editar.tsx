import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import type { Bot } from '@awikabot/core';

import { Aviso } from '@/components/Aviso';
import { Botao } from '@/components/Botao';
import { FormularioBot } from '@/components/FormularioBot';
import { useBot } from '@/hooks/use-lista-bots';
import { mensagemDoCodigo } from '@/lib/erros';
import { camposDoBot, edicaoDoBot } from '@/lib/formulario-bot';
import { useDados, useSelecao } from '@/provedores/dados';
import { cores, espaco } from '@/tema';

function Edicao({ bot, aoTerminar }: { bot: Bot; aoTerminar: () => void }) {
  const { operacoes } = useDados();
  // O bot como estava ao abrir: só vai no PATCH o que a pessoa mudou aqui, e uma edição
  // feita em outro aparelho enquanto o formulário está aberto não é desfeita sem querer.
  const [original] = useState(bot);

  return (
    <FormularioBot
      inicial={camposDoBot(original)}
      aoSalvar={async (entrada) => {
        const edicao = edicaoDoBot(original, entrada);
        if (edicao !== null) await operacoes.editarBot(original.id, edicao);
        aoTerminar();
      }}
    />
  );
}

export default function EditarBot() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const bot = useBot(id);
  const listaCarregada = useSelecao((estado) => estado.bots !== null);

  const voltar = (): void => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  if (bot !== null) return <Edicao key={bot.id} bot={bot} aoTerminar={voltar} />;

  return (
    <View style={estilos.tela}>
      {listaCarregada ? (
        <>
          <Aviso texto={mensagemDoCodigo('nao_encontrado')} />
          <Botao rotulo="Voltar" variante="secundaria" aoTocar={voltar} />
        </>
      ) : (
        <ActivityIndicator accessibilityLabel="Carregando o bot" color={cores.primaria} />
      )}
    </View>
  );
}

const estilos = StyleSheet.create({
  tela: {
    flex: 1,
    padding: espaco.g,
    gap: espaco.g,
    justifyContent: 'center',
    backgroundColor: cores.fundo,
  },
});
