/**
 * §6.1's column mapper: "appears inline for unknown formats: the first rows in a
 * grid, a dropdown per column (`Date` / `Posted date` / `Description` / `Amount`
 * / `Debit` / `Credit` / `Balance` / `Status` / `Ignore`), a date-format picker
 * with a live preview, and a sign-convention toggle."
 *
 * ## Why this component owns requests at all
 *
 * The page owns every other request on this screen. This one is the same
 * exception `MerchantAssign` is: the draft it previews is state nothing outside
 * this component reads, and the preview refires on every dropdown change. Hoisting
 * the draft into the page to keep the request there would move a dozen fields up
 * and gain nothing. The *write* still goes out through the page — `saved` emits a
 * draft, the page saves it and re-parses.
 *
 * ## What the preview is, and why it is not a second parser
 *
 * `POST /api/format-profiles/preview` runs the real parser over the file's real
 * bytes. §2.2 forbids `type:feature` from importing `type:parsing`, so a preview
 * computed here would be a second implementation of "what does `01/02/2026` mean
 * under `MM/DD/YYYY`" — and a preview by a different parser than the importer is a
 * preview that can lie. Every number and every date below came back from the
 * route.
 *
 * ## Three deliberate omissions
 *
 * **The draft never carries `delimiter` or `skipLines`.** Detection already found
 * both and reports them on every preview; the API's fallback prefers what was
 * detected over what was assumed, and it only gets to do that if the field is
 * absent. A schema `default` on those two was a real bug — `,` silently overrode a
 * detected semicolon and `0` overrode a detected preamble, producing a mapping
 * that pointed at the file's title row and an error message blaming the column
 * names. They are shown here as read-only facts.
 *
 * **There is no `hasHeader` toggle.** A file only reaches this mapper by way of
 * detection, and detection needs a header row to compute the signature at all —
 * `needs_mapping` is a header it does not recognize, never a file without one.
 * Offering the toggle would offer a way to invalidate every column reference on
 * screen.
 *
 * **`amountMode` is derived, not chosen.** Assigning Debit or Credit *is* choosing
 * `debit_credit`; assigning Amount is choosing `single`. `validateProfile` refuses
 * the two mixed, so deriving the mode removes an error the user can otherwise
 * produce and then has to be told about.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  resource,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { formatCents } from '@metrum/ledgerline-domain';
import type {
  ColumnMap,
  FormatProfile,
  FormatProfileDraft,
  FormatProfilePreview,
} from '@metrum/api-client';

import { LedgerlineApiService } from '../ledgerline-api.service.js';

/** §6.1's dropdown, verbatim and in its order. `ignore` is the absence of a role
 *  rather than a role, so it never reaches `columnMap`. */
export const COLUMN_ROLES = [
  { value: 'transactionDate', label: 'Date' },
  { value: 'postedDate', label: 'Posted date' },
  { value: 'description', label: 'Description' },
  { value: 'amount', label: 'Amount' },
  { value: 'debit', label: 'Debit' },
  { value: 'credit', label: 'Credit' },
  { value: 'balance', label: 'Balance' },
  { value: 'status', label: 'Status' },
] as const;

export type ColumnRole = (typeof COLUMN_ROLES)[number]['value'];
export type RoleChoice = ColumnRole | 'ignore';

/**
 * Formats offered to the picker. Not sniffed and not exhaustive — the free-text
 * box beside it takes anything `domain/dates.ts` understands. §3.1's whole
 * argument for `date_format` is that `01/02/2026` has no reading a file can
 * disclose, so this list is a convenience over a declaration, never a guess.
 */
export const DATE_FORMATS = [
  'MM/DD/YYYY',
  'DD/MM/YYYY',
  'M/D/YYYY',
  'D/M/YYYY',
  'MM/DD/YY',
  'DD/MM/YY',
  'YYYY-MM-DD',
  'YYYY/MM/DD',
  'DD.MM.YYYY',
  'MMM D, YYYY',
  'DD-MMM-YYYY',
] as const;

/** Mirrors `normalizeHeaderToken` in `type:parsing`, which §2.2 puts out of reach.
 *  Used only to line a copied profile's column names up with this file's headers;
 *  a miss costs a pre-filled dropdown, never a wrong parse — the mapping that gets
 *  saved is whatever is on screen when Save is pressed. */
function normalizeToken(cell: string): string {
  return cell
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

@Component({
  selector: 'll-column-mapper',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './column-mapper.html',
  styleUrl: './column-mapper.scss',
})
export class ColumnMapper {
  private readonly api = inject(LedgerlineApiService);

  readonly importId = input.required<string>();
  /** Seeds the institution box. The filename is usually most of the bank's name. */
  readonly suggestedInstitution = input('');
  /** For "start from an existing profile" — §6.1's next-statement-imports-without-
   *  asking works off `header_signature`, so a near miss is worth copying. */
  readonly profiles = input<readonly FormatProfile[]>([]);
  readonly busy = input(false);

  readonly saved = output<FormatProfileDraft>();
  readonly cancelled = output<void>();

  protected readonly formatCents = formatCents;
  protected readonly COLUMN_ROLES = COLUMN_ROLES;
  protected readonly DATE_FORMATS = DATE_FORMATS;

  // ---------------------------------------------------------- the draft ---

  protected readonly institution = linkedSignal(() => this.suggestedInstitution());
  protected readonly dateFormat = signal<string>('MM/DD/YYYY');
  protected readonly signConvention = signal<'as_is' | 'invert'>('as_is');
  protected readonly pendingValuesText = signal('pending');

  /**
   * Column index → role. `ignore` and "not chosen" are the same thing.
   *
   * `linkedSignal` on the import id, not `signal`: this map keys on *this file's*
   * column positions, and the page reuses one instance when the reviewer moves to
   * another unmapped import. Column 3 being the amount in one bank's export says
   * nothing about the next one.
   */
  /**
   * Header token → role. `ignore` and "not chosen" are the same thing.
   *
   * **Keyed by the column's name, not its position, and that is load-bearing
   * twice over.**
   *
   * It is what gets saved: a `columnMap` addresses columns by header name, so a
   * profile keeps working when the bank adds a column and an index-keyed one
   * would silently start reading the wrong column. Every seeded profile is
   * name-addressed for the same reason.
   *
   * And it keeps the draft out of the preview's own output. Keying by position
   * meant turning a position into a name, which meant reading `headerTokens()` —
   * which comes from the preview response. The preview's params would then have
   * been a consumer of the preview's own value, and that cycle does not error:
   * the graph simply stops propagating, so the second dropdown change and every
   * one after it silently previews nothing. `linkedSignal` on the import id, so
   * one instance reused for the next unmapped file starts empty.
   */
  protected readonly roles = linkedSignal<string, ReadonlyMap<string, RoleChoice>>({
    source: () => this.importId(),
    computation: () => new Map(),
  });

  /** Assigning Debit or Credit is what makes this a two-column file (§3.1). */
  protected readonly amountMode = computed<'single' | 'debit_credit'>(() => {
    const chosen = new Set(this.roles().values());
    return chosen.has('debit') || chosen.has('credit') ? 'debit_credit' : 'single';
  });

  protected readonly hasStatusColumn = computed(() =>
    [...this.roles().values()].includes('status'),
  );

  private readonly pendingValues = computed(() =>
    this.hasStatusColumn()
      ? this.pendingValuesText()
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value !== '')
      : [],
  );

  /**
   * The roles, as the wire's `ColumnMap`.
   *
   * A file reaches this mapper only via a header its signature was computed
   * from, and name matching normalizes the same way the signature does — so the
   * lowercase token is the same column as the file's printed heading.
   */
  private readonly columnMap = computed<ColumnMap>(() => {
    const map: Record<string, { by: 'header'; name: string }> = {};
    for (const [token, role] of this.roles()) {
      if (role === 'ignore' || token === '') continue;
      map[role] = { by: 'header', name: token };
    }
    return map as ColumnMap;
  });

  /**
   * Everything that changes what the parser would produce — and nothing else.
   *
   * The institution is deliberately absent: it names the profile and has no effect
   * on a single parsed row, so typing it should not fire a preview per keystroke.
   * The loader reads it directly, which is safe because a `resource` loader is not
   * a reactive context.
   */
  private readonly parseShape = computed(() => ({
    columnMap: this.columnMap(),
    dateFormat: this.dateFormat(),
    amountMode: this.amountMode(),
    signConvention: this.signConvention(),
    pendingValues: this.pendingValues(),
  }));

  // --------------------------------------------------------- the preview ---

  protected readonly preview = resource({
    params: () => ({ importId: this.importId(), shape: this.parseShape() }),
    loader: ({ params }) =>
      this.api.previewFormatProfile({
        importId: params.importId,
        // No `delimiter`, no `skipLines`: see the note at the top of this file.
        draft: {
          institution: this.institution().trim() === '' ? 'preview' : this.institution().trim(),
          ...params.shape,
        },
      }),
  });

  /** `hasValue()` before `value()`: a `resource` in an error state throws from
   *  `value()`, and this grid must survive the API going away mid-mapping. */
  private readonly result = computed<FormatProfilePreview | null>(() =>
    this.preview.hasValue() ? this.preview.value() : null,
  );

  /** The file's own column headings, normalized. Read by the grid only — nothing
   *  the preview's params depend on may read the preview's result. */
  protected readonly headerTokens = computed<readonly string[]>(
    () => this.result()?.headerTokens ?? [],
  );
  protected readonly sampleRows = computed(() => this.result()?.sampleRows ?? []);
  protected readonly detectedDelimiter = computed(() => this.result()?.detectedDelimiter ?? '');
  protected readonly detectedSkipLines = computed(() => this.result()?.detectedSkipLines ?? 0);
  protected readonly parsedRows = computed(() => this.result()?.rows ?? []);
  protected readonly failures = computed(() => this.result()?.failures ?? []);

  /** Shown verbatim. `validateProfile` and the parser both explain themselves
   *  already, and rewording them here would mean two descriptions of one rule,
   *  drifting apart. */
  protected readonly errors = computed(() => this.result()?.errors ?? []);
  protected readonly warnings = computed(() => this.result()?.warnings ?? []);
  protected readonly parseWarnings = computed(() => this.result()?.parseWarnings ?? []);
  protected readonly balanceCheck = computed(() => this.result()?.balanceCheck ?? null);

  protected readonly canSave = computed(
    () => this.result()?.ok === true && this.institution().trim() !== '',
  );

  /**
   * §3.1 refuses `45,20` rather than read it as $4,520, and no column mapping can
   * change that. Detected from the parser's own refusal text so the note appears
   * only when it is the actual problem — the mapper should say the format is not
   * supported in v1 rather than look broken.
   */
  protected readonly decimalCommaRefusal = computed(() =>
    this.failures().some((failure) =>
      (failure.errors ?? []).some((message) => message.includes('unambiguous USD amount')),
    ),
  );

  /** A file whose header this app has not seen has no matching profile by
   *  definition, so these are all near misses by construction. */
  protected readonly copyable = computed(() => this.profiles());

  // ---------------------------------------------------------- the controls ---

  protected roleFor(token: string): RoleChoice {
    return this.roles().get(token) ?? 'ignore';
  }

  /**
   * One role, one column. Assigning Amount to a fourth column when a second one
   * already has it silently produces a profile whose amount comes from somewhere
   * the user stopped looking at, so the earlier assignment is cleared.
   */
  protected setRole(token: string, choice: string): void {
    const role = choice as RoleChoice;
    const next = new Map(this.roles());

    if (role !== 'ignore') {
      for (const [otherToken, otherRole] of next) {
        if (otherRole === role && otherToken !== token) next.delete(otherToken);
      }
    }

    if (role === 'ignore') next.delete(token);
    else next.set(token, role);

    this.roles.set(next);
  }

  protected isMapped(token: string): boolean {
    return this.roles().has(token);
  }

  /** Fill the dropdowns from a profile that nearly fits. Every column it sets is
   *  still on screen and still changeable — this is a head start, not an applied
   *  mapping (plan question 2). */
  protected copyFrom(profileId: string): void {
    const profile = this.profiles().find((candidate) => candidate.id === profileId);
    if (!profile) return;

    const tokens = new Set(this.headerTokens());
    const next = new Map<string, RoleChoice>();

    for (const { value: role } of COLUMN_ROLES) {
      const ref = profile.columnMap[role];
      // Only a name-addressed column can be carried across: an index means
      // "column 3 of that bank's export", which says nothing about this one.
      if (!ref || ref.by !== 'header' || ref.name === undefined) continue;
      const token = normalizeToken(ref.name);
      if (tokens.has(token)) next.set(token, role);
    }

    this.roles.set(next);
    this.dateFormat.set(profile.dateFormat);
    this.signConvention.set(profile.signConvention);
    if (profile.pendingValues.length > 0) {
      this.pendingValuesText.set(profile.pendingValues.join(', '));
    }
    if (this.institution().trim() === '') this.institution.set(profile.institution);
  }

  protected save(): void {
    if (!this.canSave()) return;
    this.saved.emit({
      institution: this.institution().trim(),
      dateFormat: this.dateFormat(),
      amountMode: this.amountMode(),
      signConvention: this.signConvention(),
      columnMap: this.columnMap(),
      pendingValues: this.pendingValues(),
    });
  }
}
