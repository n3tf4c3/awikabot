import { fetch } from 'expo/fetch';
import * as SecureStore from 'expo-secure-store';

import { criarApi } from '@/lib/api';
import { criarGuardaSessao } from '@/lib/sessao';

/** Um item só no cofre do aparelho: endereço do servidor, token e dispositivo entram e saem juntos. */
const CHAVE_SESSAO = 'awikabot.sessao';

/** O token não vai para backup nem para outro aparelho: pareamento é de um aparelho só. */
const OPCOES_DO_COFRE: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/** Dona da sessão do app. As telas leem por `useSessao`; a API, a cada pedido. */
export const guardaSessao = criarGuardaSessao({
  ler: () => SecureStore.getItemAsync(CHAVE_SESSAO, OPCOES_DO_COFRE),
  gravar: (valor) => SecureStore.setItemAsync(CHAVE_SESSAO, valor, OPCOES_DO_COFRE),
  apagar: () => SecureStore.deleteItemAsync(CHAVE_SESSAO, OPCOES_DO_COFRE),
});

export const api = criarApi({
  buscar: fetch,
  sessaoAtual: () => guardaSessao.estado().sessao,
  aoNaoAutenticado: (sessao) => guardaSessao.sairSeAtual(sessao),
});
