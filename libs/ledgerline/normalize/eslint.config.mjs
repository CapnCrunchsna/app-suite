import baseConfig from '../../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['**/*.json'],
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          ignoredFiles: [
            '{projectRoot}/eslint.config.{js,cjs,mjs,ts,cts,mts}',
            '{projectRoot}/vitest.config.{js,ts,mjs,mts}',
          ],
          // `ledgerline-domain` is a test-only dependency here, so it is invisible to
          // this rule (which reads production inputs only) while still being required
          // by package.json for the spec to resolve.
          //
          // The test that needs it is the one §3.3 cares most about: growing the prefix
          // table must change `description_normalized` and must NOT change
          // `collapseV1`. Proving that takes both libs in one assertion, and §2.2
          // permits the edge — `type:normalize` may depend on `type:domain`. The
          // dependency is deliberate; only the *production* usage is absent.
          ignoredDependencies: ['@metrum/ledgerline-domain'],
        },
      ],
    },
    languageOptions: {
      parser: await import('jsonc-eslint-parser'),
    },
  },
  {
    ignores: ['**/out-tsc'],
  },
];
