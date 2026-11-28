import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { AndroidImportance } from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

import { botDoAviso, prepararAviso, type Permissao, type RecursosDoAviso } from '@/lib/aviso-push';
import type { Sessao } from '@/lib/sessao';
import { api } from '@/servicos';

/** O canal do Android em que o servidor manda o aviso; o mesmo nome do lado dele (`CANAL_DE_APROVACOES`). */
const CANAL_DE_APROVACOES = 'aprovacoes';

// Com o app aberto, o pedido já aparece no cartão da conversa e na lista de bots: o aviso não
// aparece por cima. Ele serve para o app fechado ou em segundo plano.
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false }),
});

/** O projeto na conta Expo, que o build grava na configuração; sem ele, não há aviso push. */
function projetoExpo(): string | null {
  const id: unknown = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  return typeof id === 'string' && id !== '' ? id : null;
}

function comoPermissao(status: string): Permissao {
  return status === 'granted' || status === 'denied' ? status : 'undetermined';
}

const recursos: RecursosDoAviso = {
  projetoExpo: projetoExpo(),
  ehAparelho: Device.isDevice,
  async preparar() {
    // No Android, a pergunta da permissão só aparece depois de existir um canal.
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CANAL_DE_APROVACOES, {
        name: 'Pedidos de aprovação',
        importance: AndroidImportance.HIGH,
      });
    }
  },
  permissao: async () => comoPermissao((await Notifications.getPermissionsAsync()).status),
  pedirPermissao: async () => comoPermissao((await Notifications.requestPermissionsAsync()).status),
  obterEndereco: async (projectId) => (await Notifications.getExpoPushTokenAsync({ projectId })).data,
  registrar: (endereco) => api.registrarAviso({ endereco }),
};

/**
 * Liga o aviso push à sessão: a cada sessão aberta, deixa o aparelho pronto para receber o aviso de
 * pedido de aprovação, e o toque num aviso abre a conversa do bot que pede. Sem sessão, nada.
 */
export function useAvisoPush(sessao: Sessao | null): void {
  useEffect(() => {
    if (sessao !== null) void prepararAviso(recursos);
  }, [sessao]);

  const resposta = Notifications.useLastNotificationResponse();
  const tratada = useRef<string | null>(null);
  useEffect(() => {
    if (sessao === null || !resposta) return;
    const id = resposta.notification.request.identifier;
    if (tratada.current === id) return;
    tratada.current = id;
    const botId = botDoAviso(resposta.notification.request.content.data);
    if (botId !== null) router.push({ pathname: '/bots/[id]', params: { id: botId } });
  }, [sessao, resposta]);
}
