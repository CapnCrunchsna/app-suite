/**
 * §6.8's Analyzers section: "per-rule enable (with the two halves of `duplicate.v1`
 * toggled separately) and threshold overrides, plus rule versions and the current
 * `config_hash`. Changing a threshold warns that dismissed findings in that rule will
 * be re-evaluated."
 *
 * Presentational, like every other child on these pages: it renders what it is given
 * and emits what the user chose. The page owns every request.
 *
 * ## The warning is a count, not a disclaimer
 *
 * §5.1 reopens a dismissal when `config_hash` moves, so every edit here has a
 * consequence somewhere else — and a banner that says so on every field is a banner
 * nobody reads. The API returns dismissed-finding counts per rule, so this can say *how
 * many* and for *which* rule, and stay quiet when the answer is none.
 *
 * ## Thresholds are grouped by their rule, not by the config object
 *
 * The API returns a flat list keyed on `section`, which is the shape the config
 * genuinely has. But `global` is not a rule and `duplicate` is two, so a form laid out
 * section-by-section would ask the user to know §7.4's object graph. Grouping by rule
 * puts each number under the sentence it changes, and the sections that belong to no
 * rule — `global`, `transfers` — get named groups of their own rather than being
 * dropped.
 */

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { SettingRule, Settings, SettingThreshold } from '@metrum/api-client';

export interface SettingChange {
  readonly section: string;
  readonly key: string;
  /** `null` restores the shipped default. */
  readonly value: number | boolean | null;
}

interface Group {
  readonly key: string;
  readonly label: string;
  readonly specRef: string | null;
  readonly rules: readonly SettingRule[];
  readonly thresholds: readonly SettingThreshold[];
  readonly dismissed: number;
}

/** The two config sections that are not a §5 rule. Named rather than hidden: they are
 *  the most consequential numbers in the file. */
const NON_RULE_SECTIONS: Record<string, { label: string; specRef: string }> = {
  global: { label: 'Shared emission policy', specRef: '5.1' },
  transfers: { label: 'Internal transfer matching', specRef: '2.6' },
};

@Component({
  selector: 'll-analyzer-settings',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './analyzer-settings.html',
  styleUrl: './analyzer-settings.scss',
})
export class AnalyzerSettings {
  readonly settings = input.required<Settings>();
  readonly busy = input(false);

  readonly changed = output<SettingChange>();

  protected readonly groups = computed<Group[]>(() => {
    const all = this.settings();
    const bySection = new Map<string, SettingThreshold[]>();
    for (const threshold of all.thresholds) {
      const list = bySection.get(threshold.section) ?? [];
      list.push(threshold);
      bySection.set(threshold.section, list);
    }

    const groups: Group[] = [];
    const claimed = new Set<string>();

    // §5's rules first, in spec order, each with the thresholds its section holds.
    for (const rule of all.rules) {
      if (claimed.has(rule.section)) continue;
      claimed.add(rule.section);

      const rules = all.rules.filter((candidate) => candidate.section === rule.section);
      groups.push({
        key: rule.section,
        // One §5.4 row is "Same-merchant multiplicity"; the group above both is the
        // rule they share.
        label: rules.length > 1 ? `Duplicate and overlapping services` : rule.label,
        specRef: rule.specRef,
        rules,
        thresholds: bySection.get(rule.section) ?? [],
        dismissed: rules.reduce((total, entry) => total + entry.dismissedFindings, 0),
      });
    }

    for (const [section, meta] of Object.entries(NON_RULE_SECTIONS)) {
      if (!bySection.has(section)) continue;
      groups.push({
        key: section,
        label: meta.label,
        specRef: meta.specRef,
        rules: [],
        thresholds: bySection.get(section) ?? [],
        dismissed: 0,
      });
    }

    return groups;
  });

  /** A rule's switch is a threshold too — the same boolean, in the same section. The
   *  group renders it as a switch and hides it from the number list. */
  protected thresholdsOf(group: Group): SettingThreshold[] {
    const switches = new Set(group.rules.map((rule) => rule.enabledKey));
    return group.thresholds.filter((threshold) => !switches.has(threshold.key));
  }

  protected readonly overriddenCount = computed(
    () => this.settings().thresholds.filter((threshold) => threshold.overridden).length,
  );

  // ----------------------------------------------------------- handlers ---

  protected toggleRule(rule: SettingRule): void {
    this.changed.emit({ section: rule.section, key: rule.enabledKey, value: !rule.enabled });
  }

  /**
   * An empty box is a reset, not a zero.
   *
   * Blanking a field is the natural way to ask for "whatever it was", and the API
   * spells that `null`. Typing `0` still means zero — several of §5's thresholds
   * legitimately take it.
   */
  protected commitNumber(threshold: SettingThreshold, raw: string): void {
    const text = raw.trim();
    if (text === '') {
      this.reset(threshold);
      return;
    }
    const value = Number(text);
    if (!Number.isFinite(value) || value === threshold.value) return;
    this.changed.emit({ section: threshold.section, key: threshold.key, value });
  }

  protected commitBoolean(threshold: SettingThreshold, value: boolean): void {
    if (value === threshold.value) return;
    this.changed.emit({ section: threshold.section, key: threshold.key, value });
  }

  protected reset(threshold: SettingThreshold): void {
    if (!threshold.overridden) return;
    this.changed.emit({ section: threshold.section, key: threshold.key, value: null });
  }

  /** An explicit `for`/`id` pair rather than a wrapping label: the control sits inside
   *  an `@if` on its kind, and a template linter cannot see through that to know the
   *  label has one. Unique per field because `section` alone repeats across rules. */
  protected fieldId(threshold: SettingThreshold): string {
    return `setting-${threshold.section}-${threshold.key}`;
  }

  /** Fractions read as percentages everywhere in §5 — "exceeds by >40%" — so the
   *  hint says both rather than making the reader convert. */
  protected hintFor(threshold: SettingThreshold): string {
    if (threshold.kind === 'boolean') return `default ${String(threshold.defaultValue)}`;

    const value = threshold.defaultValue as number;
    if (value > 0 && value < 1) return `default ${value} (${Math.round(value * 100)}%)`;
    if (threshold.key.endsWith('Cents')) return `default ${value} ($${(value / 100).toFixed(2)})`;
    return `default ${value}`;
  }
}
