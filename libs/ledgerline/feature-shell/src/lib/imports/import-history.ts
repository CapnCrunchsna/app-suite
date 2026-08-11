/**
 * §6.1's last line: "Below: import history with re-parse and delete. Re-parse is
 * refused on a committed import; delete removes only the rows for which this
 * import is the last remaining source."
 *
 * Presentational — it emits three intents and the page makes the calls.
 *
 * ## Re-parse stays clickable on a committed import
 *
 * The API answers `409 already_committed`, and that refusal is *information*: it
 * says the rows are in the transaction table and re-parsing them is not a thing
 * that can happen, only deleting and re-importing. A hidden button would leave the
 * reviewer looking for a control that is absent for a reason nobody stated. So the
 * button is offered and the API's own message is what comes back.
 *
 * ## Delete is a two-step, and it says what it will keep
 *
 * §3.3 makes `transaction_source` many-to-many, so deleting the first of two
 * overlapping imports must not take the rows the second still contains. The result
 * reports both lists, and the page repeats them — a delete that quietly kept rows
 * looks identical to a delete that quietly removed too few.
 */

import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { Account, StatementImport } from '@metrum/api-client';

@Component({
  selector: 'll-import-history',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ul class="history">
      @for (record of imports(); track record.id) {
        <li
          class="history__row"
          [class.history__row--selected]="record.id === selectedId()"
          [class.history__row--failed]="record.status === 'failed'"
        >
          <button type="button" class="history__name" (click)="reviewed.emit(record.id)">
            {{ record.sourceFilename }}
          </button>

          <span class="history__status" [attr.data-status]="record.status">
            {{ record.status.replace('_', ' ') }}
          </span>

          <span class="history__account">{{ accountName(record.accountId) }}</span>

          <span class="history__period">
            @if (record.periodStart && record.periodEnd) {
              {{ record.periodStart }} → {{ record.periodEnd }}
            } @else {
              period unknown
            }
          </span>

          <span class="history__counts" [title]="countsTitle(record)">
            {{ record.rowsParsed }} parsed · {{ record.rowsInserted }} inserted ·
            {{ record.rowsDuplicate }} already present
          </span>

          <span class="history__actions">
            <button
              type="button"
              class="history__action"
              (click)="reparsed.emit(record.id)"
              [disabled]="busy()"
              title="Parse the stored bytes again under the current profile. Refused once committed."
            >
              Re-parse
            </button>

            @if (confirming() === record.id) {
              <button
                type="button"
                class="history__action history__action--danger"
                (click)="confirmDelete(record.id)"
                [disabled]="busy()"
              >
                Really delete
              </button>
              <button type="button" class="history__action" (click)="confirming.set(null)">
                Cancel
              </button>
            } @else {
              <button
                type="button"
                class="history__action"
                (click)="confirming.set(record.id)"
                [disabled]="busy()"
                title="Removes only the rows this import is the last remaining source for (§3.3)."
              >
                Delete
              </button>
            }
          </span>
        </li>
      } @empty {
        <li class="history__empty">Nothing imported yet.</li>
      }
    </ul>
  `,
  styleUrl: './import-history.scss',
})
export class ImportHistory {
  readonly imports = input<readonly StatementImport[]>([]);
  readonly accounts = input<readonly Account[]>([]);
  readonly selectedId = input<string | null>(null);
  readonly busy = input(false);

  readonly reviewed = output<string>();
  readonly reparsed = output<string>();
  readonly deleted = output<string>();

  protected readonly confirming = signal<string | null>(null);

  private readonly accountsById = computed(
    () => new Map(this.accounts().map((account) => [account.id, account])),
  );

  protected accountName(accountId: string | null): string {
    if (!accountId) return 'no account yet';
    return this.accountsById().get(accountId)?.displayName ?? accountId;
  }

  protected countsTitle(record: StatementImport): string {
    return (
      `${record.rowsDuplicate} rows were absorbed by §3.3's multiset merge rule — ` +
      'the account already held that many with the same key.'
    );
  }

  protected confirmDelete(id: string): void {
    this.confirming.set(null);
    this.deleted.emit(id);
  }
}
