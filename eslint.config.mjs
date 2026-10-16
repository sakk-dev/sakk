// T0 lint (testing standard): core ESLint rules only — no plugins, so the
// zero-dependency policy holds (`npx` pins the version, like prettier).
const node = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  structuredClone: 'readonly',
  globalThis: 'readonly',
  require: 'readonly',
};

export default [
  { ignores: ['node_modules/', 'audit-logs/', 'eval/fixtures/', 'eval/gold/'] },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: node },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-self-assign': 'error',
      'no-self-compare': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-fallthrough': 'error',
      'no-cond-assign': ['error', 'except-parens'],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unsafe-finally': 'error',
      'no-unsafe-negation': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-prototype-builtins': 'error',
      'no-shadow-restricted-names': 'error',
      'no-useless-escape': 'error',
      'no-control-regex': 'error',
      'no-new-wrappers': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
];
