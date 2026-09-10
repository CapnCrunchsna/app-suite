import nx from '@nx/eslint-plugin';

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: ['**/dist', '**/out-tsc', '**/vitest.config.*.timestamp*'],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'],
          // Transcribed verbatim from ledgerline-spec.md §2.2. That block is the
          // contract, not a summary of it — edit the spec and this together.
          //
          // Every lib gets a DISTINCT type: tag on purpose. @nx/enforce-module-boundaries
          // matches on tags, so two libs sharing one tag necessarily share the union of
          // their allowances; a shared `type:util` across parsing/normalize/analyzers
          // would silently permit analyzers -> data, which is the single thing §2.2
          // exists to prevent.
          //
          // Tags for libs that do not exist yet (analyzers, data, llm, feature-shell)
          // are declared ahead of those libs deliberately: the constraint is what the
          // lib is generated *into*, so the boundary is never retrofitted onto code
          // already written against a looser rule. `ui` and `api-client` were
          // generated into their constraints exactly that way.
          depConstraints: [
            {
              sourceTag: 'scope:ll',
              onlyDependOnLibsWithTags: ['scope:ll', 'scope:shared'],
            },
            {
              sourceTag: 'scope:el',
              onlyDependOnLibsWithTags: ['scope:el', 'scope:shared'],
            },
            {
              sourceTag: 'scope:shared',
              onlyDependOnLibsWithTags: ['scope:shared'],
            },
            // `type:format` is a leaf — it imports nothing, exactly like
            // `type:domain` — so it appears in almost every allow-list below and
            // weakens no invariant by doing so. The rule it encodes is "any lib
            // may render a number for a person", which is simpler to hold than a
            // list of which libs happen to print money today. `type:api-client`
            // is the one exception: generated code imports nothing, by design.
            { sourceTag: 'type:format', onlyDependOnLibsWithTags: [] },
            { sourceTag: 'type:domain', onlyDependOnLibsWithTags: ['type:format'] },
            {
              sourceTag: 'type:parsing',
              onlyDependOnLibsWithTags: ['type:domain', 'type:format'],
            },
            {
              sourceTag: 'type:normalize',
              onlyDependOnLibsWithTags: ['type:domain', 'type:llm', 'type:format'],
            },
            {
              sourceTag: 'type:analyzers',
              onlyDependOnLibsWithTags: ['type:domain', 'type:format'],
            },
            {
              sourceTag: 'type:data-access',
              onlyDependOnLibsWithTags: ['type:domain', 'type:format'],
            },
            { sourceTag: 'type:llm', onlyDependOnLibsWithTags: ['type:domain', 'type:format'] },
            {
              sourceTag: 'type:feature',
              onlyDependOnLibsWithTags: [
                'type:domain',
                'type:ui',
                'type:api-client',
                'type:format',
              ],
            },
            { sourceTag: 'type:ui', onlyDependOnLibsWithTags: ['type:ui', 'type:format'] },
            { sourceTag: 'type:api-client', onlyDependOnLibsWithTags: [] },
            { sourceTag: 'type:app', onlyDependOnLibsWithTags: ['*'] },
          ],
        },
      ],
    },
  },
  {
    files: [
      '**/*.ts',
      '**/*.tsx',
      '**/*.cts',
      '**/*.mts',
      '**/*.js',
      '**/*.jsx',
      '**/*.cjs',
      '**/*.mjs',
    ],
    // Override or add rules here
    rules: {},
  },
];
