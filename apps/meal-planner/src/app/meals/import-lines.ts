/**
 * The import review's per-line rules (meal-planner-spec.md §8, §6), apart from the
 * component so they can be tested without a browser.
 *
 * A line is linked to a product (auto-mapped or chosen), or marked to taste, or left
 * unlinked — kept as text, counted as nothing. A linked line's amount is converted into
 * the product's own unit; when that conversion is an estimate — cups of something sold by
 * weight (§6 rule 3), or "1 can" of something sold by weight or volume, read as one
 * package — the line says so and must be confirmed before the meal can be saved.
 */

import { convertForProduct, trimNumber, type IngredientDraft, type Product } from '@metrum/meal-planner-domain';
import type { ImportedLine } from '@metrum/meal-planner-import';
import { parseNumber } from '../shared/events';

export interface ReviewLine {
  readonly key: number;
  readonly source: ImportedLine;
  readonly product: Product | null;
  readonly toTaste: boolean;
  /** In the product's base unit. */
  readonly quantity: string;
  /** Why the amount is an estimate, while it awaits confirmation; null once confirmed. */
  readonly estimate: string | null;
}

export type LineStatus = 'linked' | 'estimated' | 'needs-amount' | 'unlinked' | 'to-taste';

export function initialLine(key: number, source: ImportedLine, product: Product | null): ReviewLine {
  const toTaste = source.parsed.toTaste;
  const { quantity, estimate } = product && !toTaste ? amountFor(source, product) : { quantity: null, estimate: null };
  return { key, source, product: toTaste ? null : product, toTaste, quantity: quantity === null ? '' : trimNumber(quantity), estimate };
}

/** Re-link a line to `product`, recomputing its amount from the recipe's own words. */
export function relink(line: ReviewLine, product: Product): ReviewLine {
  const { quantity, estimate } = amountFor(line.source, product);
  return { ...line, product, toTaste: false, quantity: quantity === null ? '' : trimNumber(quantity), estimate };
}

export function amountFor(line: ImportedLine, product: Product): { quantity: number | null; estimate: string | null } {
  const { qty, unit, rawUnit } = line.parsed;
  if (qty === null || unit === null) return { quantity: null, estimate: null };
  if (rawUnit === 'can' && product.packageUnit !== 'COUNT') {
    return { quantity: qty * product.packageAmount, estimate: `${trimNumber(qty)} can read as ${trimNumber(qty)} package` };
  }
  const conversion = convertForProduct(qty, unit, product);
  if (conversion.kind === 'direct') return { quantity: conversion.quantity, estimate: null };
  if (conversion.kind === 'confirm') {
    return { quantity: conversion.quantity, estimate: `estimated from ${rawUnit ?? 'volume'} at ${conversion.gramsPerCup} g per cup` };
  }
  return { quantity: null, estimate: null };
}

export function lineStatus(line: ReviewLine): LineStatus {
  if (line.toTaste) return 'to-taste';
  if (!line.product) return 'unlinked';
  const n = parseNumber(line.quantity);
  if (n === null || n <= 0) return 'needs-amount';
  return line.estimate ? 'estimated' : 'linked';
}

/** Lines that stop the meal from saving: an unconfirmed estimate or a missing amount. */
export function blocking(lines: readonly ReviewLine[]): number {
  return lines.filter((l) => {
    const s = lineStatus(l);
    return s === 'estimated' || s === 'needs-amount';
  }).length;
}

export function toDraft(line: ReviewLine): IngredientDraft {
  const status = lineStatus(line);
  if (status === 'linked' || status === 'estimated') {
    return {
      productId: line.product?.id ?? null,
      quantity: parseNumber(line.quantity),
      unit: line.product?.packageUnit ?? null,
      displayText: line.source.original,
      toTaste: false,
    };
  }
  return { productId: null, quantity: null, unit: null, displayText: line.source.original, toTaste: status === 'to-taste' };
}
