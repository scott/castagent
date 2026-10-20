import tseslint from 'typescript-eslint'

// Type-aware lint for cast-cli source only. One rule: floating promises.
// dist/ is generated; the cast-cli lint script lints `.` and would otherwise
// parse those .d.ts files with the default parser.
export default [
  {
    ignores: ['**/dist/**'],
  },
  {
    files: ['typescript/cast-cli/src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      sourceType: 'module',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
]
