import { useHeaderHeight } from 'expo-router/react-navigation';
import { useState } from 'react';
import { KeyboardAvoidingView, ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LIMITES, type BotEntrada } from '@awikabot/core';

import { Aviso } from '@/components/Aviso';
import { Botao } from '@/components/Botao';
import { Campo } from '@/components/Campo';
import { Lista } from '@/components/Lista';
import { useCatalogo } from '@/hooks/use-catalogo';
import {
  ROTULO_OUTRO_MODELO,
  aoChegarCatalogo,
  digitarOutroModelo,
  escolherModelo,
  escolherMotor,
  estadoInicial,
  modeloMarcado,
  motoresParaCriar,
  nomeDoMotor,
  opcoesDeEsforco,
  opcoesDeModelo,
  type EstadoDoFormulario,
} from '@/lib/catalogo';
import { mensagemDeErro } from '@/lib/erros';
import { validarBot, type CamposBot, type ErrosBot } from '@/lib/formulario-bot';
import { cores, espaco } from '@/tema';

interface Props {
  /** Valores com que o formulário abre. */
  inicial: CamposBot;
  /** Na edição o motor só aparece: ele é escolhido na criação e não muda. */
  motorFixo?: boolean;
  /** Recebe a entrada já validada. Se rejeitar, o erro aparece no formulário e nada se perde. */
  aoSalvar: (entrada: BotEntrada) => Promise<void>;
}

/** Formulário de bot, igual para criar e para editar. As listas vêm do catálogo do servidor. */
export function FormularioBot({ inicial, motorFixo = false, aoSalvar }: Props) {
  const alturaDoCabecalho = useHeaderHeight();
  const margens = useSafeAreaInsets();
  const catalogo = useCatalogo();
  const [guardado, definirGuardado] = useState<EstadoDoFormulario>(() => estadoInicial(inicial, null));
  const [mexeuNoModelo, definirMexeuNoModelo] = useState(false);
  const [erros, definirErros] = useState<ErrosBot>({});
  const [falha, definirFalha] = useState<string | null>(null);
  const [salvando, definirSalvando] = useState(false);
  // O catálogo chega depois de a tela abrir: até a pessoa mexer na lista, é ele que decide se o
  // modelo do bot está na lista ou no "Outro".
  const estado = mexeuNoModelo ? guardado : aoChegarCatalogo(guardado, catalogo);
  const { campos } = estado;

  const mudarModelo = (proximo: EstadoDoFormulario) => {
    definirMexeuNoModelo(true);
    definirGuardado(proximo);
  };
  const mudar = (campo: 'nome' | 'instrucoes') => (valor: string) =>
    definirGuardado({ ...estado, campos: { ...campos, [campo]: valor } });
  // Digitar no "Outro" fixa a escolha: o campo não some se o texto coincidir com um item da lista.
  const digitarModelo = (modelo: string) => mudarModelo({ ...estado, campos: { ...campos, modelo } });

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

  const esforcos = opcoesDeEsforco(catalogo, campos.motor, campos.esforco);

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
        {motorFixo ? (
          <Lista
            rotulo="Motor"
            opcoes={[{ valor: campos.motor, rotulo: nomeDoMotor(catalogo, campos.motor) }]}
            marcado={campos.motor}
            aoEscolher={() => {}}
            ajuda="O motor é escolhido na criação e não muda."
            desativado
          />
        ) : (
          <Lista
            rotulo="Motor"
            opcoes={motoresParaCriar(catalogo)}
            marcado={campos.motor}
            aoEscolher={(motor) => mudarModelo(escolherMotor(estado, catalogo, motor))}
            erro={erros.motor}
            ajuda="Não muda depois de criado: a conversa fica guardada no motor."
            desativado={salvando}
          />
        )}
        <Lista
          rotulo="Modelo"
          opcoes={opcoesDeModelo(catalogo, campos.motor)}
          marcado={modeloMarcado(estado)}
          aoEscolher={(modelo) => mudarModelo(escolherModelo(estado, modelo))}
          extra={{
            rotulo: ROTULO_OUTRO_MODELO,
            marcado: estado.digitarModelo,
            aoTocar: () => mudarModelo(digitarOutroModelo(estado, catalogo)),
          }}
          erro={estado.digitarModelo ? undefined : erros.modelo}
          ajuda="Auto usa o modelo padrão do motor."
          desativado={salvando}
        />
        {estado.digitarModelo ? (
          <Campo
            rotulo="Outro modelo"
            valor={campos.modelo}
            aoMudar={digitarModelo}
            erro={erros.modelo}
            ajuda="O nome do modelo como o motor o aceita. Em branco, vale o Auto."
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={LIMITES.modelo}
            editable={!salvando}
          />
        ) : null}
        {esforcos.length > 1 ? (
          <Lista
            rotulo="Esforço"
            opcoes={esforcos}
            marcado={campos.esforco}
            aoEscolher={(esforco) => definirGuardado({ ...estado, campos: { ...campos, esforco } })}
            erro={erros.esforco}
            ajuda="Quanto o modelo pensa antes de responder. Padrão deixa o motor decidir."
            desativado={salvando}
          />
        ) : null}
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
