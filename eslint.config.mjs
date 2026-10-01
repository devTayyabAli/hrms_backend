// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      "prettier/prettier": ["error", { endOfLine: "auto" }],
      // Raw sequelize.query() bypasses Sequelize's automatic parameterization
      // of model-based queries (findOne/findAll/create/...). It's sometimes
      // unavoidable (DDL like CREATE/DROP DATABASE, which can't be expressed
      // through a model and whose identifiers can't be bound as parameters
      // anyway) — those call sites must carry an eslint-disable comment
      // explaining why, and must never interpolate untrusted values directly
      // into the SQL string (use the `replacements`/`bind` option instead).
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='query'][callee.object.name=/sequelize/i]",
          message:
            "Raw sequelize.query() bypasses parameterized model queries. Prefer model methods. If unavoidable (e.g. DDL), pass any dynamic value via `replacements`/`bind` — never string-interpolate it into the query — and add an eslint-disable-next-line comment here explaining why.",
        },
      ],
    },
  },
);
