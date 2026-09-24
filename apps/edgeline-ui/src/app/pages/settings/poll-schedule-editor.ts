/**
 * §3.2's `poll_schedule` — the weekly plan of fixed Eastern-time polls — as rows
 * of sport, weekdays and time. Added 2026-09-23 with the setting.
 *
 * A form control rather than a JSON box, because every mistake a JSON box
 * invites is one the engine would refuse with a 422 the reader then has to
 * decode: a 12-hour time, a day spelled out, "NFL" where a sport key belongs.
 * Checkboxes cannot misspell a day and a time input cannot say "5pm".
 *
 * It prices itself. §13 refuses to start a plan projected over the monthly
 * budget, and a reader adding a row should see that coming here rather than in
 * a worker log — so the footer runs §8.4's arithmetic on the rows as they stand:
 * polls a week × credits a poll × 30/7, rounded up like the engine rounds it.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  forwardRef,
  input,
  output,
  signal,
} from '@angular/core';
import { NG_VALUE_ACCESSOR } from '@angular/forms';
import type { ControlValueAccessor } from '@angular/forms';
import type { PollSlot } from '@metrum/edgeline-api-client';

import { KNOWN_SPORTS, sportLabel } from '../../labels';

export type Weekday = PollSlot['days'][number];

/** `datetime.weekday()` order — the engine's, so a saved row reads back as sent. */
export const WEEKDAYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const DAY_LABELS: Readonly<Record<Weekday, string>> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const SPORT_KEY = /^[a-z0-9_]+$/;

/** A row the engine would accept — the same three rules `PollSlot` enforces. */
export function slotIsValid(slot: PollSlot): boolean {
  return slot.days.length > 0 && TIME.test(slot.time) && SPORT_KEY.test(slot.sport);
}

/** How many polls a week the rows buy: one per day, time and sport, however
 *  many rows name it — which is what the scheduler registers and bills. */
export function pollsPerWeek(rows: readonly PollSlot[]): number {
  const polls = new Set<string>();
  for (const row of rows) {
    if (!slotIsValid(row)) continue;
    for (const day of row.days) polls.add(`${day} ${row.time} ${row.sport}`);
  }
  return polls.size;
}

/** §8.4 over a week: polls × credits a poll × 30/7, rounded up as the engine
 *  rounds it, since under-reporting is the one direction it must not err in. */
export function projectedMonthlyCredits(polls: number, creditsPerPoll: number): number {
  return Math.ceil((polls * creditsPerPoll * 30) / 7);
}

@Component({
  selector: 'el-poll-schedule-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => PollScheduleEditor),
      multi: true,
    },
  ],
  templateUrl: './poll-schedule-editor.html',
  styleUrl: './poll-schedule-editor.scss',
})
export class PollScheduleEditor implements ControlValueAccessor {
  /** `markets × regions`, from the form as it stands — what one poll costs. */
  readonly creditsPerPoll = input(0);
  /** `quota_monthly_budget`, from the form as it stands. */
  readonly budget = input<number | null>(null);
  /** Fires after every edit, once the form control already holds the new rows. */
  readonly edited = output<void>();

  protected readonly days = WEEKDAYS;
  protected readonly knownSports = KNOWN_SPORTS;
  protected readonly rows = signal<PollSlot[]>([]);
  protected readonly disabled = signal(false);

  protected readonly weekly = computed(() => pollsPerWeek(this.rows()));
  protected readonly projected = computed(() =>
    projectedMonthlyCredits(this.weekly(), this.creditsPerPoll()),
  );
  protected readonly overBudget = computed(() => {
    const budget = this.budget();
    return budget !== null && this.projected() > budget;
  });

  private onChange: (value: PollSlot[]) => void = () => undefined;
  private onTouched: () => void = () => undefined;

  writeValue(value: PollSlot[] | null): void {
    this.rows.set((value ?? []).map(copy));
  }

  registerOnChange(fn: (value: PollSlot[]) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(disabled: boolean): void {
    this.disabled.set(disabled);
  }

  protected dayLabel(day: Weekday): string {
    return DAY_LABELS[day];
  }

  protected sportName(key: string): string {
    return SPORT_KEY.test(key) ? sportLabel(key) : '';
  }

  protected rowIsValid(row: PollSlot): boolean {
    return slotIsValid(row);
  }

  protected toggleDay(index: number, day: Weekday): void {
    this.edit(index, (row) => {
      const on = !row.days.includes(day);
      // Rebuilt in week order, so ticking Monday after Thursday saves the same
      // row as ticking them the other way round — and diffs as unchanged.
      return { ...row, days: WEEKDAYS.filter((d) => (d === day ? on : row.days.includes(d))) };
    });
  }

  protected setTime(index: number, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.edit(index, (row) => ({ ...row, time: value.slice(0, 5) }));
  }

  protected setSport(index: number, event: Event): void {
    const value = (event.target as HTMLInputElement).value.trim();
    this.edit(index, (row) => ({ ...row, sport: value }));
  }

  protected add(): void {
    this.commit([...this.rows(), { days: [], time: '17:30', sport: '' }]);
  }

  protected remove(index: number): void {
    this.commit(this.rows().filter((_, i) => i !== index));
  }

  private edit(index: number, change: (row: PollSlot) => PollSlot): void {
    this.commit(this.rows().map((row, i) => (i === index ? change(row) : row)));
  }

  private commit(rows: PollSlot[]): void {
    this.rows.set(rows);
    this.onChange(rows.map(copy));
    this.onTouched();
    this.edited.emit();
  }
}

function copy(slot: PollSlot): PollSlot {
  return { days: [...slot.days], time: slot.time, sport: slot.sport };
}
