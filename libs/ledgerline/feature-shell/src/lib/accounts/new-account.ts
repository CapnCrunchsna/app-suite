/**
 * Creating an account — §6.2's missing verb.
 *
 * ## Why this exists
 *
 * §6.2 lists the Accounts page's actions as "rename, set type, merge two
 * accounts, archive" and never says *create*, because it was written assuming an
 * account arrives with its first statement. It does not. §6.1 makes confirming
 * the account a precondition of committing an import, and the picker it offers
 * can only pick from accounts that already exist — so on a fresh database the
 * Import page asks for an account, the Accounts page says to import a statement,
 * and neither can go first. Everything downstream of a commit — findings, review,
 * insights, the labelling pass — is unreachable behind that loop.
 *
 * `POST /api/accounts` has existed the whole time. Only the UI was missing, and
 * the Import page said so in as many words: "Create one with POST /api/accounts".
 * Telling a user to open a terminal is not a fresh-install experience.
 *
 * ## Presentational, and hosted twice
 *
 * It holds its own draft and emits what was filled in; the page owns the request.
 * That is what lets both hosts use it: the Accounts page as its own spot, and the
 * Import page inline at the account step, which is where the need is actually
 * felt. Neither copy knows about the other.
 *
 * ## Why `last4` is asked for and not merely allowed
 *
 * It is optional in §2.3's schema and doing real work in two places: §2.6 scores
 * a transfer pair partly on it, and §6.1's account suggestion reads it out of the
 * filename to guess where a statement belongs. An account created without one
 * still works, and quietly makes both of those worse — so the field carries the
 * reason rather than sitting there unlabelled.
 */

import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { CreateAccountBody } from '@metrum/api-client';

import { ACCOUNT_TYPE_LABEL } from './account-card.js';
import type { AccountType } from './account-card.js';

@Component({
  selector: 'll-new-account',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './new-account.html',
  styleUrl: './new-account.scss',
  host: {
    // Open, this is a four-field form that wants a row to itself; closed, it is
    // one more button on whatever row is hosting it. The host says which, because
    // emulated encapsulation scopes both halves of a `:has()` — a host page
    // cannot select on the classes inside this template, and giving it a second
    // copy of `open()` to bind against would be state in two places.
    '[class.new-account--open]': 'open()',
  },
})
export class NewAccount {
  readonly busy = input(false);
  /**
   * Start with the form open rather than behind its button.
   *
   * The Import page sets it when no account exists, because there the form is not
   * one option among several — it is the only way forward, and a user who has to
   * find a button first has to guess that the button is the answer.
   */
  readonly startOpen = input(false);

  readonly created = output<CreateAccountBody>();

  protected readonly types: readonly AccountType[] = ['checking', 'savings', 'credit_card'];
  protected readonly typeLabel = ACCOUNT_TYPE_LABEL;

  protected readonly manuallyOpened = signal(false);
  protected readonly open = computed(() => this.startOpen() || this.manuallyOpened());

  protected readonly displayName = signal('');
  protected readonly accountType = signal<AccountType>('checking');
  protected readonly institution = signal('');
  protected readonly last4 = signal('');

  /** The name is the only field §2.3 requires, and the only one whose absence
   *  leaves an account nobody can identify in a picker. */
  protected readonly canSubmit = computed(() => this.displayName().trim() !== '' && !this.busy());

  protected openForm(): void {
    this.manuallyOpened.set(true);
  }

  protected cancel(): void {
    this.manuallyOpened.set(false);
    this.reset();
  }

  protected onName(event: Event): void {
    this.displayName.set((event.target as HTMLInputElement).value);
  }

  protected onInstitution(event: Event): void {
    this.institution.set((event.target as HTMLInputElement).value);
  }

  /** Digits only, capped at four. A statement's last four is what it is; letting
   *  anything else in produces an account that §2.6's matcher silently never
   *  scores and §6.1's filename guess never finds. */
  protected onLast4(event: Event): void {
    const input = event.target as HTMLInputElement;
    const cleaned = input.value.replace(/\D/g, '').slice(0, 4);
    if (input.value !== cleaned) input.value = cleaned;
    this.last4.set(cleaned);
  }

  protected onType(type: AccountType): void {
    this.accountType.set(type);
  }

  protected submit(): void {
    if (!this.canSubmit()) return;

    // Empty optional fields go as `null`, not as `''`: §3.2 stores them nullable,
    // and an empty string is a value that reads as "the institution is blank"
    // everywhere it is later printed or matched on.
    this.created.emit({
      displayName: this.displayName().trim(),
      accountType: this.accountType(),
      institution: this.institution().trim() || null,
      last4: this.last4() || null,
    });

    this.manuallyOpened.set(false);
    this.reset();
  }

  private reset(): void {
    this.displayName.set('');
    this.accountType.set('checking');
    this.institution.set('');
    this.last4.set('');
  }
}
