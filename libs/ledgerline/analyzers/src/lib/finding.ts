/**
 * §5.1's shared finding contract — the shape every rule in §5.2–§5.11 emits, and
 * the emit-time policy they all pass through.
 *
 * ## `impact_kind` is the load-bearing field
 *
 * Findings measure two different things and summing them double-counts the same
 * dollars: a $1,459/yr coffee finding, a $1,200/yr dining-spike finding and a
 * subscription total can all describe the same transactions.
 *
 * - **`savings`** — money that would stop leaving if you acted. These sum, and
 *   this is the number on the Findings page.
 * - **`visibility`** — money you are already knowingly spending, surfaced because
 *   you have never seen it totalled. Shown per finding and **never** added to the
 *   headline.
 *
 * §7.3 states the invariant that falls out of it: two findings may never claim
 * the same dollars as `savings`.
 *
 * ## The evidence hash is what makes a dismissal stick — and unstick
 *
 * Dismissing a finding stores this hash. The finding stays dismissed while the
 * hash is stable; if the price changes or a lapsed series resumes, the hash moves
 * and the finding returns flagged "changed since you dismissed this".
 *
 * Note what is deliberately **not** in it: occurrence count. The design session
 * included an occurrence-count bucket, which increases every billing cycle and
 * would have un-dismissed every monthly subscription on a schedule — while
 * `series_status`, the thing that actually flips when a dormant series resumes,
 * was absent.
 */

import { createHash } from 'node:crypto';

import type { AnalyzerConfig } from './config.js';

export type ImpactKind = 'savings' | 'visibility';

/** §5.1: `≥0.80` High · `0.55–0.79` Medium · `0.35–0.54` Low · `<0.35` suppressed. */
export type ConfidenceBand = 'high' | 'medium' | 'low' | 'suppressed';

/**
 * What a finding is *about*, and half of its natural key.
 *
 * `portfolio` is for the handful of findings that describe the whole dataset —
 * §5.2's "14 active subscriptions, $247/mo" summary is one. It takes a constant
 * subject id rather than, say, the coverage window, because the natural key has
 * to be stable across runs: keying that summary on its window would mint a new
 * finding every time a statement extends coverage instead of upserting the one
 * that already exists, and every dismissal would be orphaned with it.
 */
export type SubjectType = 'series' | 'merchant' | 'category' | 'account' | 'window' | 'portfolio';

export interface Finding {
  readonly ruleId: string;
  /** Incorporates the config hash (§7.4), so a threshold change is visible as a
   *  version change rather than as findings silently appearing and vanishing. */
  readonly ruleVersion: string;
  readonly subjectType: SubjectType;
  readonly subjectId: string;
  /** `rule_id + subject_type + subject_id`, UNIQUE on `finding` (§3.2). This is
   *  what makes the lifecycle an upsert, so user state survives every re-run. */
  readonly naturalKey: string;
  readonly title: string;
  /** Structured payload the UI renders. Rules put their own numbers here rather
   *  than formatting prose, so the page can present them and the API can serialize
   *  them without either one parsing a sentence. */
  readonly detail: Readonly<Record<string, unknown>>;
  /** Explicit transaction ids, materialized into `finding_evidence` (§3.1). This
   *  is what backs §6.3's has-finding filter and inline evidence. */
  readonly evidenceTransactionIds: readonly string[];
  readonly confidence: number;
  readonly band: ConfidenceBand;
  readonly impactKind: ImpactKind;
  readonly impactMonthlyCents: number;
  readonly impactAnnualCents: number;
  /** §7.5: provenance travels to the UI as this flag and caps confidence at
   *  Medium. No rule may *branch* on it — that is what makes the `none`-mode
   *  claim testable. */
  readonly llmDependent: boolean;
  readonly evidenceHash: string;
}

/** §5.1's rollup: "31 more below $40/yr", expanded on demand. */
export interface FindingRollup {
  readonly ruleId: string;
  readonly suppressedCount: number;
  /** The impact of the smallest finding that *was* emitted — everything rolled up
   *  is below it. */
  readonly belowAnnualCents: number;
}

export interface RuleEmission {
  readonly findings: readonly Finding[];
  readonly rollup: FindingRollup | null;
}

export function naturalKey(ruleId: string, subjectType: SubjectType, subjectId: string): string {
  return `${ruleId}|${subjectType}|${subjectId}`;
}

export function bandFor(confidence: number, config: AnalyzerConfig): ConfidenceBand {
  const { bands } = config.global;
  if (confidence >= bands.high) return 'high';
  if (confidence >= bands.medium) return 'medium';
  if (confidence >= bands.low) return 'low';
  return 'suppressed';
}

/** What §5.1 hashes, spelled out as a type so a rule cannot quietly add a field
 *  that makes its dismissals expire on a schedule. */
export interface EvidenceHashInput {
  readonly ruleId: string;
  readonly subjectId: string;
  /** Rounded to the nearest dollar before hashing, so a one-cent proration does
   *  not resurface a dismissed finding. */
  readonly amountCents: number;
  readonly cadenceLabel: string | null;
  readonly seriesStatus: string | null;
}

export function evidenceHash(input: EvidenceHashInput): string {
  const material = [
    input.ruleId,
    input.subjectId,
    String(Math.round(input.amountCents / 100)),
    input.cadenceLabel ?? '',
    input.seriesStatus ?? '',
  ].join('|');

  return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 32);
}

/** A finding as a rule builds it, before the shared policy decides whether it is
 *  emitted at all. `band` and `naturalKey` are derived, so rules do not restate
 *  them and cannot disagree with each other about the bands. */
export type DraftFinding = Omit<Finding, 'band' | 'naturalKey'>;

export interface EmissionOptions {
  /** §5.1: only `lapsed.v1` opts out of the absolute impact floor, because its
   *  value is confirmation rather than money. */
  readonly exemptFromImpactFloor?: boolean;
  /**
   * §2.4's attributed set — `llmAttributedIds(snapshot)`.
   *
   * Passed by every rule and read by none of them: a rule hands it straight through
   * to this function, which is the only place that looks at it. That is what keeps
   * §7.5 true while making §2.4's "no silent authority" reachable — see the note on
   * `Snapshot.llmAttributedTransactionIds`.
   */
  readonly llmAttributed?: ReadonlySet<string>;
}

/**
 * The three emit-time policies every rule shares, applied in the order that makes
 * each one mean what §5.1 says.
 *
 * 1. **The `llm_dependent` cap** first, because it can move a finding into a band
 *    that then suppresses it — applying it after the band test would emit a
 *    High-band card for a finding that is only allowed to claim Medium.
 * 2. **Suppression** below the Low band, and the absolute annual impact floor.
 * 3. **The emission budget**: the top N by impact, plus one rollup for the rest.
 *
 * Sorting is by absolute impact because a rule may express a saving as a negative
 * number, and "the biggest ones" should not depend on which sign it chose.
 *
 * ## Where `llm_dependent` becomes true
 *
 * §2.4: "A finding whose evidence depends on any `source='llm'` alias or category
 * carries `llm_dependent = true`, is badged in the UI as resting on an AI-suggested
 * grouping, and has its confidence **capped at Medium**."
 *
 * "Whose evidence depends on" is the operative phrase and it is why this is decided
 * here rather than in each rule. Every draft already carries
 * `evidenceTransactionIds` — the explicit rows §5.1 materializes into
 * `finding_evidence` — so the test is an intersection against the set the snapshot
 * carried, and it is the same test for all nine rules. A rule computing it for
 * itself would be nine chances to forget, and forgetting is invisible: the finding
 * still emits, it just quietly claims High confidence on a model's say-so.
 *
 * A rule may still declare `llmDependent: true` on its own; the two are OR-ed. None
 * does today, and the field stays on `DraftFinding` because a future rule that
 * consumed an LLM-assigned *category* would have a reason to.
 */
export function applyEmissionPolicy(
  ruleId: string,
  drafts: readonly DraftFinding[],
  config: AnalyzerConfig,
  options: EmissionOptions = {},
): RuleEmission {
  const attributed = options.llmAttributed;

  const capped = drafts.map((draft) => {
    const llmDependent =
      draft.llmDependent ||
      (attributed !== undefined &&
        attributed.size > 0 &&
        draft.evidenceTransactionIds.some((id) => attributed.has(id)));

    return {
      ...draft,
      llmDependent,
      confidence: llmDependent
        ? Math.min(draft.confidence, config.global.llmDependentConfidenceCap)
        : draft.confidence,
    };
  });

  const admitted = capped
    .filter((draft) => bandFor(draft.confidence, config) !== 'suppressed')
    .filter(
      (draft) =>
        options.exemptFromImpactFloor === true ||
        Math.abs(draft.impactAnnualCents) >= config.global.minAnnualImpactCents,
    )
    .sort((a, b) => Math.abs(b.impactAnnualCents) - Math.abs(a.impactAnnualCents));

  const budget = config.global.maxFindingsPerRule;
  const kept = admitted.slice(0, budget);
  const dropped = admitted.slice(budget);

  const findings = kept.map((draft): Finding => ({
    ...draft,
    band: bandFor(draft.confidence, config),
    naturalKey: naturalKey(draft.ruleId, draft.subjectType, draft.subjectId),
  }));

  const rollup: FindingRollup | null =
    dropped.length === 0
      ? null
      : {
          ruleId,
          suppressedCount: dropped.length,
          belowAnnualCents: Math.abs(kept[kept.length - 1]?.impactAnnualCents ?? 0),
        };

  return { findings, rollup };
}
