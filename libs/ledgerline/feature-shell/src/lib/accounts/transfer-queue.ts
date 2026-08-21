/**
 * §6.2's Possible Transfers queue.
 *
 * "The **Possible Transfers** queue lives here (§2.6): proposed pairs with both
 * rows, the score's reasons, and the dollar effect of confirming."
 *
 * All three of those are requirements about what a human needs in front of them
 * before they take money out of every total, and each is load-bearing:
 *
 * - **Both rows**, because "is this $500 a transfer" is unanswerable without
 *   seeing what the other side says. The page hands them over already fetched.
 * - **The score's reasons**, because a queue of unexplained pairs gets confirmed
 *   by reflex — and confirming by reflex is §2.6's false-link path with extra
 *   steps. The reasons are the matcher's own, recorded when it proposed the pair,
 *   not re-derived against a snapshot that has since moved.
 * - **The dollar effect**, stated before the button is pressed, because this is
 *   the moment the number on §6.4 changes.
 *
 * ## Why the auto-linked pairs are shown too
 *
 * §2.6 auto-links the unambiguous case silently, and silence is the whole risk it
 * accepts: "a false link removes money from every total invisibly." A queue that
 * showed only proposals would make the silent half unreviewable. So the queue
 * carries them under their own heading with a Reject that undoes the link — which
 * is what makes the invisible removal visible and reversible.
 *
 * Presentational. Every request belongs to the page.
 */

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { formatCents } from '@metrum/ledgerline-domain';
import type { TransferLink } from '@metrum/api-client';

export type TransferDecision = 'confirm' | 'reject';

export interface TransferDecisionEvent {
  readonly link: TransferLink;
  readonly decision: TransferDecision;
}

@Component({
  selector: 'll-transfer-queue',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (links().length === 0) {
      <p class="queue__empty">
        @if (loading()) {
          Looking for transfers…
        } @else {
          Nothing to review. A pair scoring at or above the auto threshold is linked without
          asking; anything less certain lands here and keeps counting as spending until you
          confirm it.
        }
      </p>
    } @else {
      <ul class="queue">
        @for (link of links(); track link.id) {
          <li class="pair" [class.pair--auto]="link.state === 'auto'">
            <header class="pair__head">
              <span class="pair__amount">{{ formatCents(link.amountCents) }}</span>
              <span class="pair__state" [class.pair__state--auto]="link.state === 'auto'">
                {{ link.state === 'auto' ? 'Linked automatically' : 'Awaiting your decision' }}
              </span>
              @if (link.kind === 'partial') {
                <span class="pair__kind" title="Spec 2.6’s partial-payment pass never auto-links.">
                  split into {{ link.debits.length }}
                </span>
              }
              <span class="pair__score">score {{ link.score }}</span>
            </header>

            <div class="rows">
              @for (debit of link.debits; track debit.id) {
                <div class="row">
                  <span class="row__date">{{ debit.effectiveDate }}</span>
                  <span class="row__account">{{ link.debitAccount?.displayName ?? '—' }}</span>
                  <span class="row__descriptor">{{ debit.descriptionRaw }}</span>
                  <span class="row__amount">{{ formatCents(debit.amountCents) }}</span>
                </div>
              }
              <div class="row row--credit">
                <span class="row__date">{{ link.credit.effectiveDate }}</span>
                <span class="row__account">{{ link.creditAccount?.displayName ?? '—' }}</span>
                <span class="row__descriptor">{{ link.credit.descriptionRaw }}</span>
                <span class="row__amount">{{ formatCents(link.credit.amountCents) }}</span>
              </div>
            </div>

            @if (link.reasons.length > 0) {
              <ul class="reasons">
                @for (reason of link.reasons; track reason.signal) {
                  <li class="reason" [class.reason--negative]="reason.points < 0">
                    <span class="reason__points">
                      {{ reason.points > 0 ? '+' : '' }}{{ reason.points }}
                    </span>
                    {{ reason.detail }}
                  </li>
                }
              </ul>
            } @else {
              <p class="reasons reasons--none">No reasons were recorded for this pair.</p>
            }

            <footer class="pair__foot">
              <span class="effect">
                @if (link.state === 'auto') {
                  {{ formatCents(link.spendReductionCents) }} is already out of your spending
                  totals. Rejecting puts it back.
                } @else {
                  Confirming takes {{ formatCents(link.spendReductionCents) }} out of your
                  spending totals.
                }
              </span>
              @if (link.state !== 'auto') {
                <button
                  type="button"
                  class="button button--confirm"
                  [disabled]="busy()"
                  (click)="decided.emit({ link, decision: 'confirm' })"
                >
                  Confirm transfer
                </button>
              }
              <button
                type="button"
                class="button button--reject"
                [disabled]="busy()"
                (click)="decided.emit({ link, decision: 'reject' })"
              >
                {{ link.state === 'auto' ? 'Not a transfer' : 'Reject' }}
              </button>
            </footer>
          </li>
        }
      </ul>
    }
  `,
  styleUrl: './transfer-queue.scss',
})
export class TransferQueue {
  readonly links = input<readonly TransferLink[]>([]);
  readonly busy = input(false);
  readonly loading = input(false);

  readonly decided = output<TransferDecisionEvent>();

  protected readonly formatCents = formatCents;
}
