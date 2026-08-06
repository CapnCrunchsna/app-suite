/**
 * The two ambient values every write needs, injected rather than imported.
 *
 * §3.1 requires the repository layer to set `id`, `created_at` and `updated_at`
 * on every write. Both of those come from outside the pure computation, and a
 * test that wants to assert the ordering of two writes, or that a re-import
 * inserted nothing, should not have to sleep or match a timestamp regex. So
 * they are parameters of the store, with real implementations as the default.
 */

export interface Clock {
  /** ISO 8601 with a `Z`. Stored in `created_at` / `updated_at`. */
  now(): string;
  /** A fresh surrogate id. Opaque everywhere above `data`. */
  newId(): string;
}

export function systemClock(randomUUID: () => string): Clock {
  return {
    now: () => new Date().toISOString(),
    newId: randomUUID,
  };
}

/**
 * A clock whose timestamps advance one millisecond per call and whose ids are a
 * counter under a caller-supplied prefix.
 *
 * Monotonic rather than frozen on purpose: `updated_at` is the watermark an
 * Elasticsearch re-index reads (§3.4), so a fixture where every row shares one
 * timestamp would make a broken watermark query look correct.
 */
export function fixedClock(startIso = '2026-01-01T00:00:00.000Z', prefix = 'id'): Clock {
  let millis = Date.parse(startIso);
  let counter = 0;
  return {
    now: () => new Date(millis++).toISOString(),
    newId: () => `${prefix}-${String(++counter).padStart(6, '0')}`,
  };
}
