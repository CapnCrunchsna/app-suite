/**
 * `/api/settings` — §2.3's config surface, and the half of §6.8 that §7.4 makes real.
 *
 * §7.4: "Every threshold in §5 is a default in a config object; Settings overrides it;
 * `analysis_run` records `config_hash`; `finding.rule_version` incorporates it. No
 * analyzer reads a module-level constant." All of that machinery has existed since the
 * analyzers landed. What was missing was any way to write the override — so the
 * thresholds were data in principle and constants in practice.
 *
 * ## The editable surface is derived, not declared
 *
 * `DEFAULT_CONFIG` is the single source of what a threshold *is*, so this route walks
 * it and reports the scalar leaves rather than restating a list of tunable fields that
 * would drift the first time §5 gains one. The non-scalars are skipped deliberately and
 * named in `unsettable`: §5.2's cadence table is a list of objects and §5.6's trial
 * markers are a word list, and both are §7.6 calibration decisions rather than a number
 * with a slider — editing them through a generic form would be inviting a shape error
 * into the config that `resolveConfig` merges without complaint.
 *
 * ## One code path for thresholds and rule switches
 *
 * §6.8 asks for "per-rule enable [...] and threshold overrides" as two features. They
 * are one write: a rule's `enabled` is a boolean field in that rule's own config
 * section, exactly like its numbers, so both travel as `{ section, key, value }` and
 * both move `config_hash`. That is not a shortcut — it is what makes §5.1 re-evaluate a
 * disabled rule's dismissals when it comes back, which a switch stored outside the
 * config could not do.
 *
 * A `null` value **removes** the override and returns the field to its default, which is
 * the same "explicit null clears, omission leaves alone" shape §9i settled for series.
 */

import { DEFAULT_CONFIG, configHash, resolveConfig } from '@metrum/ledgerline-analyzers';
import type { AnalyzerConfig, ConfigOverride } from '@metrum/ledgerline-analyzers';
import type { FastifyInstance } from 'fastify';

import { errorResponses } from './errors.js';
import { ref } from './schemas.js';
import { ANALYZER_CONFIG_SETTING } from '../analysis-service.js';
import type { ApiConfig } from '../config.js';
import type { LedgerlineContext } from '../context.js';
import {
  LLM_PROVIDER_IDS,
  createLlmProvider,
  effectiveRedaction,
  readLlmSettings,
  writeLlmSettings,
} from '../llm-service.js';
import type { LlmSettings } from '../llm-service.js';

type Section = keyof AnalyzerConfig;
type Scalar = number | boolean;

interface ChangeBody {
  readonly section: string;
  readonly key: string;
  readonly value: Scalar | null;
}

/**
 * §6.8's LLM provider section, as a partial patch.
 *
 * On the same endpoint as the thresholds because §2.3 puts it there — one row,
 * "`GET /api/settings` · `PATCH`", purpose "Config, analyzer thresholds, provider
 * health probe". Underneath they are two settings keys and that separation is the
 * point: a provider change must not move `config_hash` (see `llm-service.ts`). So
 * one request can carry both and the response says, truthfully, that only one of
 * them disturbed §5.
 */
interface LlmChangeBody {
  readonly providerId?: string;
  readonly model?: string | null;
  readonly redaction?: boolean;
}

/**
 * §5's rules, and where each keeps its switch.
 *
 * §5.4 is two entries because §5.4 is two rules — "separately toggleable in Settings",
 * in that section's own words, one claiming an error and one claiming nothing. They
 * share a `config_hash` and a rule id, so the UI has to be told they are two switches
 * over one row rather than inferring it from a field name.
 */
const RULES = [
  { id: 'recurrence.v1', label: 'Recurring subscriptions', spec: '5.2', section: 'recurrence', enabledKey: 'enabled' },
  { id: 'duplicate.v1', label: 'Same-merchant multiplicity', spec: '5.4', section: 'duplicate', enabledKey: 'sameMerchantEnabled' },
  { id: 'duplicate.v1', label: 'Category overlap', spec: '5.4', section: 'duplicate', enabledKey: 'categoryOverlapEnabled' },
  { id: 'price_creep.v1', label: 'Price creep', spec: '5.5', section: 'priceCreep', enabledKey: 'enabled' },
  { id: 'trial.v1', label: 'Trial conversions', spec: '5.6', section: 'trial', enabledKey: 'enabled' },
  { id: 'lapsed.v1', label: 'Cancellation confirmation', spec: '5.7', section: 'lapsed', enabledKey: 'enabled' },
  { id: 'fees.v1', label: 'Fees and interest', spec: '5.8', section: 'fees', enabledKey: 'enabled' },
  { id: 'outlier.v1', label: 'Outlier charges', spec: '5.9', section: 'outlier', enabledKey: 'enabled' },
  { id: 'trend.v1', label: 'Category trends', spec: '5.10', section: 'trend', enabledKey: 'enabled' },
  { id: 'micro.v1', label: 'High-frequency small spend', spec: '5.11', section: 'micro', enabledKey: 'enabled' },
] as const;

const isScalar = (value: unknown): value is Scalar =>
  typeof value === 'number' || typeof value === 'boolean';

const sectionsOf = (config: AnalyzerConfig): Section[] => Object.keys(config) as Section[];

/**
 * One config section as a plain map.
 *
 * `AnalyzerConfig[Section]` is a union of eleven unrelated interfaces, so TypeScript
 * refuses a direct cast to `Record<string, unknown>` — correctly, since nothing
 * guarantees they share keys. Reading them generically is exactly what this route
 * does, and doing it through one named helper keeps the assertion in a single place
 * with a reason attached rather than scattered through the walk.
 */
const fieldsOf = (section: unknown): Record<string, unknown> =>
  section as Record<string, unknown>;

/** The stored override, or an empty one. A malformed value in the settings table is a
 *  bad write, not a reason to refuse to render the page — the defaults still apply. */
function storedOverride(context: LedgerlineContext): ConfigOverride {
  const raw = context.store.settings.get<ConfigOverride>(ANALYZER_CONFIG_SETTING);
  return raw && typeof raw === 'object' ? raw : {};
}

/**
 * §6.8's provider section, with the two facts the page cannot derive.
 *
 * `sendsDataOffMachine` is read off the *built* provider rather than mapped from
 * the id, because §2.4 puts it on the interface for exactly this reason: it is what
 * the warning card and the header indicator both read, and a UI that inferred it
 * would be a second implementation of the one fact that must never be wrong.
 *
 * `redactionLocked` reports §6.8's clamp — "not disableable while `claude-cli` is
 * selected" — as a fact rather than leaving the page to re-derive it and disagree.
 */
function buildLlmSettings(context: LedgerlineContext) {
  const stored = readLlmSettings(context);
  const provider = createLlmProvider(context, { uncached: true });

  return {
    providerId: stored.providerId,
    model: stored.model,
    redaction: effectiveRedaction(stored),
    redactionLocked: stored.providerId === 'claude-cli',
    sendsDataOffMachine: provider.sendsDataOffMachine,
    cachedResponses: context.store.llm.countCached(),
    degradedCallCount: context.store.llm.countDegraded(),
  };
}

function buildSettings(context: LedgerlineContext, config: ApiConfig) {
  const override = storedOverride(context);
  const effective = resolveConfig(override);

  const thresholds: unknown[] = [];
  const unsettable: unknown[] = [];

  for (const section of sectionsOf(DEFAULT_CONFIG)) {
    const defaults = fieldsOf(DEFAULT_CONFIG[section]);
    const current = fieldsOf(effective[section]);
    const set = (override[section] ?? {}) as Record<string, unknown>;

    for (const key of Object.keys(defaults)) {
      if (!isScalar(defaults[key])) {
        unsettable.push({ section, key, reason: describeUnsettable(section, key) });
        continue;
      }
      thresholds.push({
        section,
        key,
        kind: typeof defaults[key] === 'boolean' ? 'boolean' : 'number',
        defaultValue: defaults[key] as Scalar,
        value: current[key] as Scalar,
        overridden: Object.prototype.hasOwnProperty.call(set, key),
      });
    }
  }

  // §5.1's dismissals, per rule — what §6.8's "changing a threshold warns that
  // dismissed findings in that rule will be re-evaluated" is warning *about*. A count
  // makes that a statement rather than a disclaimer.
  // `dismissed` is a *user* status, not a lifecycle one — see `FindingQuery`. And
  // `visibility: 'all'` because a dismissed finding is hidden by default, which is the
  // whole reason it needs counting here.
  // §7.6's corpus, beside the thresholds it exists to re-derive (§9z). Precision
  // only — nothing here can measure what the rules failed to find.
  const accuracy = context.store.findingLabels.accuracyByRule();

  const dismissed = context.store.findings.totals({
    statuses: ['active', 'resolved', 'suppressed'],
    userStatuses: ['dismissed'],
    visibility: 'all',
  }).countsByRule;
  const active = context.store.findings.totals({ statuses: ['active'] }).countsByRule;

  return {
    configHash: configHash(effective),
    rules: RULES.map((rule) => ({
      id: rule.id,
      label: rule.label,
      specRef: rule.spec,
      section: rule.section,
      enabledKey: rule.enabledKey,
      enabled: fieldsOf(effective[rule.section as Section])[rule.enabledKey] === true,
      activeFindings: active[rule.id] ?? 0,
      labelled: accuracy.get(rule.id) ?? {
        ruleId: rule.id,
        correct: 0,
        incorrect: 0,
        unsure: 0,
        stale: 0,
      },
      dismissedFindings: dismissed[rule.id] ?? 0,
    })),
    thresholds,
    unsettable,
    llm: buildLlmSettings(context),
    databaseFile: config.databaseFile,
    backupDir: config.backupDir,
  };
}

/**
 * Validate and apply an LLM change, or say what is wrong with it.
 *
 * §6.8's clamp is enforced here rather than silently corrected: a request that asks
 * to disable redaction while `claude-cli` is selected is refused with the reason,
 * because quietly storing `true` after being told `false` is how a privacy control
 * comes to be believed to be off when it is on. The opposite would be worse, and
 * neither is as good as an error the page can print.
 */
function applyLlmChange(
  context: LedgerlineContext,
  change: LlmChangeBody,
): { settings: LlmSettings } | { error: string } {
  const current = readLlmSettings(context);

  const providerId = change.providerId ?? current.providerId;
  if (!LLM_PROVIDER_IDS.includes(providerId as (typeof LLM_PROVIDER_IDS)[number])) {
    return {
      error: `"${providerId}" is not a provider — spec 2.4 has ${LLM_PROVIDER_IDS.join(', ')}`,
    };
  }

  const redaction = change.redaction ?? current.redaction;
  if (providerId === 'claude-cli' && redaction === false) {
    return {
      error:
        'Redaction cannot be disabled while the Claude CLI provider is selected (spec 6.8). ' +
        'It is the provider that sends descriptors off this machine.',
    };
  }

  const model =
    change.model === undefined
      ? current.model
      : change.model === null || change.model.trim() === ''
        ? null
        : change.model.trim();

  return {
    settings: writeLlmSettings(context, {
      providerId: providerId as LlmSettings['providerId'],
      model,
      redaction,
    }),
  };
}

/** Why a non-scalar is not editable here. Specific rather than generic, because
 *  "not supported" invites someone to add a text box for it. */
function describeUnsettable(section: string, key: string): string {
  if (section === 'recurrence' && key === 'cadences') {
    return 'the cadence table is spec 5.2’s list of (days, tolerance, per-year) triples — a calibration decision, not a number';
  }
  if (section === 'global' && key === 'bands') {
    return 'confidence bands are three cut points that have to stay ordered; editing one in isolation would invert them';
  }
  return 'a list rather than a single value — spec 7.6 calibration territory';
}

/** Reject anything that would put a wrong-shaped value into the config, because
 *  `resolveConfig` spreads the override in without complaint and the failure would
 *  surface as a rule behaving oddly rather than as a bad request. */
function validate(change: ChangeBody): string | null {
  const defaults = fieldsOf(DEFAULT_CONFIG)[change.section];
  if (!defaults || typeof defaults !== 'object') {
    return `no config section named "${change.section}"`;
  }

  const fallback = fieldsOf(defaults)[change.key];
  if (fallback === undefined) {
    return `section "${change.section}" has no setting named "${change.key}"`;
  }
  if (!isScalar(fallback)) {
    return `"${change.section}.${change.key}" is not a single value: ${describeUnsettable(change.section, change.key)}`;
  }
  // A reset is always legal — it puts the shipped default back.
  if (change.value === null) return null;

  if (typeof change.value !== typeof fallback) {
    return `"${change.section}.${change.key}" is a ${typeof fallback}, got ${typeof change.value}`;
  }
  if (typeof change.value === 'number' && !Number.isFinite(change.value)) {
    return `"${change.section}.${change.key}" must be a finite number`;
  }
  return null;
}

export function registerSettingsRoutes(
  app: FastifyInstance,
  context: LedgerlineContext,
  config: ApiConfig,
): void {
  app.get(
    '/api/settings',
    {
      schema: {
        summary: 'Spec 7.4’s config, as spec 6.8’s Analyzers section reads it',
        operationId: 'getSettings',
        description:
          'Every tunable threshold with its shipped default, whether it has been ' +
          'overridden, and the current `config_hash`; every spec 5 rule with its switch and ' +
          'how many of its findings are active and dismissed. The editable set is derived ' +
          'from the default config, so a threshold added to spec 5 appears here without a ' +
          'second list to update.',
        tags: ['settings'],
        response: { 200: ref('Settings'), ...errorResponses },
      },
    },
    async () => buildSettings(context, config),
  );

  app.patch<{ Body: { changes?: ChangeBody[]; llm?: LlmChangeBody } }>(
    '/api/settings',
    {
      schema: {
        summary: 'Override a threshold, switch a rule off, or choose an LLM provider',
        operationId: 'updateSettings',
        description:
          'The first two are the same write: a rule’s switch is a boolean field in that ' +
          'rule’s own config section. A `null` value removes the override and restores the ' +
          'shipped default. Every accepted threshold change moves `config_hash`, which is ' +
          'what makes spec 5.1 re-evaluate that rule’s dismissed findings on the next run — ' +
          'the response says whether the hash moved and how many dismissals are in scope. ' +
          'The provider is deliberately **not** part of that hash: choosing a different model ' +
          'changes which descriptors resolve to which merchant, but not a single spec 5 ' +
          'threshold, and folding it in would invalidate every dismissal in the database.',
        tags: ['settings'],
        body: {
          type: 'object',
          properties: {
            changes: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                required: ['section', 'key'],
                properties: {
                  section: { type: 'string' },
                  key: { type: 'string' },
                  /** `null` resets to the shipped default. */
                  value: { type: ['number', 'boolean', 'null'] },
                },
              },
            },
            /** Spec 6.8's LLM provider and Redaction sections. Partial: an absent
             *  field leaves that setting alone. */
            llm: {
              type: 'object',
              properties: {
                providerId: { type: 'string', enum: LLM_PROVIDER_IDS },
                model: { type: ['string', 'null'] },
                redaction: { type: 'boolean' },
              },
            },
          },
        },
        response: { 200: ref('SettingsUpdate'), ...errorResponses },
      },
    },
    async (request, reply) => {
      const changes = request.body.changes ?? [];

      // Validated as a set before anything is written: a half-applied batch would
      // leave the config in a state the user never asked for and could not name.
      // The LLM half is validated in the same breath and for the same reason —
      // one request, one verdict.
      const problems = changes.map(validate).filter((p): p is string => p !== null);
      if (problems.length > 0) {
        return reply.code(422).send({ error: 'invalid_setting', message: problems.join('; ') });
      }

      if (request.body.llm) {
        const outcome = applyLlmChange(context, request.body.llm);
        if ('error' in outcome) {
          return reply.code(422).send({ error: 'invalid_setting', message: outcome.error });
        }
      }

      const before = configHash(resolveConfig(storedOverride(context)));
      const next = structuredClone(storedOverride(context)) as Record<
        string,
        Record<string, Scalar>
      >;

      for (const change of changes) {
        if (change.value === null) {
          delete next[change.section]?.[change.key];
          // An override section with nothing left in it is noise in the stored JSON,
          // and `overridden` on the way out is computed from the keys present.
          if (next[change.section] && Object.keys(next[change.section]).length === 0) {
            delete next[change.section];
          }
          continue;
        }
        next[change.section] = { ...(next[change.section] ?? {}), [change.key]: change.value };
      }

      context.store.settings.set(ANALYZER_CONFIG_SETTING, next);

      const settings = buildSettings(context, config);
      const touched = new Set(changes.map((change) => change.section));

      return {
        settings,
        configHashChanged: settings.configHash !== before,
        // Only the rules whose own section moved. Changing a §5.10 threshold says
        // nothing about §5.2's dismissals, and warning about them would train the
        // user to ignore the warning.
        dismissalsAffected: settings.rules
          .filter((rule) => touched.has(rule.section))
          .reduce((total, rule) => total + rule.dismissedFindings, 0),
      };
    },
  );
}
