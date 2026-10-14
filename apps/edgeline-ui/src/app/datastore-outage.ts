/**
 * "The API is up and Elasticsearch behind it is not" — told apart from "the API
 * is not answering", added 2026-10-13.
 *
 * The two need different things done about them, and only one of them was ever
 * said. With Docker Desktop stopped, the API answered every request (slowly)
 * with empty tables and §3.2's defaults, and the dashboard drew an unconfigured
 * install: "0 books enabled", "worker never seen". The API now answers a **503
 * whose `detail.code` is `datastore_unavailable`** instead (`edgeline/api/
 * datastore.py`), and this is the one place that reads it.
 */

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export interface DatastoreOutage {
  /** `unreachable`: nothing is listening — Docker or the container is down.
   *  `recovering`: the cluster is up and still assigning shards after a start. */
  readonly reason: 'unreachable' | 'recovering';
  readonly message: string;
}

/** The outage a failed call reports, or `null` for any other failure. Duck-typed
 *  on `EdgelineApiError`'s `status`/`body`, so a test double needs no class. */
export function datastoreOutage(cause: unknown): DatastoreOutage | null {
  if (!cause || typeof cause !== 'object') return null;
  const { status, body } = cause as { status?: unknown; body?: unknown };
  if (status !== 503 || !body || typeof body !== 'object') return null;
  const detail = (body as { detail?: unknown }).detail;
  if (!detail || typeof detail !== 'object') return null;
  const { code, reason, message } = detail as Record<string, unknown>;
  if (code !== 'datastore_unavailable') return null;
  return {
    reason: reason === 'recovering' ? 'recovering' : 'unreachable',
    message: typeof message === 'string' ? message : '',
  };
}

/**
 * The text of a page's "could not read" notice, inside the page's own
 * `<p class="failure">` so the page keeps its styling.
 *
 * Seven pages said "the engine has to be running: `nx run edgeline-api:serve`"
 * for every failure, which during an outage sends the reader to restart the one
 * process that is fine. The shell's banner carries the steps; this points at it.
 */
@Component({
  selector: 'el-load-failure',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (outage()?.reason) {
      @case ('unreachable') {
        Could not read {{ what() }}: Elasticsearch is down, so the engine has nothing to read
        from. The banner at the top says how to bring it back.
      }
      @case ('recovering') {
        Could not read {{ what() }}: Elasticsearch is still starting up. This clears by itself
        within a minute or so.
      }
      @default {
        Could not read {{ what() }}. The engine has to be running:
        <code>nx run edgeline-api:serve</code>.
      }
    }
  `,
})
export class LoadFailure {
  /** What the page was reading, as it reads in a sentence: "opportunities". */
  readonly what = input.required<string>();
  readonly cause = input<unknown>(null);

  protected readonly outage = computed(() => datastoreOutage(this.cause()));
}
