/**
 * §6.2, the Accounts page.
 *
 * "List of accounts with type, institution, last4, transaction count, and a
 * **coverage bar** [...] Actions: rename, set type, merge two accounts, archive.
 * The **Possible Transfers** queue lives here (§2.6)."
 *
 * Same split as the other three pages: the container owns all state and every
 * request, the children are presentational, `resource()` for reads, and
 * `LedgerlineApiService` is the one seam to the API.
 *
 * ## Why the queue is on this page and not its own
 *
 * §2.6 splits its matches three ways and only one of them is silent. A score at
 * or above the auto threshold links without asking; a score in the propose band
 * "appears in a Possible Transfers queue on the Accounts page and is *not*
 * excluded from spend until confirmed". Shipping the matcher without somewhere
 * for that middle band to appear would let proposals accumulate where nobody can
 * see them — which is precisely the "nowhere to appear" mistake §6.4 was built to
 * correct. So the queue leads the page: it is the part with a decision waiting in
 * it, and the coverage bars below it are the part you read to know how much to
 * trust anything.
 *
 * ## Every write on this page moves a number somewhere else
 *
 * Confirming a transfer takes its debit total out of every spend figure on §6.4
 * and §6.6; rejecting an auto-link puts it back; a merge re-points a whole
 * account's history. So each one states its effect before it happens — the queue
 * carries `spendReductionCents` on the card, the merge editor names both accounts
 * and says there is no undo — and each one is reversible by its counterpart,
 * except the merge, which §3.2's RESTRICT makes final.
 *
 * ## One coverage request per account, and why that is fine
 *
 * `GET /api/accounts/:id/coverage` is per-account by §2.3, so a household with
 * six accounts makes six requests. They are issued together rather than in
 * sequence, each is a two-query read over an indexed column, and the alternative
 * — a batch endpoint §2.3 does not have — would be inventing API surface to save
 * five loopback round trips.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  resource,
  signal,
} from '@angular/core';
import { Panel } from '@metrum/ui';
import { formatCents } from '@metrum/ledgerline-domain';
import { LedgerlineApiError } from '@metrum/api-client';
import type { Account, AccountCoverage, TransferLink } from '@metrum/api-client';

import { LedgerlineApiService } from '../ledgerline-api.service.js';
import { AccountCard } from './account-card.js';
import type { AccountActionEvent } from './account-card.js';
import { TransferQueue } from './transfer-queue.js';
import type { TransferDecisionEvent } from './transfer-queue.js';

@Component({
  selector: 'll-accounts-page',
  imports: [Panel, AccountCard, TransferQueue],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './accounts-page.html',
  styleUrl: './accounts-page.scss',
})
export class AccountsPage {
  private readonly api = inject(LedgerlineApiService);

  // ------------------------------------------------------------- state ---

  protected readonly notice = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly scanning = signal(false);
  /** Off by default: §6.2's archive exists to get an account out of the way, and
   *  a list that shows them anyway has not archived anything. */
  protected readonly showArchived = signal(false);

  /** Bumped after a write so the page re-reads rather than patching rows it
   *  believes it knows the new state of — a confirm changes two transactions, an
   *  account's coverage, and the queue. */
  private readonly revision = signal(0);

  // -------------------------------------------------------------- data ---

  private readonly accountList = resource({
    params: () => this.revision(),
    loader: () => this.api.listAccounts(),
    defaultValue: [] as Account[],
  });

  /**
   * §6.2's queue, plus the auto-links.
   *
   * Both states, because §2.6 auto-links silently and silence is the risk it
   * accepts. A queue showing only proposals would leave the half that already
   * moved money unreviewable.
   */
  private readonly transferList = resource({
    params: () => this.revision(),
    loader: () => this.api.listTransfers({ states: 'proposed,auto' }),
    defaultValue: [] as TransferLink[],
  });

  /** One request per account, issued together. See the header. */
  private readonly coverageList = resource({
    params: () => ({ revision: this.revision(), ids: this.accountIds() }),
    loader: async ({ params }) =>
      Promise.all(params.ids.map((id) => this.api.getAccountCoverage(id))),
    defaultValue: [] as AccountCoverage[],
  });

  private readonly accountIds = computed(() =>
    this.accountList.value().map((account) => account.id),
  );

  protected readonly accounts = computed(() =>
    this.accountList
      .value()
      .filter((account) => this.showArchived() || account.isActive),
  );

  protected readonly archivedCount = computed(
    () => this.accountList.value().filter((account) => !account.isActive).length,
  );

  private readonly coverageById = computed(
    () => new Map(this.coverageList.value().map((entry) => [entry.accountId, entry])),
  );

  protected coverageFor(account: Account): AccountCoverage | null {
    return this.coverageById().get(account.id) ?? null;
  }

  /** Everything except this account, and never an archived one — merging an
   *  archived account into another is a repair of a repair, and offering it
   *  invites doing it twice. */
  protected mergeCandidatesFor(account: Account): Account[] {
    return this.accountList
      .value()
      .filter((candidate) => candidate.id !== account.id && candidate.isActive);
  }

  protected readonly transfers = computed(() => this.transferList.value());

  protected readonly proposedCount = computed(
    () => this.transfers().filter((link) => link.state === 'proposed').length,
  );

  /**
   * What the queue is holding back from the totals, in integer cents (§7.3).
   *
   * Proposals only. An auto-link has already left the totals, so adding it here
   * would state the outstanding difference at more than it is — and this number's
   * whole job is to say how wrong the Findings page currently is.
   */
  protected readonly pendingCents = computed(() =>
    this.transfers()
      .filter((link) => link.state === 'proposed')
      .reduce((total, link) => total + link.spendReductionCents, 0),
  );

  protected readonly formatCents = formatCents;

  protected readonly loading = computed(
    () => this.accountList.isLoading() || this.transferList.isLoading(),
  );

  protected readonly failure = computed(() => this.accountList.error());

  // ----------------------------------------------------------- handlers ---

  /** §6.2's four account actions, routed. Rename and set-type are one PATCH;
   *  archive is `isActive: false`, which §6.2 makes the destructive action; merge
   *  is its own endpoint because it re-points four tables. */
  protected async onAccountAction(event: AccountActionEvent): Promise<void> {
    const { account, action } = event;

    switch (action.kind) {
      case 'rename':
        await this.write(async () => {
          await this.api.updateAccount(account.id, { displayName: action.displayName });
          this.notice.set(`Renamed to "${action.displayName}".`);
        });
        return;

      case 'set_type':
        await this.write(async () => {
          await this.api.updateAccount(account.id, { accountType: action.accountType });
          this.notice.set(
            `${account.displayName} is now a ${action.accountType.replace('_', ' ')}. ` +
              'Transfer matching scores a credit card differently, so re-run the scan below.',
          );
        });
        return;

      case 'archive':
        await this.write(async () => {
          await this.api.updateAccount(account.id, { isActive: action.isActive });
          this.notice.set(
            action.isActive
              ? `${account.displayName} is active again.`
              : `${account.displayName} is archived. Its history stays in every finding — ` +
                  'archiving hides the account, it does not remove the transactions.',
          );
        });
        return;

      case 'merge': {
        const source = this.accountList
          .value()
          .find((candidate) => candidate.id === action.sourceAccountId);
        await this.write(async () => {
          const result = await this.api.mergeAccount(account.id, {
            sourceAccountId: action.sourceAccountId,
          });
          this.notice.set(
            `Moved ${result.transactionsMoved} ` +
              `${result.transactionsMoved === 1 ? 'transaction' : 'transactions'} and ` +
              `${result.importsMoved} ${result.importsMoved === 1 ? 'statement' : 'statements'} ` +
              `from ${source?.displayName ?? 'the other account'} into ${account.displayName}` +
              (result.selfLinksRemoved > 0
                ? `, and unlinked ${result.selfLinksRemoved} transfer` +
                  `${result.selfLinksRemoved === 1 ? '' : 's'} that turned out to be inside one ` +
                  'account.'
                : '.') +
              ' Rows both accounts held are still two rows — delete the redundant import to ' +
              'resolve them.',
          );
        });
        return;
      }
    }
  }

  /**
   * §2.6's confirm and reject.
   *
   * The notice names the money in both directions, because both directions move
   * it: confirming takes the debit out of every spend total, rejecting an
   * auto-link puts it back. Neither is a preference about how a row is filed.
   */
  protected async onTransferDecision(event: TransferDecisionEvent): Promise<void> {
    const { link, decision } = event;
    const amount = link.spendReductionCents;

    await this.write(async () => {
      if (decision === 'confirm') {
        await this.api.confirmTransfer(link.id);
        this.notice.set(
          `Linked. ${formatCents(amount)} is out of your spending totals, and this pairing will ` +
            'link itself next time. Reject it to undo.',
        );
      } else {
        await this.api.rejectTransfer(link.id);
        this.notice.set(
          link.state === 'auto'
            ? `Unlinked. ${formatCents(amount)} counts as spending again, and this pair will not ` +
                'be offered a second time.'
            : 'Rejected. This pair will not be offered again; the money was never taken out of ' +
                'your totals.',
        );
      }
    });
  }

  /** §2.3's `POST /api/transfers/propose`, run on demand — after an import, or
   *  after changing an account's type or last4, both of which change the score. */
  protected async scan(): Promise<void> {
    this.scanning.set(true);
    this.notice.set(null);
    try {
      const result = await this.api.proposeTransfers();
      this.notice.set(
        `${result.autoLinked} linked automatically, ${result.proposed} to review` +
          (result.withdrawn > 0 ? `, ${result.withdrawn} withdrawn` : '') +
          '.',
      );
      this.revision.update((value) => value + 1);
    } catch (cause) {
      this.report(cause, 'Could not scan for transfers');
    } finally {
      this.scanning.set(false);
    }
  }

  protected toggleArchived(): void {
    this.showArchived.update((value) => !value);
  }

  /** One place a write happens, so one place that clears busy, re-reads, and
   *  turns a failure into something a user can read. */
  private async write(action: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    try {
      await action();
      this.revision.update((value) => value + 1);
    } catch (cause) {
      this.report(cause, 'That did not apply');
    } finally {
      this.busy.set(false);
    }
  }

  /** Branching on `error.code` rather than on prose — the code is documented as
   *  stable, the message may be reworded. */
  private report(cause: unknown, prefix: string): void {
    if (cause instanceof LedgerlineApiError && cause.code === 'not_found') {
      this.notice.set('That is gone — the last scan withdrew it. Reloading.');
      this.revision.update((value) => value + 1);
      return;
    }
    this.notice.set(`${prefix}: ${(cause as Error).message}`);
  }

  protected dismissNotice(): void {
    this.notice.set(null);
  }

  protected reload(): void {
    this.revision.update((value) => value + 1);
  }
}
