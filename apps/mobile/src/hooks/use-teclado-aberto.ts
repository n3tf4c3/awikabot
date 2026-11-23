import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

/** Se o teclado está na tela. Serve para tirar a folga da barra inferior quando ele cobre essa área. */
export function useTecladoAberto(): boolean {
  const [aberto, definirAberto] = useState(false);
  useEffect(() => {
    // No iOS o aviso "will" chega junto com a animação; o Android só manda o "did".
    const ios = Platform.OS === 'ios';
    const aoAbrir = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', () => definirAberto(true));
    const aoFechar = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () => definirAberto(false));
    return () => {
      aoAbrir.remove();
      aoFechar.remove();
    };
  }, []);
  return aberto;
}
