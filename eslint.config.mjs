import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/*.d.ts'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['apps/extension/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, chrome: 'readonly' },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['apps/api/**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // The backend has no schema-validation layer and deals directly in untyped
      // external API JSON (GitHub REST/Search responses, Groq completions) — `any` at
      // those boundaries is an accurate reflection of "unvalidated external data",
      // not a shortcut. Revisit if a validation library (e.g. zod) is introduced.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'apps/extension/src/test/**/*.ts'],
    rules: {
      // Test doubles/partial mocks commonly use `any` for brevity — different bar
      // than production code.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
