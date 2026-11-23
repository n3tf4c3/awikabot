import { useHeaderHeight } from 'expo-router/react-navigation';
import { useState } from 'react';
import { KeyboardAvoidingView, ScrollView, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LIMITES } from '@awikabot/core';

import { Aviso } from '@/components/Aviso';
import { Botao } from '@/components/Botao';
import { Campo } from '@/components/Campo';
import { useSessao } from '@/hooks/use-sessao';
import { mensagemDoCodigo } from '@/lib/erros';
import { NOME_PADRAO_DO_APARELHO, parearAparelho, type ErrosPareamento } from '@/lib/pareamento';
import { rotuloProtocolo } from '@/lib/rotulo-protocolo';
import { api, guardaSessao } from '@/servicos';
import { cores, espaco } from '@/tema';

export default function Parear() {
  const alturaDoCabecalho = useHeaderHeight();
  const margens = useSafeAreaInsets();
  const { desconectado } = useSessao();
  const [endereco, definirEndereco] = useState('');
  const [codigo, definirCodigo] = useState('');
  const [nome, definirNome] = useState(NOME_PADRAO_DO_APARELHO);
  const [erros, definirErros] = useState<ErrosPareamento>({});
  const [falha, definirFalha] = useState<string | null>(null);
  const [pareando, definirPareando] = useState(false);

  async function parear(): Promise<void> {
    definirPareando(true);
    try {
      // Dando certo, a sessão fica guardada: o layout raiz libera a lista de bots e tira esta tela da pilha.
      const resultado = await parearAparelho(api, guardaSessao, { endereco, codigo, nome });
      definirErros(resultado.ok ? {} : resultado.erros);
      definirFalha(resultado.ok ? null : resultado.falha);
    } finally {
      definirPareando(false);
    }
  }

  return (
    <KeyboardAvoidingView style={estilos.tela} behavior="padding" keyboardVerticalOffset={alturaDoCabecalho}>
      <ScrollView
        contentContainerStyle={[estilos.conteudo, { paddingBottom: espaco.g + margens.bottom }]}
        keyboardShouldPersistTaps="handled">
        <Text style={estilos.introducao}>
          Informe o endereço do seu servidor awikabot e o código de pareamento que ele mostra.
        </Text>
        {desconectado && falha === null ? <Aviso texto={mensagemDoCodigo('nao_autenticado')} /> : null}
        {falha !== null ? <Aviso texto={falha} /> : null}
        <Campo
          rotulo="Endereço do servidor"
          valor={endereco}
          aoMudar={definirEndereco}
          erro={erros.endereco}
          ajuda="Com https://. Na rede local também vale http://."
          placeholder="https://bots.exemplo.com"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          textContentType="URL"
          maxLength={2048}
          editable={!pareando}
        />
        <Campo
          rotulo="Código de pareamento"
          valor={codigo}
          aoMudar={definirCodigo}
          erro={erros.codigo}
          ajuda="12 caracteres. Espaços e hifens são ignorados."
          autoCapitalize="characters"
          autoCorrect={false}
          autoComplete="off"
          maxLength={40}
          editable={!pareando}
        />
        <Campo
          rotulo="Nome deste aparelho"
          valor={nome}
          aoMudar={definirNome}
          erro={erros.nome}
          ajuda="É como o servidor vai chamar este celular."
          maxLength={LIMITES.nomeDispositivo}
          editable={!pareando}
          returnKeyType="done"
        />
        <Botao rotulo="Parear" aoTocar={() => void parear()} ocupado={pareando} />
        <Text style={estilos.protocolo}>{rotuloProtocolo()}</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const estilos = StyleSheet.create({
  tela: {
    flex: 1,
    backgroundColor: cores.fundo,
  },
  conteudo: {
    padding: espaco.g,
    gap: espaco.g,
  },
  introducao: {
    fontSize: 16,
    color: cores.textoSuave,
  },
  protocolo: {
    fontSize: 13,
    textAlign: 'center',
    color: cores.textoSuave,
  },
});
