/**
 * §11.1's settings page — "reactive form over §3.2 (grouped: Staking,
 * Thresholds, Polling, Safety)". Phase 3's exit is "every §3.2 setting editable
 * in UI", so completeness is the requirement and `settings-fields.ts` is the
 * list; this file is the form over it.
 *
 * ## Two forms, not one, and the split is §16.2
 *
 * Staking, Thresholds and Polling save together: they are numbers you tune, and
 * a page that made you press Save twenty times to change a cadence would be
 * worse at its job.
 *
 * Safety does not join them. `paper_mode` and `kill_switch` are guardrails, and
 * §16.2 reserves loosening one to an explicit user instruction. Landing them in
 * the same Save as `poll_interval_s` would make turning off paper mode something
 * that happens *while doing something else* — which is exactly the shape of the
 * accident the rule exists to prevent. So they stage a change, the page names
 * the direction in words, and a second, separately-labelled press applies it.
 *
 * The page may expose them at all because the person pressing the button is the
 * user, which is what §16.2 asks for. It is the implementer who may never flip
 * `paper_mode`, and nothing here does it on their behalf: there is no default,
 * no migration, and no code path that writes `paper_mode` without a press.
 *
 * ## Why the patch is diffed rather than sent whole
 *
 * `PUT /api/settings` is a patch that validates against §3.2's key set and
 * rejects unknown keys. Sending the whole map back would work, but it would also
 * mean a field this page renders slightly wrong (a rounding of
 * `staleness_sigma_floor`, say) gets written on every save of an unrelated
 * number. Diffing means a setting you did not touch is a setting that is not
 * sent.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  resource,
  signal,
} from '@angular/core';
import { FormControl, FormRecord, ReactiveFormsModule, Validators } from '@angular/forms';
import type { AbstractControl, ValidationErrors } from '@angular/forms';
import { Panel, centsFromDollars, dollarsFromCents, formatCents } from '@metrum/ui';
import type { Settings } from '@metrum/edgeline-api-client';

import { EdgelineApiService } from '../../edgeline-api.service';
import { SystemStatus } from '../../system-status.service';
import {
  ALL_GROUPS,
  EDITABLE_GROUPS,
  SAFETY,
  type FieldSpec,
  type SettingKey,
} from './settings-fields';

type FieldValue = string | number | boolean | null;

/** What a `bool` field is staged at, versus what the server says it is. */
interface SafetyChange {
  readonly key: SettingKey;
  readonly label: string;
  readonly from: boolean;
  readonly to: boolean;
  /** True when the change removes protection — the direction §16.2 is about. */
  readonly loosening: boolean;
}

@Component({
  selector: 'el-settings-page',
  imports: [ReactiveFormsModule, Panel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings-page.html',
  styleUrl: './settings-page.scss',
})
export class SettingsPage {
  private readonly api = inject(EdgelineApiService);
  private readonly status = inject(SystemStatus);

  protected readonly groups = EDITABLE_GROUPS;
  protected readonly safety = SAFETY;

  protected readonly form = new FormRecord<FormControl<FieldValue>>({});
  protected readonly safetyForm = new FormRecord<FormControl<FieldValue>>({});

  protected readonly saving = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly failure = signal<string | null>(null);
  protected readonly confirmingSafety = signal(false);
  /** Bumped after every write so the computed diffs re-read the controls —
   *  reactive form values are not signals. */
  protected readonly revision = signal(0);

  private readonly settingsResource = resource({
    params: () => 0,
    loader: async () => {
      const settings = await this.api.getSettings();
      this.fillForms(settings);
      return settings;
    },
    defaultValue: {} as Settings,
  });

  protected readonly loading = this.settingsResource.isLoading;
  protected readonly loadError = computed(() => this.settingsResource.error());
  protected readonly current = computed(() => this.settingsResource.value());

  /** Which of the two guardrails is staged away from what the server holds. */
  protected readonly safetyChanges = computed<SafetyChange[]>(() => {
    this.revision();
    const settings = this.current();
    return SAFETY.fields.flatMap((field) => {
      const control = this.safetyForm.controls[field.key];
      if (!control) return [];
      const to = control.value === true;
      const from = readValue(settings, field.key) === true;
      if (to === from) return [];
      // Both flags protect when true, so turning either off is the loosening.
      return [{ key: field.key, label: field.label, from, to, loosening: from && !to }];
    });
  });

  protected readonly hasSafetyChanges = computed(() => this.safetyChanges().length > 0);
  protected readonly loosening = computed(() =>
    this.safetyChanges().some((change) => change.loosening),
  );

  /** How many tunable settings differ from the server's copy. */
  protected readonly pendingCount = computed(() => {
    this.revision();
    return Object.keys(this.buildPatch()).length;
  });

  constructor() {
    for (const group of ALL_GROUPS) {
      const target = group.id === 'safety' ? this.safetyForm : this.form;
      for (const field of group.fields) {
        target.addControl(field.key, new FormControl<FieldValue>(null, validatorsFor(field)));
      }
    }
  }

  protected controlFor(key: SettingKey): FormControl<FieldValue> | undefined {
    return this.form.controls[key] ?? this.safetyForm.controls[key];
  }

  protected errorFor(key: SettingKey): string | null {
    const control = this.controlFor(key);
    if (!control || control.valid || !control.touched) return null;
    if (control.hasError('json')) return 'Not valid JSON, or not a flat map of numbers.';
    if (control.hasError('min')) return 'Below the smallest value this setting allows.';
    return 'This setting needs a value.';
  }

  /** The dollars a `cents` field is holding, echoed back as the cents that will
   *  actually be stored — §1's representation, visible rather than implied. */
  protected centsEcho(key: SettingKey): string {
    this.revision();
    const control = this.form.controls[key];
    const cents = centsFromDollars(Number(control?.value ?? Number.NaN));
    return cents === null ? '' : `${cents} cents`;
  }

  protected onInput(): void {
    this.revision.update((value) => value + 1);
  }

  protected async save(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.revision.update((value) => value + 1);
      return;
    }
    const patch = this.buildPatch();
    if (Object.keys(patch).length === 0) return;
    await this.write(patch, `Saved ${Object.keys(patch).length} setting(s).`);
  }

  /** Step one of two. Nothing is written here. */
  protected stageSafety(): void {
    this.confirmingSafety.set(true);
    this.revision.update((value) => value + 1);
  }

  protected cancelSafety(): void {
    this.confirmingSafety.set(false);
    this.fillForms(this.current());
    this.revision.update((value) => value + 1);
  }

  /** Step two. The only code path in this app that writes `paper_mode`. */
  protected async applySafety(): Promise<void> {
    const changes = this.safetyChanges();
    if (changes.length === 0) return;
    const patch: Record<string, unknown> = {};
    for (const change of changes) patch[change.key] = change.to;
    this.confirmingSafety.set(false);
    await this.write(
      patch,
      changes.map((change) => `${change.label} is now ${change.to ? 'on' : 'off'}.`).join(' '),
    );
    // The header badge reads health, not settings, so it has to be told.
    await this.status.refresh();
  }

  private async write(patch: Record<string, unknown>, success: string): Promise<void> {
    this.saving.set(true);
    this.notice.set(null);
    this.failure.set(null);
    try {
      const saved = await this.api.updateSettings(patch);
      this.settingsResource.set(saved);
      this.fillForms(saved);
      this.notice.set(success);
    } catch (cause) {
      this.failure.set(describe(cause));
    } finally {
      this.saving.set(false);
      this.revision.update((value) => value + 1);
    }
  }

  /**
   * Only what differs, converted back to §3.2's representation.
   *
   * Compared by value rather than by the control's `dirty` flag: re-typing a
   * number you did not change marks a control dirty, and a patch containing
   * `poll_interval_s` unchanged is a write nobody asked for.
   */
  private buildPatch(): Record<string, unknown> {
    const settings = this.current();
    const patch: Record<string, unknown> = {};
    for (const group of EDITABLE_GROUPS) {
      for (const field of group.fields) {
        const control = this.form.controls[field.key];
        if (!control || control.invalid) continue;
        const next = fromControl(field, control.value);
        if (next === undefined) continue;
        const before = readValue(settings, field.key);
        if (JSON.stringify(next) !== JSON.stringify(before)) patch[field.key] = next;
      }
    }
    return patch;
  }

  private fillForms(settings: Settings): void {
    for (const group of ALL_GROUPS) {
      const target = group.id === 'safety' ? this.safetyForm : this.form;
      for (const field of group.fields) {
        target.controls[field.key]?.setValue(toControl(field, readValue(settings, field.key)), {
          emitEvent: false,
        });
      }
    }
    this.form.markAsPristine();
    this.safetyForm.markAsPristine();
  }

  protected readonly money = formatCents;
}

function readValue(settings: Settings, key: SettingKey): unknown {
  return (settings as Record<string, unknown>)[key];
}

/** Stored representation → what the input holds. */
function toControl(field: FieldSpec, value: unknown): FieldValue {
  if (value === undefined || value === null) return field.kind === 'bool' ? false : null;
  switch (field.kind) {
    case 'cents':
      return dollarsFromCents(Number(value));
    case 'list':
      return Array.isArray(value) ? value.join(', ') : String(value);
    case 'json':
      return JSON.stringify(value);
    case 'bool':
      return value === true;
    case 'number':
      return Number(value);
    default:
      return String(value);
  }
}

/** What the input holds → §3.2's representation. `undefined` means "leave it
 *  alone": a blank field is not a request to store null. */
function fromControl(field: FieldSpec, value: FieldValue): unknown {
  switch (field.kind) {
    case 'cents': {
      if (value === null || value === '') return undefined;
      return centsFromDollars(Number(value)) ?? undefined;
    }
    case 'number': {
      if (value === null || value === '') return undefined;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    case 'list': {
      const parts = String(value ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      return parts;
    }
    case 'json': {
      try {
        return JSON.parse(String(value ?? ''));
      } catch {
        return undefined;
      }
    }
    case 'bool':
      return value === true;
    default:
      return value === null || value === '' ? undefined : String(value);
  }
}

function validatorsFor(field: FieldSpec) {
  const validators = [];
  if (field.kind === 'number' || field.kind === 'cents') {
    validators.push(Validators.required);
    if (field.min !== undefined) validators.push(Validators.min(field.min));
  }
  if (field.kind === 'json') validators.push(flatNumberMap);
  return validators;
}

/** `consensus_weights` is a flat map of book key to integer weight. Anything
 *  else would be accepted by the API's `dict[str, Any]` and then ignored by the
 *  consensus, which is the worst of both. */
function flatNumberMap(control: AbstractControl): ValidationErrors | null {
  const raw = String(control.value ?? '').trim();
  if (raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { json: true };
    }
    const values = Object.values(parsed as Record<string, unknown>);
    return values.every((value) => typeof value === 'number' && Number.isFinite(value))
      ? null
      : { json: true };
  } catch {
    return { json: true };
  }
}

function describe(cause: unknown): string {
  if (cause && typeof cause === 'object' && 'body' in cause) {
    const body = (cause as { body?: unknown }).body;
    if (body && typeof body === 'object' && 'detail' in body) {
      return `The engine refused the change: ${JSON.stringify((body as { detail: unknown }).detail)}`;
    }
  }
  return cause instanceof Error ? cause.message : String(cause);
}
