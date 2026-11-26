import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { OpcaoDaLista } from '@/lib/catalogo';
import { cores, espaco } from '@/tema';

/** Um item que não é um valor da lista, como o "Outro" dos modelos. */
interface ItemExtra {
  rotulo: string;
  marcado: boolean;
  aoTocar: () => void;
}

interface Props {
  rotulo: string;
  opcoes: readonly OpcaoDaLista[];
  /** O valor marcado; `null` quando nenhum item da lista está (o extra, por exemplo). */
  marcado: string | null;
  aoEscolher: (valor: string) => void;
  extra?: ItemExtra;
  ajuda?: string;
  erro?: string;
  desativado?: boolean;
}

/** Escolha de um item só, em botões que quebram linha. Para o leitor de tela, um grupo de opções. */
export function Lista({ rotulo, opcoes, marcado, aoEscolher, extra, ajuda, erro, desativado = false }: Props) {
  const itens = [
    ...opcoes.map((opcao) => ({ chave: `valor:${opcao.valor}`, rotulo: opcao.rotulo, marcado: opcao.valor === marcado, aoTocar: () => aoEscolher(opcao.valor) })),
    ...(extra ? [{ chave: 'extra', ...extra }] : []),
  ];
  return (
    <View style={estilos.campo}>
      <Text style={estilos.rotulo}>{rotulo}</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel={rotulo} style={estilos.itens}>
        {itens.map((item) => (
          <Pressable
            key={item.chave}
            accessibilityRole="radio"
            accessibilityLabel={item.rotulo}
            accessibilityState={{ checked: item.marcado, disabled: desativado }}
            disabled={desativado}
            onPress={item.aoTocar}
            style={({ pressed }) => [
              estilos.item,
              item.marcado && estilos.itemMarcado,
              pressed && estilos.pressionado,
              desativado && estilos.parado,
            ]}>
            <Text style={[estilos.textoItem, item.marcado && estilos.textoMarcado]}>{item.rotulo}</Text>
          </Pressable>
        ))}
      </View>
      {erro !== undefined ? (
        <Text accessibilityRole="alert" style={[estilos.detalhe, estilos.erro]}>
          {erro}
        </Text>
      ) : ajuda !== undefined ? (
        <Text style={estilos.detalhe}>{ajuda}</Text>
      ) : null}
    </View>
  );
}

const estilos = StyleSheet.create({
  campo: {
    gap: espaco.p,
  },
  rotulo: {
    fontSize: 15,
    fontWeight: '600',
    color: cores.texto,
  },
  itens: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: espaco.p,
  },
  item: {
    minHeight: 44,
    paddingHorizontal: espaco.m,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: cores.borda,
    backgroundColor: cores.fundo,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemMarcado: {
    borderColor: cores.primaria,
    backgroundColor: cores.primaria,
  },
  pressionado: {
    opacity: 0.8,
  },
  parado: {
    opacity: 0.5,
  },
  textoItem: {
    fontSize: 15,
    color: cores.texto,
  },
  textoMarcado: {
    color: cores.sobrePrimaria,
    fontWeight: '600',
  },
  detalhe: {
    fontSize: 13,
    color: cores.textoSuave,
  },
  erro: {
    color: cores.perigo,
  },
});
