import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Ports and adapters (AGENTS.md rule 1): the core never imports provider code.
    files: ['packages/server/src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/providers/*', '**/providers/**'],
              message: 'The core must not import from providers. Depend on the port instead.',
            },
          ],
        },
      ],
    },
  },
);
