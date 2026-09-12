/**
 * §11.1's providers page — "enable toggles, quota bar (used vs budget)".
 *
 * One provider exists in v1 (The Odds API, §8) and the quota is the whole
 * reason this page is separate from Settings: §8.4 sets cadence against a
 * monthly credit budget, and the scheduler refuses to start a cadence projected
 * to exceed it. A budget you cannot see next to the credits already spent is a
 * budget you find out about when polling stops.
 *
 * `quota_used` is `null` until the provider has answered once, and that is not
 * zero — a bar drawn at 0% for "we have never asked" reads as "plenty left".
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  resource,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { Panel } from '@metrum/ui';
import { NO_DATA, formatLocalDay } from '@metrum/format';
import type { ProviderRow } from '@metrum/edgeline-api-client';

import { EdgelineApiService } from '../../edgeline-api.service';
import { SystemStatus } from '../../system-status.service';

@Component({
  selector: 'el-providers-page',
  imports: [Panel, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './providers-page.html',
  styleUrl: './providers-page.scss',
})
export class ProvidersPage {
  private readonly api = inject(EdgelineApiService);
  /** An empty list has two causes and §3.2's `offline_mode` is the actionable
   *  one — a row cannot arrive while no request is being made. */
  protected readonly status = inject(SystemStatus);

  protected readonly busy = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly failure = signal<string | null>(null);

  private readonly providersResource = resource({
    params: () => 0,
    loader: () => this.api.listProviders(),
    defaultValue: [] as ProviderRow[],
  });

  protected readonly providers = computed(() => this.providersResource.value());
  protected readonly loading = this.providersResource.isLoading;
  protected readonly loadError = computed(() => this.providersResource.error());

  protected async setEnabled(provider: ProviderRow, enabled: boolean): Promise<void> {
    await this.patch(
      provider.id,
      { enabled },
      `${provider.display_name ?? provider.id} ${enabled ? 'enabled' : 'disabled'}.`,
    );
  }

  protected async setBudget(provider: ProviderRow, value: string): Promise<void> {
    const budget = Number(value);
    if (!Number.isFinite(budget) || budget < 0 || budget === provider.quota_budget) return;
    await this.patch(
      provider.id,
      { quota_budget: budget },
      `Budget for ${provider.display_name ?? provider.id} set to ${budget} credits.`,
    );
  }

  /** `null` used is "never asked", which is not 0% consumed. */
  protected usedPercent(provider: ProviderRow): number | null {
    const used = provider.quota_used;
    const budget = provider.quota_budget;
    if (used === null || used === undefined || !budget) return null;
    return Math.min(100, (used / budget) * 100);
  }

  /** Whether the bar is showing a measurement at all. */
  protected unknownUsage(provider: ProviderRow): boolean {
    return provider.quota_used === null || provider.quota_used === undefined;
  }

  /**
   * The bar fills with credits *spent*, so it names that.
   *
   * "— of 500" beside an empty track was ambiguous in the worst direction: an
   * empty progress bar reads as "nothing left" about as easily as "nothing
   * used", and the honest answer is neither — nothing has been *reported*.
   * Filling it instead would be worse, because a full bar is a claim that 500
   * credits are available, which is the one number §8.4 must not be wrong
   * about and which no provider has told us yet.
   */
  protected usedLabel(provider: ProviderRow): string {
    const budget = provider.quota_budget ?? NO_DATA;
    if (this.unknownUsage(provider)) return `Usage unknown · ${budget} credit budget`;
    return `${provider.quota_used} of ${budget} credits used`;
  }

  /**
   * When the allowance rolls over.
   *
   * `quota_reset_at` is only known once the provider has answered and said so,
   * and until then the row read "resets —", which says nothing to someone
   * trying to work out whether a spent month matters today. A monthly budget
   * rolls over on the first, so that date is derivable — and it is marked
   * *expected* rather than printed plainly, because §16.3's rule is that a
   * value we worked out ourselves must never be dressed as one the provider
   * reported.
   */
  protected resetLabel(provider: ProviderRow): string {
    if (provider.quota_reset_at) return `Resets ${formatLocalDay(provider.quota_reset_at)}`;
    const now = new Date();
    const firstOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return `Resets ${formatLocalDay(firstOfNextMonth.toISOString())} (expected)`;
  }

  protected resetTitle(provider: ProviderRow): string {
    return provider.quota_reset_at
      ? 'Reported by the provider with its last response.'
      : 'The first of next month — a monthly budget rolls over then. The provider has not reported its own reset date yet, so this is worked out, not quoted.';
  }

  /** Over four-fifths spent is worth a colour: §8.4's budget check is a startup
   *  check, so a cadence that fits at boot can still run the month dry. */
  protected tight(provider: ProviderRow): boolean {
    const percent = this.usedPercent(provider);
    return percent !== null && percent >= 80;
  }

  private async patch(key: string, body: Record<string, unknown>, success: string): Promise<void> {
    this.busy.set(key);
    this.notice.set(null);
    this.failure.set(null);
    try {
      await this.api.patchProvider(key, body);
      this.providersResource.reload();
      this.notice.set(success);
    } catch (cause) {
      this.failure.set(cause instanceof Error ? cause.message : String(cause));
    } finally {
      this.busy.set(null);
    }
  }

  // No `time`/`noData` here any more: the two places this page rendered a bare
  // em-dash — the quota bar's label and the reset date — now say what they do
  // not know instead, so the template has nothing left to format directly.
}
