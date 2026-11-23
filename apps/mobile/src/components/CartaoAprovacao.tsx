import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ESPERA_APROVACAO_MS, type Aprovacao, type DecisaoAprovacao } from '@awikabot/core';

import { Botao } from '@/components/Botao';
import { rotuloDoDesfecho } from '@/lib/aprovacoes';
import { cores, espaco } from '@/tema';

type Decisao = DecisaoAprovacao['decisao'];

interface Props {
  aprovacao: Aprovacao;
  /** A decisão que está a caminho do servidor para este pedido, se houver. */
  enviando: Decisao | null;
  /** Há uma decisão a caminho, deste pedido ou de outro: os dois botões ficam parados. */
  bloqueado: boolean;
  aoDecidir: (decisao: Decisao) => void;
}

const MINUTOS_DE_ESPERA = Math.round(ESPERA_APROVACAO_MS / 60_000);

/** Pedido de aprovação pendente: o que o bot quer fazer e os botões para aprovar ou negar. */
export function CartaoAprovacao({ aprovacao, enviando, bloqueado, aoDecidir }: Props) {
  const { ferramenta, resumo } = aprovacao;
  return (
    <View style={estilos.cartao}>
      <Text accessibilityRole="header" style={estilos.titulo}>
        O bot pede para usar <Text style={estilos.ferramenta}>{ferramenta}</Text>
      </Text>
      {/* O resumo aparece inteiro: quando é longo, a caixa rola em vez de cortar o texto. */}
      <ScrollView
        nestedScrollEnabled
        persistentScrollbar
        accessibilityLabel={`O que ${ferramenta} vai fazer`}
        style={estilos.resumo}
        contentContainerStyle={estilos.resumoConteudo}>
        <Text selectable style={estilos.mono}>
          {resumo === '' ? '(o servidor não mandou detalhes deste pedido)' : resumo}
        </Text>
      </ScrollView>
      <Text style={estilos.prazo}>
        Nada acontece antes da sua resposta. Sem resposta em {MINUTOS_DE_ESPERA} minutos, o pedido expira e a ação não roda.
      </Text>
      <View style={estilos.botoes}>
        <Botao
          rotulo="Negar"
          rotuloAcessivel={`Negar o uso de ${ferramenta}`}
          variante="secundaria"
          aoTocar={() => aoDecidir('negar')}
          ocupado={enviando === 'negar'}
          desativado={bloqueado}
          style={estilos.botao}
        />
        <Botao
          rotulo="Aprovar"
          rotuloAcessivel={`Aprovar o uso de ${ferramenta}`}
          aoTocar={() => aoDecidir('aprovar')}
          ocupado={enviando === 'aprovar'}
          desativado={bloqueado}
          style={estilos.botao}
        />
      </View>
    </View>
  );
}

/** Linha compacta de um pedido que já saiu de pendente: a ferramenta e o desfecho. */
export function DesfechoAprovacao({ aprovacao }: { aprovacao: Aprovacao }) {
  const desfecho = rotuloDoDesfecho(aprovacao.estado);
  if (desfecho === null) return null;
  return (
    <Text
      accessibilityLabel={`Pedido para usar ${aprovacao.ferramenta}: ${desfecho.toLowerCase()}`}
      style={[estilos.desfecho, aprovacao.estado === 'aprovada' && estilos.desfechoAprovado]}>
      {aprovacao.ferramenta} · {desfecho}
    </Text>
  );
}

const estilos = StyleSheet.create({
  cartao: {
    marginVertical: 4,
    padding: espaco.m,
    gap: espaco.p,
    borderWidth: 1,
    borderColor: cores.primaria,
    borderRadius: 12,
    backgroundColor: cores.fundo,
  },
  titulo: {
    fontSize: 15,
    color: cores.texto,
  },
  ferramenta: {
    fontWeight: '700',
  },
  resumo: {
    maxHeight: 200,
    borderWidth: 1,
    borderColor: cores.borda,
    borderRadius: 8,
    backgroundColor: cores.fundoSuave,
  },
  resumoConteudo: {
    padding: espaco.p,
  },
  mono: {
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    fontSize: 13,
    lineHeight: 18,
    color: cores.texto,
  },
  prazo: {
    fontSize: 12,
    color: cores.textoSuave,
  },
  botoes: {
    flexDirection: 'row',
    gap: espaco.p,
  },
  botao: {
    flex: 1,
  },
  desfecho: {
    marginVertical: 2,
    paddingHorizontal: 4,
    fontSize: 12,
    color: cores.textoSuave,
  },
  desfechoAprovado: {
    color: cores.primaria,
  },
});
