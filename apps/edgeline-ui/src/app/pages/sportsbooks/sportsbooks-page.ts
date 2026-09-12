/**
 * §11.1's sportsbooks page — "table with enable toggles, priority, link-template
 * editor + 'test link' button".
 *
 * This is the page that decides what the detectors can see. A book has to be
 * enabled here before its prices reach §6.4/§6.5 at all, and §6.4 needs
 * `min_books_for_consensus` *other* books quoting the same market — one more
 * book than the setting names — before any of them can be priced. The dashboard
 * does that arithmetic; this page is where the answer changes.
 *
 * ## What "test link" can honestly do
 *
 * §16.3: never guess a deep-link URL schema. Eight books carry a verified
 * `book_home` and nothing above it, so every stake leg still carries
 * `deep_link: ""` and `link_level: "none"` — that is T4.3's work, and it is work
 * a *person* does, because nothing else can. A fetch from this machine gets a
 * 403 from the books with bot protection and an empty shell from the rest, and
 * some of those answer 200 for a mistyped path as readily as a real one. Your
 * browser renders the page; that is the whole difference.
 *
 * So the button tests what the user pasted, and only when it is testable. A
 * template with an unfilled `{event_id}` in it is not a URL, and opening it
 * would either 404 or — worse — land on some other page of a real sportsbook
 * while the reader concludes the template works. The button therefore refuses,
 * and says the thing that is actually useful at that moment: paste the concrete
 * URL first, confirm it opens the right market, *then* replace the id with the
 * placeholder. `book_home` has no placeholders and tests directly.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  resource,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Panel } from '@metrum/ui';
import type { SportsbookRow } from '@metrum/edgeline-api-client';

import { EdgelineApiService } from '../../edgeline-api.service';

/** §9.4's ladder, highest first. `none` is the honest state below all of them
 *  and is not editable — it is what you have when none of these are filled. */
const LINK_LEVELS = ['betslip', 'event', 'league', 'book_home'] as const;
type LinkLevel = (typeof LINK_LEVELS)[number];

type Draft = Record<LinkLevel, string>;

/** Built from `LINK_LEVELS` rather than written out, so adding a rung to the
 *  ladder cannot leave a field the editor silently never shows. Adding `league`
 *  is what found the two hand-written copies this replaces. */
function emptyDraft(): Draft {
  return Object.fromEntries(LINK_LEVELS.map((level) => [level, ''])) as Draft;
}

@Component({
  selector: 'el-sportsbooks-page',
  imports: [FormsModule, Panel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './sportsbooks-page.html',
  styleUrl: './sportsbooks-page.scss',
})
export class SportsbooksPage {
  private readonly api = inject(EdgelineApiService);

  protected readonly levels = LINK_LEVELS;
  protected readonly busy = signal<string | null>(null);
  protected readonly failure = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly editing = signal<string | null>(null);
  protected readonly draft = signal<Draft>(emptyDraft());

  private readonly booksResource = resource({
    params: () => 0,
    loader: () => this.api.listSportsbooks(),
    defaultValue: [] as SportsbookRow[],
  });

  protected readonly books = computed(() => this.booksResource.value());
  protected readonly loading = this.booksResource.isLoading;
  protected readonly loadError = computed(() => this.booksResource.error());
  protected readonly enabledCount = computed(
    () => this.books().filter((book) => book.enabled === true).length,
  );

  protected async setEnabled(book: SportsbookRow, enabled: boolean): Promise<void> {
    await this.patch(book.id, { enabled }, `${label(book)} ${enabled ? 'enabled' : 'disabled'}.`);
  }

  protected async setPriority(book: SportsbookRow, value: string): Promise<void> {
    const priority = Number(value);
    if (!Number.isFinite(priority) || priority < 0) return;
    if (priority === book.priority) return;
    await this.patch(book.id, { priority }, `${label(book)} priority set to ${priority}.`);
  }

  protected openLinks(book: SportsbookRow): void {
    this.editing.set(book.id);
    const templates = book.link_templates ?? {};
    this.draft.set(
      Object.fromEntries(
        LINK_LEVELS.map((level) => [level, readTemplate(templates, level)]),
      ) as Draft,
    );
  }

  protected closeLinks(): void {
    this.editing.set(null);
    this.draft.set(emptyDraft());
  }

  protected setDraft(level: LinkLevel, value: string): void {
    this.draft.update((current) => ({ ...current, [level]: value }));
  }

  protected async saveLinks(book: SportsbookRow): Promise<void> {
    const draft = this.draft();
    // Omit the empty rungs rather than storing `""`. §9.4 walks the ladder
    // looking for a template that is present; a blank string is present.
    const templates: Record<string, string> = {};
    for (const level of LINK_LEVELS) {
      const value = draft[level].trim();
      if (value) templates[level] = value;
    }
    await this.patch(
      book.id,
      { link_templates: templates },
      Object.keys(templates).length === 0
        ? `${label(book)} has no link templates — legs will render as "no link".`
        : `${label(book)} link templates saved: ${Object.keys(templates).join(', ')}.`,
    );
    this.closeLinks();
  }

  /** What a rung is meant to hold, shown as the input's own placeholder text.
   *  `league` and `book_home` are plain URLs — which is exactly why they are the
   *  rungs that can be confirmed by opening them. */
  protected hintFor(level: LinkLevel): string {
    switch (level) {
      case 'book_home':
        return 'https://sportsbook.example.com/';
      case 'league':
        return 'https://sportsbook.example.com/leagues/baseball/mlb';
      default:
        return 'https://sportsbook.example.com/event/{event_id}';
    }
  }

  /** A template with an unfilled placeholder is not a URL. */
  protected placeholders(template: string): string[] {
    return [...template.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
  }

  protected testable(template: string): boolean {
    const value = template.trim();
    if (!value || this.placeholders(value).length > 0) return false;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  }

  protected whyNotTestable(template: string): string {
    const value = template.trim();
    if (!value) return 'Nothing to test yet.';
    const holes = this.placeholders(value);
    if (holes.length > 0) {
      return `Has ${holes.map((hole) => `{${hole}}`).join(', ')} in it, so it is not a URL yet. Paste a real event URL from the book, test that it opens the right market, then replace the ids with the placeholders.`;
    }
    return 'Not a valid http(s) URL.';
  }

  /** Opens what the user typed, in a new tab. Nothing is fetched or parsed —
   *  the reader is the one confirming it landed on the right market. */
  protected testLink(template: string): void {
    if (!this.testable(template)) return;
    window.open(template.trim(), '_blank', 'noopener,noreferrer');
  }

  /** §9.4's ladder as a summary for the table. */
  protected linkSummary(book: SportsbookRow): string {
    const templates = book.link_templates ?? {};
    const present = LINK_LEVELS.filter((level) => readTemplate(templates, level) !== '');
    return present.length === 0 ? 'none' : present.join(', ');
  }

  protected hasLinks(book: SportsbookRow): boolean {
    return this.linkSummary(book) !== 'none';
  }

  private async patch(key: string, body: Record<string, unknown>, success: string): Promise<void> {
    this.busy.set(key);
    this.failure.set(null);
    this.notice.set(null);
    try {
      await this.api.patchSportsbook(key, body);
      this.booksResource.reload();
      this.notice.set(success);
    } catch (cause) {
      this.failure.set(cause instanceof Error ? cause.message : String(cause));
    } finally {
      this.busy.set(null);
    }
  }
}

function readTemplate(templates: Record<string, unknown>, level: LinkLevel): string {
  const value = templates[level];
  return typeof value === 'string' ? value : '';
}

function label(book: SportsbookRow): string {
  return book.display_name ?? book.id;
}
