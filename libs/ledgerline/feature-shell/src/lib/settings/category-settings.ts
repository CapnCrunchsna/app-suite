/**
 * §6.8's Categories section: "taxonomy editor and overlap-group assignment".
 *
 * Presentational, like every other child on this page: it renders what it is given
 * and emits what the user chose. The container owns every request.
 *
 * ## The two halves are not the same thing, and the layout says so
 *
 * Renaming a category and moving it under a parent is CRUD. It is worth having —
 * a taxonomy nobody can edit stays wrong — but nothing downstream changes shape
 * when "Dining & Coffee" becomes "Eating out".
 *
 * `overlap_group` is different. §5.4 defines it as "a curated subset of categories
 * where redundancy is meaningful", and putting two categories in one group is the
 * claim **these describe the same spending** — the entire input to that rule's
 * category-overlap half. §9d recorded that the path has been dead since the
 * analyzers landed, because `SEED_CATEGORIES` deliberately left the column unset
 * rather than guess at the answer to the rule's hardest question. So the groups get
 * their own block at the top, and it states plainly which ones §5.4 can act on: a
 * group with one category in it is a label, not a claim, and the rule will never
 * fire on it.
 *
 * ## A delete arms before it acts
 *
 * §6.9's rule, inherited here because it is the same decision: "Nothing applies on
 * selection: a direction is armed, and a second explicit click performs it." A
 * category in use cannot be deleted at all without saying where its charges go, and
 * that choice is not one to make on a stray click. The counts on the button are the
 * API's, never derived from what this page is holding.
 */

import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Category, CategoryUsage, CreateCategoryBody, UpdateCategoryBody } from '@metrum/api-client';

export type CategoryKind = Category['kind'];

export type CategoryAction =
  | { readonly kind: 'create'; readonly draft: CreateCategoryBody }
  | { readonly kind: 'edit'; readonly id: string; readonly patch: UpdateCategoryBody }
  | { readonly kind: 'delete'; readonly id: string; readonly reassignTo: string | null };

/** §3.1's four, in the order §5 reasons about them: what you spend, what it costs
 *  you to hold the account, what is not spending at all, and what comes in. */
export const CATEGORY_KINDS: readonly { readonly id: CategoryKind; readonly label: string }[] = [
  { id: 'spend', label: 'Spending' },
  { id: 'fee', label: 'Fee or interest' },
  { id: 'transfer', label: 'Transfer' },
  { id: 'income', label: 'Income' },
];

/** What each kind changes about the analyzers, in the terms the person picking it is
 *  deciding in. §5.8 and §6.6 read `fee`; §5.10 trends only `spend`. */
export const KIND_CONSEQUENCE: Readonly<Record<CategoryKind, string>> = {
  spend: 'Trended month over month, and counted in category spending.',
  fee: 'Rolled into the fee total per account, and out of spending trends.',
  transfer: 'Money moving between your own accounts. Kept out of every spend total.',
  income: 'Money coming in. Kept out of every spend total.',
};

/** One row of the tree, flattened, so the template renders a list and the nesting is
 *  an indent rather than a recursive component. Two levels is the whole depth. */
interface Row {
  readonly usage: CategoryUsage;
  readonly child: boolean;
}

/** One §5.4 group and what is in it. */
interface GroupView {
  readonly name: string;
  readonly members: readonly Category[];
  /** Whether the rule can fire on it at all — §5.4 needs "two or more active series
   *  sharing an `overlap_group`", and one category cannot supply two. */
  readonly live: boolean;
}

@Component({
  selector: 'll-category-settings',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './category-settings.html',
  styleUrl: './category-settings.scss',
})
export class CategorySettings {
  readonly usage = input.required<readonly CategoryUsage[]>();
  readonly busy = input(false);

  readonly acted = output<CategoryAction>();

  protected readonly kinds = CATEGORY_KINDS;
  protected readonly kindConsequence = KIND_CONSEQUENCE;

  /** The row whose delete is armed, and where its charges would go. Held here
   *  rather than in the container: a half-made decision is not a fact about the
   *  store, and routing it through the parent would close the strip on every
   *  keystroke. */
  protected readonly arming = signal<string | null>(null);
  protected readonly reassignTo = signal<string>('');

  protected readonly draftName = signal('');
  protected readonly draftKind = signal<CategoryKind>('spend');
  protected readonly draftParent = signal<string>('');

  /** Roots first, each followed by its own children. Sorted by name within a level,
   *  which is the order `GET /api/categories` already returns. */
  protected readonly rows = computed<Row[]>(() => {
    const all = this.usage();
    const roots = all.filter((row) => row.category.parentId === null);

    return roots.flatMap((root) => [
      { usage: root, child: false },
      ...all
        .filter((row) => row.category.parentId === root.category.id)
        .map((row) => ({ usage: row, child: true })),
    ]);
  });

  /** Parent candidates: a root, and never one that is already a child — the API caps
   *  the taxonomy at two levels and an option that always 400s is a trap. */
  protected readonly parents = computed(() =>
    this.usage()
      .filter((row) => row.category.parentId === null)
      .map((row) => row.category),
  );

  protected readonly groups = computed<GroupView[]>(() => {
    const byGroup = new Map<string, Category[]>();
    for (const row of this.usage()) {
      const group = row.category.overlapGroup;
      if (!group) continue;
      byGroup.set(group, [...(byGroup.get(group) ?? []), row.category]);
    }

    return [...byGroup.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, members]) => ({ name, members, live: members.length >= 2 }));
  });

  /** Every group already in use, for the input's datalist. Typing a group that
   *  exists is how a category joins one, so offering the list is the difference
   *  between joining `video_streaming` and inventing `video streaming`. */
  protected readonly knownGroups = computed(() => this.groups().map((group) => group.name));

  /** Where a delete could send this category's charges. Everything but itself. */
  protected targetsFor(id: string): Category[] {
    return this.usage()
      .filter((row) => row.category.id !== id)
      .map((row) => row.category);
  }

  protected usageLabel(row: CategoryUsage): string {
    const parts: string[] = [];
    if (row.transactions > 0) {
      parts.push(`${row.transactions} ${row.transactions === 1 ? 'charge' : 'charges'}`);
    }
    if (row.merchants > 0) {
      parts.push(`${row.merchants} ${row.merchants === 1 ? 'merchant' : 'merchants'}`);
    }
    if (row.children > 0) {
      parts.push(`${row.children} ${row.children === 1 ? 'subcategory' : 'subcategories'}`);
    }
    return parts.length === 0 ? 'unused' : parts.join(' · ');
  }

  // ------------------------------------------------------------- editing ---

  protected rename(row: CategoryUsage, value: string): void {
    const name = value.trim();
    if (name === '' || name === row.category.name) return;
    this.acted.emit({ kind: 'edit', id: row.category.id, patch: { name } });
  }

  protected setKind(row: CategoryUsage, value: string): void {
    const kind = value as CategoryKind;
    if (kind === row.category.kind) return;
    this.acted.emit({ kind: 'edit', id: row.category.id, patch: { kind } });
  }

  /** Blank clears the group, which is how the §5.4 claim is withdrawn. */
  protected setGroup(row: CategoryUsage, value: string): void {
    const group = value.trim() === '' ? null : value.trim();
    if (group === row.category.overlapGroup) return;
    this.acted.emit({ kind: 'edit', id: row.category.id, patch: { overlapGroup: group } });
  }

  protected setParent(row: CategoryUsage, value: string): void {
    const parentId = value === '' ? null : value;
    if (parentId === row.category.parentId) return;
    this.acted.emit({ kind: 'edit', id: row.category.id, patch: { parentId } });
  }

  // -------------------------------------------------------------- create ---

  protected create(): void {
    const name = this.draftName().trim();
    if (name === '' || this.busy()) return;

    this.acted.emit({
      kind: 'create',
      draft: {
        name,
        kind: this.draftKind(),
        parentId: this.draftParent() === '' ? null : this.draftParent(),
      },
    });
    this.draftName.set('');
    this.draftParent.set('');
  }

  // -------------------------------------------------------------- delete ---

  protected arm(row: CategoryUsage): void {
    this.arming.set(row.category.id);
    this.reassignTo.set('');
  }

  protected disarm(): void {
    this.arming.set(null);
    this.reassignTo.set('');
  }

  /** A category in use needs somewhere for its charges to go before the button
   *  means anything — the API refuses otherwise, and offering a click that cannot
   *  succeed is how a page teaches people to ignore its errors. */
  protected canConfirm(row: CategoryUsage): boolean {
    return row.deletable || this.reassignTo() !== '';
  }

  protected confirmDelete(row: CategoryUsage): void {
    if (this.busy() || !this.canConfirm(row)) return;
    const target = this.reassignTo();
    this.acted.emit({
      kind: 'delete',
      id: row.category.id,
      reassignTo: target === '' ? null : target,
    });
    this.disarm();
  }
}
