/**
 * §6.8's **LLM provider** and **Redaction** sections.
 *
 * "LLM provider — `none` (default) / `claude-cli` / `ollama`, with a Test Connection
 * button and health detail. Selecting `claude-cli` shows a prominent warning card
 * [...] While it's active, a persistent indicator sits in the app header."
 *
 * "Redaction — strips account numbers, last4 and counterparty names, and hard-filters
 * P2P descriptors (§2.4). On by default and not disableable while `claude-cli` is
 * selected."
 *
 * ## Nothing applies on selection
 *
 * The same rule `merchant-review.ts` states for a merge, and it is here for a
 * sharper reason: one of these three options starts sending statement text to
 * Anthropic. A picker that committed on `change` would make that a consequence of
 * arrowing through a dropdown. So choosing arms, the warning card appears, and a
 * second explicit click applies — and the button says what it is about to turn on.
 *
 * ## Two booleans for redaction, and neither is derived here
 *
 * `redaction` is what is in force and `redactionLocked` is whether the user may
 * change it. Both come from the API (`buildLlmSettings`), because §6.8's clamp is a
 * rule about what the *server* will accept and a page that re-derived it would be a
 * second implementation of a privacy control — the failure `redact.ts` describes in
 * a different setting: "a privacy control that has to be remembered at every call
 * site is a privacy control that eventually is not."
 *
 * Presentational, like every other child on this page: the container owns the write.
 */

import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { LlmHealth, LlmSettings } from '@metrum/api-client';

export type LlmProviderId = LlmSettings['providerId'];

/** What the page is being asked to write. Partial, matching `PATCH /api/settings`:
 *  an absent field leaves that setting alone. */
export interface LlmChange {
  readonly providerId?: LlmProviderId;
  readonly model?: string | null;
  readonly redaction?: boolean;
}

interface ProviderOption {
  readonly id: LlmProviderId;
  readonly label: string;
  readonly detail: string;
}

/**
 * The three, described by what they *do to your data* rather than by what they are.
 *
 * "Claude CLI" tells a reader nothing about the decision in front of them. Which
 * machine the descriptors end up on is the whole decision, so it is the sentence.
 */
const PROVIDERS: readonly ProviderOption[] = [
  {
    id: 'none',
    label: 'None',
    detail:
      'Nothing is sent anywhere. Merchants are grouped by the app’s own rules, which is how ' +
      'every number in this app is produced either way — a provider only ever adds to them.',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    detail:
      'A model running on this machine, on 127.0.0.1. Descriptors are sent to it and stay ' +
      'here. Needs Ollama installed and the model pulled.',
  },
  {
    id: 'claude-cli',
    label: 'Claude CLI',
    detail:
      'Uses the `claude` command-line tool. This is the one option that sends statement text ' +
      'off this machine.',
  },
];

/** §6.8 quotes this card verbatim. Kept as one string so it stays quotable. */
export const CLAUDE_CLI_WARNING =
  'The Claude CLI provider sends statement text — merchant descriptors, and for Q&A, ' +
  'aggregated amounts — off this machine to Anthropic. Ollama and None keep everything local.';

@Component({
  selector: 'll-llm-settings',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './llm-settings.html',
  styleUrl: './llm-settings.scss',
})
export class LlmSettingsPanel {
  readonly settings = input.required<LlmSettings>();
  readonly busy = input(false);
  /** The last probe, or null if Test Connection has not been pressed. Held by the
   *  page rather than here, because the request is the page's (see the header). */
  readonly health = input<LlmHealth | null>(null);
  readonly probing = input(false);

  readonly changed = output<LlmChange>();
  readonly tested = output<void>();

  protected readonly providers = PROVIDERS;
  protected readonly warning = CLAUDE_CLI_WARNING;

  /** The armed selection, or null when it matches what is already in force. */
  private readonly picked = signal<LlmProviderId | null>(null);
  protected readonly draftModel = signal<string | null>(null);

  protected readonly selected = computed<LlmProviderId>(
    () => this.picked() ?? this.settings().providerId,
  );

  /** True when the armed selection differs from what is stored — which is exactly
   *  when the Apply button has anything to do. */
  protected readonly dirty = computed(
    () =>
      this.selected() !== this.settings().providerId ||
      (this.draftModel() !== null && this.draftModel() !== (this.settings().model ?? '')),
  );

  /** The warning card shows for the *armed* choice, not the stored one. Its whole
   *  job is to be read before the click that commits, and a card that appeared
   *  afterwards would be a notification. */
  protected readonly showsWarning = computed(() => this.selected() === 'claude-cli');

  protected readonly modelValue = computed(
    () => this.draftModel() ?? this.settings().model ?? '',
  );

  /** Ollama is the only one with a model worth naming here — the CLI takes its
   *  own configuration, and `none` has nothing to run. */
  protected readonly showsModel = computed(() => this.selected() === 'ollama');

  protected pick(providerId: LlmProviderId): void {
    this.picked.set(providerId);
  }

  protected apply(): void {
    if (this.busy() || !this.dirty()) return;
    const model = this.draftModel();

    this.changed.emit({
      providerId: this.selected(),
      ...(model === null ? {} : { model: model.trim() === '' ? null : model.trim() }),
    });

    this.picked.set(null);
    this.draftModel.set(null);
  }

  protected cancel(): void {
    this.picked.set(null);
    this.draftModel.set(null);
  }

  /** Redaction is the one control that *does* apply on change, and that is not an
   *  inconsistency: it is a single boolean whose safe state is the default, and
   *  the server refuses the unsafe combination outright (§6.8). */
  protected toggleRedaction(on: boolean): void {
    if (this.busy() || this.settings().redactionLocked) return;
    this.changed.emit({ redaction: on });
  }

  protected test(): void {
    if (this.probing()) return;
    this.tested.emit();
  }
}
