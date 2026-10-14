import type { Resource } from '@angular/core';

/**
 * A resource's value, or `fallback` while it is in its error state.
 *
 * `Resource.value()` **throws** once a load has failed, so a `computed` that
 * reads it unguarded takes the whole page down rather than showing the page's
 * own "could not read" notice. Nothing hit this while the API answered a
 * datastore outage with a 200 of defaults; once it answered a 503 (2026-10-13)
 * the dashboard, whose tiles read four resources ungated, threw on load.
 */
export function valueOr<T>(resource: Resource<T>, fallback: T): T {
  return resource.hasValue() ? resource.value() : fallback;
}
