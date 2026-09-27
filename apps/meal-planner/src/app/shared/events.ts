/** The `detail.value` of an Ionic input/segment/searchbar event, as a string. */
export function eventValue(event: Event): string {
  const value = (event as CustomEvent<{ value?: string | number | null }>).detail?.value;
  return value === null || value === undefined ? '' : String(value);
}

/** A number from a text field, or null when it is blank or not a number. */
export function parseNumber(text: string): number | null {
  const trimmed = text.trim().replace(',', '.');
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}
