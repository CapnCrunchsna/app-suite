import { ChangeDetectionStrategy, Component, computed, effect, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Panel, ThemeSwitcher } from '@metrum/ui';
import { parseHoldingsCsv } from './calc/csv';
import {
  allInCost,
  indexCost,
  stockShare,
  valueByAccountType,
  type AccountType,
} from './calc/fees';
import { historicalCheck, type HistoryYear } from './calc/history';
import {
  emptyInputs,
  sampleInputs,
  toCalcBenchmarks,
  toCalcHoldings,
  toCalcIndex,
  toCalcSchedule,
  type BenchmarkInput,
  type HoldingInput,
  type Inputs,
  type TierInput,
} from './calc/inputs';
import { compare } from './calc/projection';
import { money, percent } from './format';
import { ProjectionChart } from './projection-chart';

/**
 * Saved in this browser only. Real holdings never touch the repo or any server;
 * this key is the whole of the app's storage.
 */
export const STORAGE_KEY = 'portfolio-check:inputs:v1';

function load(): { inputs: Inputs; sample: boolean } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { inputs: { ...emptyInputs(), ...(JSON.parse(raw) as Partial<Inputs>) }, sample: false };
  } catch {
    // Unreadable or blocked storage: fall through to the sample.
  }
  return { inputs: sampleInputs(), sample: true };
}

/**
 * Advisor vs. index: one page that takes the user's holdings and fee schedule and
 * shows what they cost, what that cost compounds to, and how much value the
 * advisor has to add to break even.
 *
 * It presents comparisons and education, never a recommendation — the copy says
 * "here is what your numbers show", and the decision stays with the reader.
 */
@Component({
  selector: 'pc-root',
  imports: [FormsModule, Panel, ThemeSwitcher, ProjectionChart],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  private readonly initial = load();
  protected readonly inputs = signal<Inputs>(this.initial.inputs);
  /** True while the page shows the made-up sample rather than the user's numbers. */
  protected readonly usingSample = signal(this.initial.sample);
  protected readonly importMessage = signal<string | null>(null);

  protected readonly money = money;
  protected readonly percent = percent;
  protected readonly accountTypes: { value: AccountType; label: string }[] = [
    { value: 'taxable', label: 'Taxable' },
    { value: 'ira', label: 'IRA' },
    { value: 'roth', label: 'Roth' },
    { value: '401k', label: '401(k)' },
  ];

  private readonly holdings = computed(() => toCalcHoldings(this.inputs().holdings));
  private readonly schedule = computed(() => toCalcSchedule(this.inputs().fee));
  protected readonly share = computed(() => stockShare(this.holdings()));
  protected readonly cost = computed(() => allInCost(this.holdings(), this.schedule()));
  protected readonly index = computed(() => indexCost(this.cost().balance, this.share(), toCalcIndex(this.inputs())));
  protected readonly byAccount = computed(() => valueByAccountType(this.holdings()));
  protected readonly missingEr = computed(
    () => this.inputs().holdings.filter((h) => !Number.isFinite(h.expenseRatioPct)).length,
  );

  protected readonly comparison = computed(() => {
    const i = this.inputs();
    return compare({
      startBalance: this.cost().balance,
      annualContribution: Number.isFinite(i.annualContribution) ? i.annualContribution : 0,
      years: Math.max(1, Math.min(60, Math.round(i.horizonYears || 1))),
      grossReturn: (Number.isFinite(i.grossReturnPct) ? i.grossReturnPct : 0) / 100,
      currentFundEr: this.cost().fundRate,
      schedule: this.schedule(),
      indexEr: this.index().fundRate,
    });
  });

  protected readonly ending = computed(() => {
    const c = this.comparison();
    // `project` always returns year 0 onward, so the last point exists.
    const current = c.current[c.current.length - 1];
    const index = c.index[c.index.length - 1];
    return { years: current.year, current, index, gap: index.balance - current.balance };
  });

  protected readonly milestones = computed(() => {
    const c = this.comparison();
    const n = c.current.length - 1;
    const years = new Set<number>([1]);
    for (let y = 5; y < n; y += 5) years.add(y);
    years.add(n);
    return [...years].map((y) => ({ year: y, current: c.current[y].balance, index: c.index[y].balance, gap: c.gap[y] }));
  });

  protected readonly breakEven = computed(() => {
    const rate = this.comparison().breakEvenRate;
    return { rate, dollars: rate * this.cost().balance };
  });

  protected readonly history = computed(() =>
    historicalCheck(
      this.inputs().history,
      toCalcBenchmarks(this.inputs().benchmarks),
      this.share(),
      this.index().fundRate,
    ),
  );

  protected rowFor(year: number) {
    return this.history()?.rows.find((r) => r.year === year) ?? null;
  }

  constructor() {
    effect(() => {
      const inputs = this.inputs();
      if (this.usingSample()) return;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(inputs));
      } catch {
        // Storage blocked: the page still works, it just won't remember.
      }
    });
  }

  /** Every edit goes through here: copy, change, set. The first edit to the sample adopts it as the user's own. */
  protected mutate(change: (draft: Inputs) => void): void {
    const draft = structuredClone(this.inputs());
    change(draft);
    this.usingSample.set(false);
    this.inputs.set(draft);
  }

  protected set<K extends keyof Inputs>(key: K, value: Inputs[K]): void {
    this.mutate((d) => (d[key] = value));
  }

  protected setHolding<K extends keyof HoldingInput>(i: number, key: K, value: HoldingInput[K]): void {
    this.mutate((d) => (d.holdings[i][key] = value));
  }

  protected addHolding(): void {
    this.mutate((d) =>
      d.holdings.push({ ticker: '', description: '', value: 0, expenseRatioPct: null, accountType: 'taxable', stockPct: 100 }),
    );
  }

  protected removeHolding(i: number): void {
    this.mutate((d) => d.holdings.splice(i, 1));
  }

  protected setFee<K extends keyof Inputs['fee']>(key: K, value: Inputs['fee'][K]): void {
    this.mutate((d) => (d.fee[key] = value));
  }

  protected setTier<K extends keyof TierInput>(i: number, key: K, value: TierInput[K]): void {
    this.mutate((d) => (d.fee.tiers[i][key] = value));
  }

  protected addTier(): void {
    this.mutate((d) => {
      const last = d.fee.tiers.at(-1);
      d.fee.tiers.push({ upTo: null, ratePct: last ? last.ratePct : 1 });
    });
  }

  protected removeTier(i: number): void {
    this.mutate((d) => d.fee.tiers.splice(i, 1));
  }

  protected setHistory<K extends keyof HistoryYear>(i: number, key: K, value: HistoryYear[K]): void {
    this.mutate((d) => ((d.history[i] as { -readonly [P in keyof HistoryYear]: HistoryYear[P] })[key] = value));
  }

  protected addHistoryYear(): void {
    this.mutate((d) => {
      const last = d.history.at(-1);
      d.history.push(
        last
          ? { year: last.year + 1, startValue: last.endValue, netContributions: 0, endValue: last.endValue }
          : { year: new Date().getFullYear() - 1, startValue: 0, netContributions: 0, endValue: 0 },
      );
    });
  }

  protected removeHistoryYear(i: number): void {
    this.mutate((d) => d.history.splice(i, 1));
  }

  protected setBenchmark<K extends keyof BenchmarkInput>(i: number, key: K, value: BenchmarkInput[K]): void {
    this.mutate((d) => (d.benchmarks[i][key] = value));
  }

  protected addBenchmarkYear(): void {
    this.mutate((d) => {
      const last = d.benchmarks.at(-1);
      d.benchmarks.push({ year: (last?.year ?? 2025) + 1, stockPct: 0, bondPct: 0 });
    });
  }

  protected loadSample(): void {
    this.inputs.set(sampleInputs());
    this.usingSample.set(true);
    this.importMessage.set(null);
  }

  protected startFresh(): void {
    this.mutate((d) => Object.assign(d, emptyInputs()));
    this.importMessage.set(null);
  }

  protected async importCsv(event: Event): Promise<void> {
    const el = event.target as HTMLInputElement;
    const file = el.files?.[0];
    el.value = '';
    if (!file) return;
    const result = parseHoldingsCsv(await file.text());
    if (result.error) {
      this.importMessage.set(result.error);
      return;
    }
    this.mutate((d) => {
      d.holdings = result.holdings.map((h) => ({
        ticker: h.ticker,
        description: h.description,
        value: h.value,
        expenseRatioPct: null,
        accountType: h.accountType ?? 'taxable',
        stockPct: 100,
      }));
    });
    this.importMessage.set(
      `Imported ${result.holdings.length} positions` +
        (result.skipped ? `, skipped ${result.skipped} rows that weren't positions (totals, pending, footers)` : '') +
        '. Fill in each expense ratio and stock share, and check the account types.',
    );
  }
}
