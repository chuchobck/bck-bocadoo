import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Reglas de arquitectura (ADR 0001): la base de datos solo se toca a través de DbService.
const SOLO_DBSERVICE = [
  {
    selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='service']",
    message:
      'service() usa bck_servicio (se salta RLS): solo para auth, cron y facturación. Para endpoints de negocio usa scope() o forRequest().',
  },
];

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // Los pools de pg no se tocan fuera de DbService.
      'no-restricted-imports': [
        'error',
        { paths: [{ name: 'pg', message: 'Usa DbService: nunca crees pools ni clientes de pg fuera de src/db.' }] },
      ],
      'no-restricted-syntax': ['error', ...SOLO_DBSERVICE],
    },
  },
  // Lugares autorizados a usar el rol de servicio (módulo de auth, eventos de seguridad) y a hablar con pg.
  {
    files: ['src/auth/**', 'src/security/**', 'src/db/**'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  { files: ['src/db/**'], rules: { 'no-restricted-imports': 'off' } },
  // Pruebas y scripts: acceso libre a la base para preparar datos y comprobar resultados.
  {
    files: ['test/**', 'scripts/**', '*.config.*'],
    rules: { 'no-restricted-syntax': 'off', 'no-restricted-imports': 'off', 'no-console': 'off' },
  },
  prettier,
);
