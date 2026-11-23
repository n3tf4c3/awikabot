import { useHeaderHeight } from 'expo-router/react-navigation';
import { useState } from 'react';
import { KeyboardAvoidingView, ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LIMITES, type BotEntrada } from '@awikabot/core';

import { Aviso } from '@/components/Aviso';
import { Botao } from '@/components/Botao';
import { Campo } from '@/components/Campo';
import { mensagemDeErro } from '@/lib/erros';
import { validarBot, type CamposBot, type ErrosBot } from '@/lib/formulario-bot';
import { cores, espaco } from '@/tema';

interface Props {
  /** Valores com que o formulário abre. */
  inicial: CamposBot;
  /** Recebe a entrada já validada. Se rejeitar, o erro aparece no formulário e nada se perde. */
  aoSalvar: (entrada: BotEntrada) => Promise<void>;
}

/** Formulário de bot, igual para criar e para editar. */
export function FormularioBot({ inicial, aoSalvar }: Props) {
  const alturaDoCabecalho = useHeaderHeight();
  const margens = useSafeAreaInsets();
  const [campos, definirCampos] = useState(inicial);
  const [erros, definirErros] = useState<ErrosBot>({});
  const [falha, definirFalha] = useState<string | null>(null);
  const [salvando, definirSalvando] = useState(false);

  const mudar = (campo: keyof CamposBot) => (valor: string) => definirCampos((atuais) => ({ ...atuais, [campo]: valor }));

  async function salvar(): Promise<void> {
    const lido = validarBot(campos);
    definirErros(lido.ok ? {} : lido.erros);
    definirFalha(null);
    if (!lido.ok) return;

    definirSalvando(true);
    try {
      await aoSalvar(lido.entrada);
    } catch (erro) {
      definirFalha(mensagemDeErro(erro));
    } finally {
      definirSalvando(false);
    }
  }

  return (
    <KeyboardAvoidingView style={estilos.tela} behavior="padding" keyboardVerticalOffset={alturaDoCabecalho}>
      <ScrollView
        contentContainerStyle={[estilos.conteudo, { paddingBottom: espaco.g + margens.bottom }]}
        keyboardShouldPersistTaps="handled">
        {falha !== null ? <Aviso texto={falha} /> : null}
        <Campo
          rotulo="Nome"
          valor={campos.nome}
          aoMudar={mudar('nome')}
          erro={erros.nome}
          maxLength={LIMITES.nomeBot}
          comContador
          editable={!salvando}
        />
        <Campo
          rotulo="Instruções"
          valor={campos.instrucoes}
          aoMudar={mudar('instrucoes')}
          erro={erros.instrucoes}
          ajuda="Como o bot deve se comportar. Pode ficar em branco."
          multiline
          maxLength={LIMITES.instrucoes}
          comContador
          editable={!salvando}
        />
        <Campo
          rotulo="Modelo (opcional)"
          valor={campos.modelo}
          aoMudar={mudar('modelo')}
          erro={erros.modelo}
          ajuda="Em branco, o servidor usa o modelo padrão do motor."
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={LIMITES.modelo}
          editable={!salvando}
        />
        <Botao rotulo="Salvar" aoTocar={() => void salvar()} ocupado={salvando} />
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
});
