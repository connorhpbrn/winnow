import tseslint from 'typescript-eslint';

// Minimal flat config. The point of lint in Milestone 1 is to enforce the cardinal
// rule that /core is transport-agnostic (spec Appendix A #2/#3/#4): no Telegram,
// Stripe, Trigger.dev, or Next imports may appear under core/**. This makes a leak a
// CI failure rather than a code-review hope.
export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      '.winnow/**',
      'drizzle/**',
      'editions/**',
      'app/**',
    ],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { sourceType: 'module', ecmaVersion: 'latest' },
    },
  },
  {
    files: ['core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'stripe', message: 'No Stripe in /core. Billing lives in adapters; subscription_status is written only by the Stripe webhook.' },
            { name: 'next', message: 'No Next.js in /core. /core is transport-agnostic.' },
            { name: 'telegraf', message: 'No Telegram libraries in /core. Telegram lives in /telegram.' },
            { name: 'grammy', message: 'No Telegram libraries in /core. Telegram lives in /telegram.' },
            { name: 'node-telegram-bot-api', message: 'No Telegram libraries in /core. Telegram lives in /telegram.' },
          ],
          patterns: [
            { group: ['@trigger.dev/*'], message: 'No Trigger.dev in /core. Jobs are thin wrappers that call /core.' },
            { group: ['next/*'], message: 'No Next.js in /core. /core is transport-agnostic.' },
            { group: ['../telegram/*', '../../telegram/*', '../trigger/*', '../../trigger/*', '../app/*', '../../app/*'], message: 'No imports from transport/adapter layers into /core.' },
          ],
        },
      ],
    },
  },
);
