/**
 * §6.4's inline evidence: "a compact charge history or mini-table, **not a link
 * to go find it**."
 *
 * ## Where the evidence comes from, and why not from the transactions
 *
 * Every `Finding` carries `evidenceTransactionIds`, and the obvious reading is
 * that this component should fetch those rows. It deliberately does not. Each
 * rule's `detail` payload already carries the numbers that *make* the finding —
 * `price_creep.v1` ships every step with its dates, cents, percent and
 * annualized impact; `duplicate.v1` ships the per-series annual costs; `lapsed.v1`
 * ships the silence in days against the account's coverage end. Those are the
 * facts §6.4 wants on the card, and they arrive with the finding.
 *
 * Fetching the transactions instead would be both worse and more expensive:
 * `ListTransactionsQuery` has no by-ids filter, so a card would issue one
 * `GET /api/transactions/:id` per evidence row — a twelve-charge series is twelve
 * requests to rebuild a history the rule already summarised. Adding that filter
 * is a contract change and a client regeneration, not a UI decision, and nothing
 * on this page needs it. `evidenceTransactionIds` is still carried through to the
 * DOM as a count, because "12 charges" is the reassurance that the number came
 * from somewhere.
 *
 * ## The renderer is a pure function over `detail`
 *
 * `detail` is `Record<string, unknown>` on the wire — the API serializes each
 * rule's own payload without a per-rule schema. Rather than cast it to five
 * different shapes and trust the cast, `evidenceFor` reads it defensively and
 * returns rows it could actually build. A rule that changes its payload loses a
 * line from a card; it does not throw inside a template.
 */

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { formatCents } from '@metrum/ledgerline-domain';
import type { Finding } from '@metrum/api-client';

/** One line of the mini-table. `value` is pre-formatted because the formatting
 *  rule differs per row — money through `formatCents`, dates as ISO, counts bare. */
export interface EvidenceRow {
  readonly label: string;
  readonly value: string;
  /** Money that went up is worth colouring; nothing else on the card is. */
  readonly tone?: 'up' | 'down';
}

export interface Evidence {
  readonly caption: string;
  readonly rows: readonly EvidenceRow[];
}

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

/**
 * The evidence for one finding, by rule.
 *
 * Exported and pure so the page's spec can assert on the numbers without going
 * through the DOM, the same way `virtual-window.ts` and `review-warnings.ts` are
 * separated from their components.
 */
export function evidenceFor(finding: Finding): Evidence {
  const detail = finding.detail;

  switch (finding.ruleId) {
    case 'price_creep.v1':
      return priceCreepEvidence(detail);
    case 'duplicate.v1':
      return duplicateEvidence(detail);
    case 'trial.v1':
      return trialEvidence(detail);
    case 'lapsed.v1':
      return lapsedEvidence(detail);
    case 'recurrence.v1':
      return recurrenceEvidence(detail);
    default:
      return { caption: 'Detail', rows: [] };
  }
}

/** §5.5's cumulative line is the one that lands — "$8.99 → $15.49 since 2023,
 *  +72%, $78/yr more than when you signed up" — so it leads, and the individual
 *  steps follow it. */
function priceCreepEvidence(detail: Record<string, unknown>): Evidence {
  const rows: EvidenceRow[] = [];

  const first = asNumber(detail['firstCents']);
  const current = asNumber(detail['currentCents']);
  const since = asString(detail['since']);
  const percent = asNumber(detail['cumulativePercent']);

  if (first !== null && current !== null) {
    const change = percent === null ? '' : ` · ${percent > 0 ? '+' : ''}${percent}%`;
    rows.push({
      label: since ? `Since ${since}` : 'Since the first charge',
      value: `${formatCents(first)} → ${formatCents(current)}${change}`,
      tone: current > first ? 'up' : 'down',
    });
  }

  for (const raw of asArray(detail['steps'])) {
    const step = asRecord(raw);
    const from = asNumber(step['fromCents']);
    const to = asNumber(step['toCents']);
    const at = asString(step['at']);
    const annualised = asNumber(step['annualisedCents']);
    if (from === null || to === null) continue;

    const annual = annualised === null ? '' : ` (${formatCents(annualised)}/yr)`;
    const unconfirmed =
      step['confirmed'] === false ? ' · unconfirmed, one charge at the new price' : '';
    rows.push({
      label: at ?? 'Step',
      value: `${formatCents(from)} → ${formatCents(to)}${annual}${unconfirmed}`,
      tone: to > from ? 'up' : 'down',
    });
  }

  return { caption: 'Price history', rows };
}

function duplicateEvidence(detail: Record<string, unknown>): Evidence {
  const rows: EvidenceRow[] = [];
  const kind = asString(detail['kind']);

  if (kind === 'same_merchant') {
    const costs = asArray(detail['annualCentsEach'])
      .map(asNumber)
      .filter((cost): cost is number => cost !== null)
      .sort((a, b) => a - b);
    costs.forEach((cost, index) => {
      rows.push({ label: `Plan ${index + 1}`, value: `${formatCents(cost)}/yr` });
    });

    const cheapest = asNumber(detail['cheapestAnnualCents']);
    if (cheapest !== null) {
      // §5.4: the impact is the cheaper series' cost, because one of the two
      // plans is presumably wanted. Saying so on the card stops the number
      // reading like a mistake.
      rows.push({
        label: 'If you cancel one',
        value: `${formatCents(cheapest)}/yr back`,
        tone: 'down',
      });
    }
    return { caption: 'Concurrent plans at this merchant', rows };
  }

  const monthly = asNumber(detail['monthlyCents']);
  const annual = asNumber(detail['annualCents']);
  const count = asArray(detail['seriesIds']).length;
  if (count > 0) rows.push({ label: 'Subscriptions', value: String(count) });
  if (monthly !== null) rows.push({ label: 'Together', value: `${formatCents(monthly)}/mo` });
  if (annual !== null) rows.push({ label: 'Annual', value: `${formatCents(annual)}/yr` });

  return { caption: 'Overlapping services', rows };
}

function trialEvidence(detail: Record<string, unknown>): Evidence {
  const rows: EvidenceRow[] = [];

  const signals = asArray(detail['signals'])
    .map(asString)
    .filter((signal): signal is string => signal !== null)
    .map((signal) => signal.replace(/_/g, ' '));
  if (signals.length > 0) rows.push({ label: 'Signals', value: signals.join(' · ') });

  const first = asString(detail['firstChargeAt']);
  if (first) rows.push({ label: 'First real charge', value: first });

  const annual = asNumber(detail['annualCents']);
  if (annual !== null) rows.push({ label: 'Costs', value: `${formatCents(annual)}/yr` });

  // §5.6's stated limitation travels on the finding rather than being hidden.
  const limitation = asString(detail['limitation']);
  if (limitation) rows.push({ label: 'Caveat', value: limitation });

  return { caption: 'Why this looks like a trial', rows };
}

function lapsedEvidence(detail: Record<string, unknown>): Evidence {
  const rows: EvidenceRow[] = [];

  const last = asString(detail['lastChargeAt']);
  const coverage = asString(detail['coverageEnd']);
  const silent = asNumber(detail['silentDays']);
  const every = asNumber(detail['expectedEvery']);
  const former = asNumber(detail['formerMonthlyCents']);

  if (last) rows.push({ label: 'Last charge', value: last });
  if (every !== null) rows.push({ label: 'Was billing', value: `every ~${every} days` });
  if (silent !== null && coverage) {
    // §7.2: measured against the account's own coverage end, never the clock.
    rows.push({ label: 'Silent for', value: `${silent} days, to ${coverage}` });
  }
  if (former !== null) {
    rows.push({ label: 'Was costing', value: `${formatCents(former)}/mo`, tone: 'down' });
  }

  return { caption: 'Appears cancelled', rows };
}

function recurrenceEvidence(detail: Record<string, unknown>): Evidence {
  const rows: EvidenceRow[] = [];

  const active = asNumber(detail['activeCount']);
  const lapsed = asNumber(detail['lapsedCount']);
  const monthly = asNumber(detail['monthlyCents']);
  const annual = asNumber(detail['annualCents']);

  if (active !== null) rows.push({ label: 'Active', value: String(active) });
  if (lapsed !== null && lapsed > 0) rows.push({ label: 'Lapsed', value: String(lapsed) });
  if (monthly !== null) rows.push({ label: 'Monthly', value: formatCents(monthly) });
  if (annual !== null) rows.push({ label: 'Annual', value: formatCents(annual) });

  /**
   * One row, not one per cadence.
   *
   * A row per cadence collides with the money above it: `byCadence` has an
   * `annual` key and the totals have an `Annual` label, so the card showed
   * "Annual $1,789.06" and "annual 4" two lines apart, meaning different things.
   * Folding the breakdown into a single value removes the collision rather than
   * renaming around it.
   */
  const cadences = Object.entries(asRecord(detail['byCadence']))
    .map(([cadence, count]) => {
      const value = asNumber(count);
      return value === null ? null : `${value} ${cadence.replace(/_/g, ' ')}`;
    })
    .filter((entry): entry is string => entry !== null);

  if (cadences.length > 0) rows.push({ label: 'By cadence', value: cadences.join(' · ') });

  return { caption: 'Subscriptions', rows };
}

@Component({
  selector: 'll-finding-evidence',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let ev = evidence();
    @if (ev.rows.length > 0) {
      <div class="evidence">
        <h4 class="evidence__caption">
          {{ ev.caption }}
          @if (chargeCount() > 0) {
            <span class="evidence__count">
              {{ chargeCount() }} {{ chargeCount() === 1 ? 'charge' : 'charges' }}
            </span>
          }
        </h4>
        <dl class="evidence__rows">
          @for (row of ev.rows; track $index) {
            <dt class="evidence__label">{{ row.label }}</dt>
            <dd
              class="evidence__value"
              [class.evidence__value--up]="row.tone === 'up'"
              [class.evidence__value--down]="row.tone === 'down'"
            >
              {{ row.value }}
            </dd>
          }
        </dl>
      </div>
    }
  `,
  styleUrl: './finding-evidence.scss',
})
export class FindingEvidence {
  readonly finding = input.required<Finding>();

  protected readonly evidence = computed(() => evidenceFor(this.finding()));
  protected readonly chargeCount = computed(() => this.finding().evidenceTransactionIds.length);
}
