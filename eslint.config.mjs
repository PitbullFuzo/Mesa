import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';

export default tseslint.config(
  {
    // Hand-written type declarations for the plain .mjs release scripts; typed linting does not cover them.
    ignores: ['node_modules/**', 'test-vault/**', 'scripts/**/*.d.mts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  ...obsidianmd.configs.recommended,
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    rules: {
      // Preserve the view/command names specified by the product brief.
      'obsidianmd/ui/sentence-case': 'off',
      // Step 1 uses the sample plugin's display API; searchable settings are not in scope.
      'obsidianmd/settings-tab/prefer-setting-definitions': 'off',
    },
  },
  {
    // Release scripts run in the terminal, not inside Obsidian: printing their result is their job.
    files: ['scripts/**/*.mjs'],
    rules: {
      'no-console': 'off',
      'obsidianmd/rule-custom-message': 'off',
      'obsidianmd/hardcoded-config-path': 'off',
    },
  },
  {
    files: ['esbuild.config.mjs'],
    rules: {
      // Build output is explicitly fixed to this repository's test vault, not a user vault.
      'obsidianmd/hardcoded-config-path': 'off',
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      // Node fixtures deliberately exercise timers and default configuration paths.
      'obsidianmd/prefer-window-timers': 'off',
      'obsidianmd/hardcoded-config-path': 'off',
      'obsidianmd/no-global-this': 'off',
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['src/core/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { paths: ['obsidian'] }] },
  },
);
