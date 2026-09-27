/**
 * The network port (meal-planner-spec.md §2): this lib builds URLs and reads bodies, and
 * the app decides how bytes cross the wire — `CapacitorHttp` on a phone, where recipe
 * sites' missing CORS headers do not apply, and `fetch` in the browser build.
 *
 * An implementation resolves with any HTTP status it received and **rejects only when
 * nothing came back** (offline, DNS, timeout). Callers rely on that split: a 404 is an
 * answer, a rejection means "could not ask".
 */

export interface HttpResponse {
  readonly status: number;
  readonly body: string;
}

export type HttpGet = (url: string, headers?: Readonly<Record<string, string>>) => Promise<HttpResponse>;

export function describeFailure(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'the request did not complete';
}
