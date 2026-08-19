/**
 * §6.4's top strip: "the three numbers that justify the app".
 *
 * 1. Active subscriptions and their monthly/annual total.
 * 2. **Total flagged annual savings** — `impact_kind = savings` only.
 * 3. Unreviewed finding count.
 *
 * Presentational, and every number arrives already computed. That is the point
 * rather than an economy: §5.1 admits only `savings` into the headline, and §7.3
 * forbids two findings claiming the same dollars, so the total is a judgement
 * about the *whole* finding set. The page holds one filtered page of rows and
 * could not compute it correctly even if it wanted to.
 *
 * The run's provenance sits under the numbers rather than being hidden, because
 * §7.6 makes every threshold in §5 uncalibrated: a headline with no indication of
 * when it was computed, over how many rows, and under which config invites being
 * read as a measurement.
 */

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { formatCents } from '@metrum/ledgerline-domain';
import type { FindingsSummary } from '@metrum/api-client';

@Component({
  selector: 'll-findings-summary',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let s = summary();
    <div class="strip">
      <div class="figure">
        <span class="figure__label">Active subscriptions</span>
        <span class="figure__value">{{ s ? s.subscriptions.activeCount : '—' }}</span>
        <span class="figure__sub">
          @if (s) {
            {{ formatCents(s.subscriptions.monthlyCents) }}/mo ·
            {{ formatCents(s.subscriptions.annualCents) }}/yr
          }
        </span>
      </div>

      <div class="figure figure--headline">
        <span
          class="figure__label"
          title="Only findings whose impact_kind is savings (§5.1, §7.3)."
        >
          Flagged annual savings
        </span>
        <span class="figure__value">{{ s ? formatCents(s.savingsAnnualCents) : '—' }}</span>
        <span class="figure__sub">
          @if (s) {
            {{ formatCents(s.savingsMonthlyCents) }}/mo · money that would stop leaving
          }
        </span>
      </div>

      <div class="figure">
        <span class="figure__label">Unreviewed</span>
        <span class="figure__value">{{ s ? s.unreviewedCount : '—' }}</span>
        <span class="figure__sub">
          @if (s) {
            of {{ s.activeFindingCount }} active
          }
        </span>
      </div>

      <div class="run">
        @if (s?.lastRunAt) {
          <span class="run__line">Last run {{ s!.lastRunAt }}</span>
          <span class="run__line">
            {{ s!.lastRunSnapshotRows }} rows · config
            <code>{{ s!.lastRunConfigHash?.slice(0, 8) }}</code>
          </span>
          @if (s!.lastRunConfigHash && s!.lastRunConfigHash !== s!.configHash) {
            <span class="run__stale">
              Thresholds have changed since this run — re-run to re-score.
            </span>
          }
        } @else {
          <span class="run__line">Never run.</span>
        }
        <button type="button" class="run__button" (click)="runRequested.emit()" [disabled]="busy()">
          {{ busy() ? 'Running…' : 'Run analysis' }}
        </button>
      </div>
    </div>
  `,
  styleUrl: './findings-summary.scss',
})
export class FindingsSummaryStrip {
  readonly summary = input<FindingsSummary | null>(null);
  readonly busy = input(false);

  readonly runRequested = output<void>();

  protected readonly formatCents = formatCents;
}
