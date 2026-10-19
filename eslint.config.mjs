import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import eslintConfigPrettier from 'eslint-config-prettier';

// Prettier owns formatting; ESLint is here for bugs tsc does not catch, above
// all unhandled promises: an async callback that rejects with no handler
// crashes the control plane.
export default tseslint.config(
    {
        // Generated, vendored and local-only paths. hls/ and docs/superpowers/
        // hold MPEG-TS segments, whose .ts extension ESLint would parse.
        ignores: [
            'dist/**',
            'build/**',
            'public/js/**',
            'public/vendor/**',
            'objs/**',
            'hls/**',
            'diagnostics/**',
            'docs/superpowers/**',
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        languageOptions: { globals: globals.node },
    },
    {
        files: ['src/**/*.ts', 'public/ts/**/*.ts'],
        languageOptions: {
            parserOptions: {
                // Explicit, because the project service would resolve src/ to
                // the root tsconfig.json, which is the dashboard's.
                project: ['./tsconfig.backend.json', './tsconfig.json'],
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-misused-promises': 'error',
            '@typescript-eslint/await-thenable': 'error',
            '@typescript-eslint/only-throw-error': 'error',
        },
    },
    {
        files: ['public/ts/**/*.ts'],
        languageOptions: { globals: globals.browser },
    },
    {
        // The tests are CommonJS.
        files: ['**/*.js'],
        rules: { '@typescript-eslint/no-require-imports': 'off' },
    },
    {
        rules: {
            '@typescript-eslint/no-unused-vars': [
                'warn',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_',
                },
            ],
        },
    },
    eslintConfigPrettier,
);
