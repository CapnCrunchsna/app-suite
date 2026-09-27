/**
 * One recipe ingredient line → quantity, unit, name (meal-planner-spec.md §8.1, exactly).
 *
 * Deterministic and deliberately small: six steps, a unit table, no language model
 * (§13.1). It does not have to be right about every line — every import lands in a review
 * screen — it has to be right about the common shapes and never confidently wrong about
 * the rest, which is why anything it cannot place keeps its words in `name` and leaves
 * the quantity null for the person to fill.
 */

import { toBase, type BaseUnit, type RawUnit } from '@metrum/meal-planner-domain';

export interface ParsedIngredient {
  /** In `unit` (base), or null when the line has no leading quantity. */
  readonly qty: number | null;
  readonly unit: BaseUnit | null;
  /** The unit as written, normalized: `cup`, `tbsp`, `lb`, `can`… */
  readonly rawUnit: RawUnit | null;
  readonly name: string;
  readonly note: string | null;
  readonly toTaste: boolean;
}

const UNICODE_FRACTIONS: Readonly<Record<string, string>> = {
  '¼': '1/4',
  '½': '1/2',
  '¾': '3/4',
  '⅓': '1/3',
  '⅔': '2/3',
  '⅕': '1/5',
  '⅛': '1/8',
};

/** §8.1 step 5's table, in match order: `fl oz` must be tried before `oz`. */
const UNIT_PATTERNS: readonly [RegExp, RawUnit][] = [
  [/^fl\.?\s*oz\.?(?=\s|$)/i, 'floz'],
  [/^cups?\b/i, 'cup'],
  [/^(?:tablespoons?|tbsps?)\b\.?/i, 'tbsp'],
  [/^(?:teaspoons?|tsps?)\b\.?/i, 'tsp'],
  [/^(?:ounces?|oz)\b\.?/i, 'oz'],
  [/^(?:pounds?|lbs?)\b\.?/i, 'lb'],
  [/^(?:grams?|g)\b/i, 'g'],
  [/^(?:kilograms?|kgs?)\b/i, 'kg'],
  [/^(?:milliliters?|millilitres?|ml)\b/i, 'ml'],
  [/^(?:liters?|litres?|l)\b/i, 'l'],
  [/^cans?\b/i, 'can'],
  [/^slices?\b/i, 'slice'],
  [/^cloves?\b/i, 'clove'],
  [/^pinch(?:es)?\b/i, 'pinch'],
];

/** §8.1 step 2's phrases, plus "to serve" — the British "for serving". */
const TO_TASTE = /,?\s*\b(?:to taste|to serve|for serving|for garnish|optional)\b/gi;
/** The fraction branch first: alternation takes the first branch that matches (§8.1 step 4). */
const LEADING_QTY = /^(\d+\/\d+|\d+(?:\.\d+)?)/;
/** "2-3 cups", "2 to 3 cups": the lower bound is the quantity; the rest is skipped. */
const RANGE_TAIL = /^\s*(?:-|–|to)\s*\d+(?:\.\d+)?(?:\/\d+)?/i;

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

export function parseIngredient(line: string): ParsedIngredient {
  // 1. Whitespace, unicode fractions, mixed numbers.
  let s = collapse(line)
    .replace(/(\d)?\s*([¼½¾⅓⅔⅕⅛])/g, (_m, whole: string | undefined, frac: string) =>
      whole ? `${whole} ${UNICODE_FRACTIONS[frac]}` : UNICODE_FRACTIONS[frac],
    )
    .replace(/(\d+)\s+(\d+)\/(\d+)/g, (_m, whole: string, num: string, den: string) =>
      String(Number(whole) + Number(num) / Number(den)),
    );

  // 2. To-taste phrases flag the line and leave it.
  let toTaste = false;
  s = collapse(
    s.replace(TO_TASTE, () => {
      toTaste = true;
      return '';
    }),
  );

  // 3. Parentheticals become notes — innermost first, because recipe plugins nest them:
  //    "bacon (, trimmed, chopped (Note 1))". Their leading commas are layout, not words.
  const notes: string[] = [];
  let previous: string;
  do {
    previous = s;
    s = s.replace(/\(([^()]*)\)/g, (_m, inner: string) => {
      const note = inner.replace(/^[\s,;]+|[\s,;]+$/g, '');
      if (note) notes.push(note);
      return ' ';
    });
  } while (s !== previous);
  s = collapse(s.replace(/[()]/g, ' '));

  // 4. Leading quantity.
  let qty: number | null = null;
  const q = LEADING_QTY.exec(s);
  if (q) {
    qty = q[1].includes('/') ? Number(q[1].split('/')[0]) / Number(q[1].split('/')[1]) : Number(q[1]);
    s = s.slice(q[0].length).replace(RANGE_TAIL, '').trim();
  }

  // 5. Unit, only after a quantity.
  let rawUnit: RawUnit | null = null;
  let unit: BaseUnit | null = null;
  if (qty !== null) {
    for (const [pattern, raw] of UNIT_PATTERNS) {
      const m = pattern.exec(s);
      if (!m) continue;
      rawUnit = raw;
      s = s.slice(m[0].length).trim();
      break;
    }
    const base = toBase(qty, rawUnit);
    qty = round(base.quantity);
    unit = base.unit;
  }

  // 6. "of", name before the first comma, the rest into the note.
  s = s.replace(/^of\s+/i, '');
  const comma = s.indexOf(',');
  // Asterisks are footnote marks ("small carrot*"), never part of the food.
  const name = collapse((comma >= 0 ? s.slice(0, comma) : s).replace(/\*/g, '')).toLowerCase();
  if (comma >= 0) {
    const rest = s.slice(comma + 1).trim();
    if (rest) notes.push(rest);
  }

  return { qty, unit, rawUnit, name, note: notes.length > 0 ? notes.join('; ') : null, toTaste };
}

/** Six decimals: enough for any kitchen measure, and 1.5 × 453.6 reads 680.4, not 680.4000000000001. */
function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
