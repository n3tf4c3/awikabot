import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

// Vale para o servidor e o core. O app tem a configuração do Expo em apps/mobile.
export default defineConfig([
  { ignores: ['**/dist/**', '**/node_modules/**', 'apps/mobile/**', 'spike/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
]);
