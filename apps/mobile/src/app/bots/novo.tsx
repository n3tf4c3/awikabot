import { useRouter } from 'expo-router';

import { FormularioBot } from '@/components/FormularioBot';
import { CAMPOS_BOT_VAZIOS } from '@/lib/formulario-bot';
import { useDados } from '@/provedores/dados';

export default function NovoBot() {
  const router = useRouter();
  const { operacoes } = useDados();

  return (
    <FormularioBot
      inicial={CAMPOS_BOT_VAZIOS}
      aoSalvar={async (entrada) => {
        await operacoes.criarBot(entrada);
        // Volta para a lista, onde o bot novo já aparece.
        if (router.canGoBack()) router.back();
        else router.replace('/');
      }}
    />
  );
}
