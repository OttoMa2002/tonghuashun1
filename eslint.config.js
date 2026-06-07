import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import vitest from '@vitest/eslint-plugin';
import globals from 'globals';

// 依赖方向单向:pages → components/charts → data → worker → mock(architecture.md §4)。
// 每个 zone 声明「target 目录不得 import from 目录」,即禁止反向引用。src/contract 为公共叶子,不受限。
const layeringZones = [
  {
    target: './src/mock',
    from: ['./src/data', './src/worker', './src/charts', './src/components', './src/pages'],
    message: 'mock 是依赖链末端,只能依赖 src/contract(architecture.md §4)',
  },
  {
    target: './src/worker',
    from: ['./src/data', './src/charts', './src/components', './src/pages'],
    message: 'worker 不得反向依赖 data/charts/components/pages(architecture.md §4)',
  },
  {
    target: './src/data',
    from: ['./src/charts', './src/components', './src/pages'],
    message: 'data 不得反向依赖 charts/components/pages(architecture.md §4)',
  },
  {
    target: './src/charts',
    from: ['./src/components', './src/pages'],
    message: 'charts 不得反向依赖 components/pages(architecture.md §4)',
  },
  {
    target: './src/components',
    from: ['./src/pages'],
    message: 'components 不得反向依赖 pages(architecture.md §4)',
  },
];

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage', 'logs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.worker },
    },
    plugins: { import: importPlugin },
    settings: {
      'import/resolver': {
        typescript: { project: './tsconfig.json' },
        node: true,
      },
    },
    rules: {
      // 硬约束 1:禁 any 与 @ts-ignore;压制只许 @ts-expect-error 且必须带说明(CLAUDE.md)。
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-ignore': true, 'ts-nocheck': true, 'ts-expect-error': 'allow-with-description' },
      ],
      // 硬约束 7:模块依赖单向。
      'import/no-restricted-paths': ['error', { zones: layeringZones }],
    },
  },
  {
    // ADR-0008:内容级篡改兜底——禁止 skip/only 既有测试。
    files: ['**/*.test.{ts,tsx}', '**/*.bench.{ts,tsx}'],
    plugins: { vitest },
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'vitest/no-disabled-tests': 'error',
      'vitest/no-focused-tests': 'error',
    },
  },
);
