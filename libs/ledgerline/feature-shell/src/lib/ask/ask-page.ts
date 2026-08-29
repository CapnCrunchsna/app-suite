/**
 * §6.7's Ask page.
 *
 * "Chat over the data, disabled with a clear explanation and a link to Settings when
 * the provider is `none`."
 *
 * ## The table is the answer; the prose is commentary
 *
 * §6.7 ends with two sentences that decide this page's whole layout: "Every answer
 * renders the underlying table or chart, names the query it ran, and offers 'view
 * the rows.' An answer with no visible data behind it is not shown."
 *
 * So the table is never hidden behind the prose, and the prose can be absent while
 * the table stands. That is not a degraded state to apologise for — it is the normal
 * shape of an answer whose numbers did not check out, and the note says which of the
 * three reasons applies. A page that led with the prose and tucked the data into a
 * disclosure would be inverting exactly the trust relationship §6.7 is built around.
 *
 * ## `409` is a state, not an error
 *
 * With no provider configured the API refuses, and §2.3 makes that refusal
 * machine-readable precisely so this page can render it as a *state* — an
 * explanation and a link — rather than as a failed request. `llm_disabled` is
 * branched on by code; the message is shown as written, because the API says which
 * setting and this page should not paraphrase it.
 *
 * Same split as the other pages: the container owns state and every request.
 */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Panel } from '@metrum/ui';
import { LedgerlineApiError } from '@metrum/api-client';
import type { AskResult } from '@metrum/api-client';

import { LedgerlineApiService } from '../ledgerline-api.service.js';

/** One exchange. Kept in order, because a page that answered in place would lose
 *  the question a table belongs to the moment a second one is asked. */
export interface AskExchange {
  readonly question: string;
  readonly result: AskResult;
}

/**
 * §6.7's six functions, as things a person might type.
 *
 * Shown on the empty state rather than as autocomplete: the model chooses the query,
 * so these are not commands and offering them as such would teach the wrong model of
 * what the box does. They are there because "chat over the data" gives no clue what
 * the data *is*, and a blank box with a cursor is the least informative thing a page
 * can open with.
 */
const EXAMPLES = [
  'What did I spend on groceries this year?',
  'How much goes out each month?',
  'Who do I pay the most?',
  'What am I subscribed to?',
  'Show me everything over $200',
] as const;

@Component({
  selector: 'll-ask-page',
  imports: [FormsModule, RouterLink, Panel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './ask-page.html',
  styleUrl: './ask-page.scss',
})
export class AskPage {
  private readonly api = inject(LedgerlineApiService);

  protected readonly examples = EXAMPLES;
  protected readonly question = signal('');
  protected readonly asking = signal(false);
  protected readonly exchanges = signal<readonly AskExchange[]>([]);

  /** Set when the API answered `409 llm_disabled`. Its message, verbatim. */
  protected readonly disabledReason = signal<string | null>(null);
  protected readonly failure = signal<string | null>(null);

  protected readonly canAsk = computed(
    () => this.question().trim() !== '' && !this.asking() && this.disabledReason() === null,
  );

  protected async submit(): Promise<void> {
    const question = this.question().trim();
    if (question === '' || this.asking()) return;

    this.asking.set(true);
    this.failure.set(null);

    try {
      const result = await this.api.ask({ question });
      // Newest first: the answer you just asked for should not require scrolling
      // past the four before it.
      this.exchanges.update((all) => [{ question, result }, ...all]);
      this.question.set('');
    } catch (cause) {
      if (cause instanceof LedgerlineApiError && cause.code === 'llm_disabled') {
        // §2.3's machine-readable reason, branched on by code and rendered as the
        // API wrote it — it names the setting, and this page should not paraphrase.
        this.disabledReason.set(cause.message);
      } else {
        this.failure.set(
          cause instanceof LedgerlineApiError
            ? cause.message
            : `That did not work: ${(cause as Error).message}`,
        );
      }
    } finally {
      this.asking.set(false);
    }
  }

  protected use(example: string): void {
    this.question.set(example);
  }

  /** Cents to a readable amount. Magnitude, because §7.3's amounts are signed and a
   *  spend table reading "-$1,099.00" throughout is noise, not information. */
  protected money(cents: number | null): string {
    if (cents === null) return '';
    return `$${(Math.abs(cents) / 100).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
}
