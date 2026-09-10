/**
 * §11.1's matching page — "quarantine queue with raw JSON viewer and resolve
 * action".
 *
 * §7.3 quarantines a row the normalizer could not map rather than guessing at
 * it, and §16.3 is why: "Never guess a cross-book selection match … quarantine
 * instead." A wrong match is two different selections treated as one, which
 * produces a confident arbitrage between a team and a total.
 *
 * So the raw payload is the page. There is no editor here and there should not
 * be one: resolving means *you* have looked at the JSON and decided this row
 * needs no further attention — it does not re-run the normalizer and it does not
 * write a mapping. Anything more would be the guess §16.3 forbids, moved into a
 * form.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  resource,
  signal,
} from '@angular/core';
import { Panel, formatLocalTime } from '@metrum/ui';
import type { UnmatchedRowResponse } from '@metrum/edgeline-api-client';

import { EdgelineApiService } from '../../edgeline-api.service';

@Component({
  selector: 'el-matching-page',
  imports: [Panel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './matching-page.html',
  styleUrl: './matching-page.scss',
})
export class MatchingPage {
  private readonly api = inject(EdgelineApiService);

  protected readonly showResolved = signal(false);
  protected readonly expanded = signal<string | null>(null);
  protected readonly busy = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly failure = signal<string | null>(null);

  private readonly rowsResource = resource({
    params: () => this.showResolved(),
    loader: ({ params }) => this.api.listUnmatched({ resolved: params, limit: 200 }),
    defaultValue: [] as UnmatchedRowResponse[],
  });

  protected readonly rows = computed(() => this.rowsResource.value());
  protected readonly loading = this.rowsResource.isLoading;
  protected readonly loadError = computed(() => this.rowsResource.error());

  protected toggleResolved(): void {
    this.showResolved.update((value) => !value);
    this.expanded.set(null);
  }

  protected toggleRow(id: string): void {
    this.expanded.update((current) => (current === id ? null : id));
  }

  /** The payload exactly as the provider sent it, pretty-printed. Nothing is
   *  summarised: the reason this row is here is that nothing could be trusted
   *  to read it. */
  protected raw(row: UnmatchedRowResponse): string {
    try {
      return JSON.stringify(row.raw ?? {}, null, 2);
    } catch {
      return String(row.raw);
    }
  }

  protected async resolve(row: UnmatchedRowResponse): Promise<void> {
    this.busy.set(row.id);
    this.notice.set(null);
    this.failure.set(null);
    try {
      await this.api.resolveUnmatched(row.id);
      this.rowsResource.reload();
      this.notice.set(
        `Marked ${row.id} reviewed. Nothing was re-normalized and no mapping was written — resolving is a note that you looked.`,
      );
    } catch (cause) {
      this.failure.set(cause instanceof Error ? cause.message : String(cause));
    } finally {
      this.busy.set(null);
    }
  }

  protected time = formatLocalTime;
}
