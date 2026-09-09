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

import { ChangeDetectionStrategy, Component, computed, inject, resource, signal } from '@angular/core';
import { Panel } from '@metrum/ui';
import type { ProviderRow } from '@metrum/edgeline-api-client';

import { EdgelineApiService } from '../../edgeline-api.service';
import { NO_DATA, formatLocalTime } from '../../formatting';

@Component({
  selector: 'el-providers-page',
  imports: [Panel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './providers-page.html',
  styleUrl: './providers-page.scss',
})
export class ProvidersPage {
  private readonly api = inject(EdgelineApiService);

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

  protected usedLabel(provider: ProviderRow): string {
    const used = provider.quota_used;
    if (used === null || used === undefined) return `${NO_DATA} of ${provider.quota_budget ?? NO_DATA}`;
    return `${used} of ${provider.quota_budget ?? NO_DATA} credits`;
  }

  /** Over four-fifths spent is worth a colour: §8.4's budget check is a startup
   *  check, so a cadence that fits at boot can still run the month dry. */
  protected tight(provider: ProviderRow): boolean {
    const percent = this.usedPercent(provider);
    return percent !== null && percent >= 80;
  }

  private async patch(
    key: string,
    body: Record<string, unknown>,
    success: string,
  ): Promise<void> {
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

  protected time = formatLocalTime;
  protected readonly noData = NO_DATA;
}
