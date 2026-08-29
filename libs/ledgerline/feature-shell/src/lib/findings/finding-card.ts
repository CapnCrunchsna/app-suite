/**
 * One finding, with §6.4's four actions.
 *
 * "Each card shows the title, the money (monthly and annual), a confidence band
 * chip, an 'AI-assisted grouping' badge where `llm_dependent`, and inline
 * evidence [...] Actions per card: Acknowledge, Dismiss (with the scope picker:
 * this / this merchant / this rule), Snooze 90 days, and Open subscription."
 *
 * Presentational: it renders what it is given and emits what the user chose. The
 * page owns every request.
 *
 * ## The scope picker is three destinations, not three labels
 *
 * "Dismiss this" is per-finding user state — `finding_state`, keyed by natural
 * key. "This merchant" and "this rule" are a standing `dismissal_rule`, applied
 * at emit time to findings that do not exist yet. §3.1 separates the tables
 * because the latter two are not findings and have no natural key, so this
 * component emits a discriminated union rather than a string and lets the page
 * route it. Collapsing them into one call would be a UI that is wrong about the
 * data model, and the wrongness would only show up the next time analysis ran.
 *
 * ## Two resurface banners, deliberately not one
 *
 * `changedSinceDismissal` means the evidence hash moved — the price changed, or a
 * lapsed series resumed — and §5.1 wants the diff. `reEvaluated` means the
 * `config_hash` moved: the *rule* changed, not the money, and §5.1 says those are
 * "grouped separately" so the user knows why their dismissal was reopened.
 * Showing one banner for both would tell someone their subscription got more
 * expensive when in fact a threshold was tuned.
 *
 * ## Bands, never numbers
 *
 * §5.1: "Bands, not raw numbers, are shown to the user; a '0.72' implies a
 * precision the rules do not have." `confidence` is on the wire and is
 * deliberately not rendered.
 */

import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { formatCents } from '@metrum/ledgerline-domain';
import type { Finding, Transaction } from '@metrum/api-client';

import { FindingEvidence } from './finding-evidence.js';

/** What the user chose, resolved enough for the page to know which endpoint to
 *  call without re-deriving intent from a label. */
export type FindingAction =
  | { readonly kind: 'acknowledge' }
  | { readonly kind: 'snooze' }
  | { readonly kind: 'dismiss_finding' }
  | { readonly kind: 'dismiss_merchant' }
  | { readonly kind: 'dismiss_rule' };

export interface FindingActionEvent {
  readonly finding: Finding;
  readonly action: FindingAction;
}

const BAND_LABEL: Record<string, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
  suppressed: 'Suppressed',
};

@Component({
  selector: 'll-finding-card',
  imports: [FindingEvidence],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './finding-card.html',
  styleUrl: './finding-card.scss',
})
export class FindingCard {
  readonly finding = input.required<Finding>();
  /** Resolved display name for the finding's merchant, when it has one. The page
   *  looks it up; the card does not fetch. */
  readonly merchantName = input<string | null>(null);
  /** The transactions this finding cites, already fetched and capped by the page
   *  (§6.4). Empty is normal — the request has not landed, or the card is past
   *  the page's id budget — and the evidence block degrades to its count. */
  readonly charges = input<readonly Transaction[]>([]);
  readonly busy = input(false);

  readonly acted = output<FindingActionEvent>();
  /** §6.4's "Open subscription". The page owns navigation. */
  readonly openSubscription = output<Finding>();

  protected readonly formatCents = formatCents;

  /** Open state for the dismiss scope picker. Local because nothing outside the
   *  card cares whether a menu is open. */
  protected readonly picking = signal(false);

  protected readonly bandLabel = computed(
    () => BAND_LABEL[this.finding().band] ?? this.finding().band,
  );

  /** A dismissal scoped to a merchant needs one to scope to. `duplicate.v1`'s
   *  category-overlap finding is about a group rather than a merchant, so the
   *  option is hidden rather than offered and then refused by the API. */
  protected readonly canScopeToMerchant = computed(
    () => this.merchantId() !== null && this.merchantName() !== null,
  );

  protected readonly merchantId = computed(() => {
    const value = this.finding().detail['merchantId'];
    return typeof value === 'string' && value !== '' ? value : null;
  });

  /** §6.4 lists "Open subscription" as a per-card action, which only means
   *  something for a finding whose subject is one. */
  protected readonly isSeries = computed(() => this.finding().subjectType === 'series');

  protected act(action: FindingAction): void {
    this.picking.set(false);
    this.acted.emit({ finding: this.finding(), action });
  }

  protected togglePicker(): void {
    this.picking.update((open) => !open);
  }
}
