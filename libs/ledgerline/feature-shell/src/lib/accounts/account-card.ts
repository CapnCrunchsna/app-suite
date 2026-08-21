/**
 * One account, its coverage bar, and §6.2's four actions.
 *
 * "List of accounts with type, institution, last4, transaction count, and a
 * **coverage bar** [...] Actions: rename, set type, merge two accounts, archive."
 *
 * Presentational: it holds the state of its own editor — which field is open,
 * what has been typed — and emits what the user decided. Every request belongs to
 * the page.
 *
 * ## Merge and archive are confirmed, rename and set-type are not
 *
 * Rename and set-type are `PATCH /api/accounts/:id` and are undone by doing them
 * again. Archive removes the account from the pickers, and a merge re-points
 * every transaction and import in one irreversible sweep — §3.2 RESTRICTs the
 * delete, so there is no undo to offer afterwards. Both therefore state what will
 * happen before it happens, with the transaction count in the sentence.
 */

import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { Account, AccountCoverage } from '@metrum/api-client';

import { CoverageBar } from './coverage-bar.js';

export type AccountType = Account['accountType'];

export type AccountAction =
  | { readonly kind: 'rename'; readonly displayName: string }
  | { readonly kind: 'set_type'; readonly accountType: AccountType }
  | { readonly kind: 'archive'; readonly isActive: boolean }
  | { readonly kind: 'merge'; readonly sourceAccountId: string };

export interface AccountActionEvent {
  readonly account: Account;
  readonly action: AccountAction;
}

export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  checking: 'Checking',
  savings: 'Savings',
  credit_card: 'Credit card',
};

@Component({
  selector: 'll-account-card',
  imports: [CoverageBar],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './account-card.html',
  styleUrl: './account-card.scss',
})
export class AccountCard {
  readonly account = input.required<Account>();
  readonly coverage = input<AccountCoverage | null>(null);
  /** Every other account, for the merge picker. The page supplies it; the card
   *  does not go looking. */
  readonly mergeCandidates = input<readonly Account[]>([]);
  readonly busy = input(false);

  readonly acted = output<AccountActionEvent>();

  protected readonly types: readonly AccountType[] = ['checking', 'savings', 'credit_card'];
  protected readonly typeLabel = ACCOUNT_TYPE_LABEL;

  /** Which editor is open. One at a time, because two open forms on one card is
   *  two things to read before deciding anything. */
  protected readonly editing = signal<'none' | 'name' | 'type' | 'merge'>('none');
  protected readonly draftName = signal('');
  protected readonly mergeSource = signal('');

  protected readonly subtitle = computed(() => {
    const account = this.account();
    return [
      ACCOUNT_TYPE_LABEL[account.accountType],
      account.institution,
      account.last4 ? `••${account.last4}` : null,
    ]
      .filter((part): part is string => Boolean(part))
      .join(' · ');
  });

  protected readonly transactionCount = computed(() => this.coverage()?.transactionCount ?? null);

  protected readonly mergeTarget = computed(() =>
    this.mergeCandidates().find((candidate) => candidate.id === this.mergeSource()),
  );

  protected openName(): void {
    this.draftName.set(this.account().displayName);
    this.editing.set('name');
  }

  protected openType(): void {
    this.editing.set('type');
  }

  protected openMerge(): void {
    this.mergeSource.set('');
    this.editing.set('merge');
  }

  protected close(): void {
    this.editing.set('none');
  }

  protected submitName(): void {
    const displayName = this.draftName().trim();
    // An empty rename is not a rename; the API's `minLength: 1` would refuse it
    // and there is nothing to tell the user that they did not already know.
    if (displayName === '' || displayName === this.account().displayName) {
      this.close();
      return;
    }
    this.emit({ kind: 'rename', displayName });
  }

  protected submitType(accountType: AccountType): void {
    if (accountType === this.account().accountType) {
      this.close();
      return;
    }
    this.emit({ kind: 'set_type', accountType });
  }

  protected submitMerge(): void {
    const sourceAccountId = this.mergeSource();
    if (sourceAccountId === '') return;
    this.emit({ kind: 'merge', sourceAccountId });
  }

  protected toggleArchive(): void {
    this.emit({ kind: 'archive', isActive: !this.account().isActive });
  }

  protected onNameInput(event: Event): void {
    this.draftName.set((event.target as HTMLInputElement).value);
  }

  protected onMergeSelect(event: Event): void {
    this.mergeSource.set((event.target as HTMLSelectElement).value);
  }

  private emit(action: AccountAction): void {
    this.editing.set('none');
    this.acted.emit({ account: this.account(), action });
  }
}
