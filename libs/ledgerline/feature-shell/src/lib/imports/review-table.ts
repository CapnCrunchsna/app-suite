/**
 * §6.1's Review table: "parsed rows with the raw source line available per row,
 * exact duplicates greyed with an 'already imported' tag and a count summary,
 * near-duplicates (§3.3) shown as an explicit three-way choice against the row
 * they resemble."
 *
 * Presentational. It renders what `GET /api/imports/:id` returned and emits the
 * one decision it collects; nothing here is committed and nothing is fetched.
 *
 * ## The three dispositions are three different claims, and look like it
 *
 * **`duplicate`** is the multiset merge rule (§3.3) having already decided: the
 * account holds as many rows with this key as the file does, so this one will be
 * absorbed. It is greyed and tagged rather than hidden, because "18 of 52 rows
 * already present" is only checkable if the 18 are on screen.
 *
 * **`near_duplicate`** is the pass that runs *after* the merge and deliberately
 * resolves nothing on its own: a re-issued amount, a pending charge that posted,
 * or one month exported twice with different date columns all hash differently
 * and are all the same transaction. §3.3 requires "both rows shown" and a choice
 * of *replace · keep both · skip*, so the existing row is rendered beside the
 * incoming one — and `NearDuplicateCandidate` carries its date, amount,
 * descriptor and pending flag precisely so this needs no second fetch.
 *
 * **`insert`** is everything else.
 *
 * The default resolution comes from the API and is pre-selected, never applied:
 * §3.3 defaults pending-to-posted to *replace* and everything else to *keep
 * both*, "because over-counting is visible and losing a real transaction is not".
 * A pre-selected default is a starting point the reviewer can see and change; a
 * silently applied one is the automatic resolution that section forbids.
 */

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { formatCents } from '@metrum/ledgerline-domain';
import type { NearDuplicateCandidate, ReviewRow } from '@metrum/api-client';

export type Resolution = 'replace' | 'keep_both' | 'skip';

export interface ResolutionChange {
  readonly rowIndex: number;
  readonly resolution: Resolution;
}

const RESOLUTIONS: readonly { value: Resolution; label: string; hint: string }[] = [
  {
    value: 'replace',
    label: 'Replace',
    hint: 'Drop the existing row and keep this one. What a pending charge that has now posted needs.',
  },
  {
    value: 'keep_both',
    label: 'Keep both',
    hint: 'They are two real transactions. Over-counting is visible; a lost transaction is not.',
  },
  { value: 'skip', label: 'Skip', hint: 'Do not insert this row. The existing one stands.' },
];

@Component({
  selector: 'll-review-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './review-table.html',
  styleUrl: './review-table.scss',
})
export class ReviewTable {
  readonly rows = input<readonly ReviewRow[]>([]);
  readonly nearDuplicates = input<readonly NearDuplicateCandidate[]>([]);
  readonly resolutions = input<ReadonlyMap<number, Resolution>>(new Map());
  /** Row indexes the warning strip is pointing at, so the two agree on screen. */
  readonly flaggedRows = input<ReadonlySet<number>>(new Set<number>());
  readonly expandedRow = input<number | null>(null);

  readonly resolutionChanged = output<ResolutionChange>();
  readonly rowToggled = output<number>();

  protected readonly formatCents = formatCents;
  protected readonly RESOLUTIONS = RESOLUTIONS;

  protected readonly candidatesByRow = computed(
    () => new Map(this.nearDuplicates().map((candidate) => [candidate.rowIndex, candidate])),
  );

  protected candidateFor(rowIndex: number): NearDuplicateCandidate | undefined {
    return this.candidatesByRow().get(rowIndex);
  }

  protected resolutionFor(rowIndex: number): Resolution {
    return this.resolutions().get(rowIndex) ?? 'keep_both';
  }

  /** §3.3's own reason for the default, said where the choice is made. */
  protected whyDefault(candidate: NearDuplicateCandidate): string {
    return candidate.pendingToPosted
      ? 'The existing row is pending and this one is posted, so replace is the default.'
      : 'Not a pending-to-posted pair, so keep both is the default — over-counting is visible ' +
          'and losing a real transaction is not.';
  }

  protected gapLabel(candidate: NearDuplicateCandidate): string {
    const days = Math.abs(candidate.dayGap);
    const delta = candidate.amountDeltaCents;
    const dayPart = days === 0 ? 'same day' : `${days} ${days === 1 ? 'day' : 'days'} apart`;
    const amountPart =
      delta === 0 ? 'same amount' : `${formatCents(Math.abs(delta))} apart in amount`;
    return `${dayPart} · ${amountPart}`;
  }
}
