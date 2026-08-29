/**
 * §6.7's numeric post-validation, which is the clause that makes the section's
 * headline claim checkable rather than aspirational.
 *
 * "Every numeric token in the model's prose must appear in the returned rows or be a
 * simple aggregate of them (sum, difference, mean, percentage of two present
 * values). An answer that fails validation is not shown; the table is shown instead
 * with a note. This is what converts 'no hallucinated numbers' from a hope into a
 * check."
 *
 * ## Why this is not "ask the model to be careful"
 *
 * The rest of §6.7 is structural: the model cannot reach the database, cannot write
 * SQL, and for row-level queries cannot even see the rows. What it *can* still do is
 * write "you spent $412 on coffee" over a table that says $391 — a number that came
 * from nowhere, in prose that reads exactly like the true version. No amount of
 * prompt wording fixes that, because the failure is indistinguishable from success
 * until someone checks the arithmetic. So the arithmetic is checked.
 *
 * ## What counts as present
 *
 * Every number reachable in the result, in both the units it is stored in and the
 * units it is written in — `amountCents: 109_900` has to admit "$1,099.00", because
 * cents are an implementation detail the prose has no reason to know about. Then
 * §6.7's four derived forms over those values: the total, pairwise differences, the
 * mean, and pairwise percentages.
 *
 * Pairwise is O(n²) and that is affordable only because the input is bounded — an
 * aggregate result is category or month totals, and a row-level one is capped at
 * twenty descriptors before it reaches a model at all. `MAX_PAIRWISE` makes the
 * bound explicit rather than inherited, because a future query returning more rows
 * should degrade to "unvalidatable" rather than quietly spend a second here.
 *
 * ## Tolerance, and why it is not zero
 *
 * A model writing "about $1,100" over a value of $1,099.40 is rounding, not
 * hallucinating, and §6.7's purpose is not served by rejecting it. Comparison is at
 * two decimal places with a relative tolerance for rounded figures. A number that is
 * merely *close* to nothing in the result still fails.
 */

/** Above this many values, pairwise derivation is skipped — see the header. */
const MAX_PAIRWISE = 60;

/** Two decimal places, plus 0.5% for prose that rounds. */
const ABSOLUTE_EPSILON = 0.005;
const RELATIVE_EPSILON = 0.005;

export interface NumericCheck {
  readonly ok: boolean;
  /** The tokens that are not accounted for. Empty when `ok`. */
  readonly unsupported: readonly string[];
}

/**
 * Every numeric token in a piece of prose.
 *
 * Matches an optional currency sign, digits with optional thousands separators, an
 * optional decimal part, and an optional trailing percent. Ordinals and years come
 * out too and are handled by the present-set rather than by the pattern — a date in
 * the answer is a number that had better be in the rows.
 */
export function numericTokens(prose: string): string[] {
  return [...prose.matchAll(/-?\$?\d[\d,]*(?:\.\d+)?%?/g)].map((match) => match[0]);
}

function toNumber(token: string): number | null {
  const cleaned = token.replace(/[$,%]/g, '').replace(/,/g, '');
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** Every number reachable in a value, however nested. */
function harvest(value: unknown, into: Set<number>): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    into.add(value);
    // The same amount in the units prose uses. `amountCents` is the only integer
    // scale in this system, so this is the one conversion worth admitting.
    if (Number.isInteger(value) && Math.abs(value) >= 100) into.add(value / 100);
    return;
  }
  if (typeof value === 'string') {
    // Month labels and ISO dates carry numbers a sentence may legitimately quote.
    for (const part of value.matchAll(/\d+(?:\.\d+)?/g)) {
      const parsed = Number(part[0]);
      if (Number.isFinite(parsed)) into.add(parsed);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) harvest(item, into);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) harvest(item, into);
  }
}

/**
 * The set of values an answer may legitimately contain.
 *
 * Built once per answer and reused across tokens, because the derived set is the
 * expensive half and every token is checked against the same one.
 */
export function supportedValues(result: unknown): Set<number> {
  const present = new Set<number>();
  harvest(result, present);

  const base = [...present];
  const derived = new Set<number>(base);

  // The total, which is the aggregate a sentence reaches for most often.
  const sum = base.reduce((total, value) => total + value, 0);
  derived.add(sum);
  derived.add(Math.abs(sum));

  if (base.length > 0 && base.length <= MAX_PAIRWISE) {
    derived.add(sum / base.length);

    for (let i = 0; i < base.length; i += 1) {
      // Magnitudes, because §7.3's amounts are signed and prose says "spent $40"
      // where the row says -4000.
      derived.add(Math.abs(base[i]));

      for (let j = i + 1; j < base.length; j += 1) {
        derived.add(Math.abs(base[i] - base[j]));
        derived.add(base[i] + base[j]);
        if (base[j] !== 0) derived.add(Math.abs((base[i] / base[j]) * 100));
        if (base[i] !== 0) derived.add(Math.abs((base[j] / base[i]) * 100));
      }
    }
  }

  return derived;
}

const matches = (token: number, value: number): boolean => {
  const difference = Math.abs(token - value);
  if (difference <= ABSOLUTE_EPSILON) return true;
  const scale = Math.max(Math.abs(token), Math.abs(value));
  return scale > 0 && difference / scale <= RELATIVE_EPSILON;
};

/**
 * §6.7's check.
 *
 * Returns the unsupported tokens rather than a bare boolean, because the caller
 * shows a note and "the numbers in that answer did not match the table" is a
 * different message from "the model was unavailable" — and because a developer
 * reading a failure wants to know which number.
 */
export function checkNumbers(prose: string, result: unknown): NumericCheck {
  const supported = supportedValues(result);
  const unsupported: string[] = [];

  for (const token of numericTokens(prose)) {
    const value = toNumber(token);
    if (value === null) continue;
    // Small integers are ordinals and counts far more often than they are claims —
    // "the top 3", "over 12 months". Anything at this scale that is genuinely a
    // money figure is also below the threshold at which being wrong matters.
    if (Number.isInteger(value) && Math.abs(value) <= 12) continue;

    let ok = false;
    for (const candidate of supported) {
      if (matches(value, candidate)) {
        ok = true;
        break;
      }
    }
    if (!ok) unsupported.push(token);
  }

  return { ok: unsupported.length === 0, unsupported };
}
