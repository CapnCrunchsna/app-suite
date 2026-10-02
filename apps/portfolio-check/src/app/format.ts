const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export function money(n: number): string {
  return usd.format(Number.isFinite(n) ? n : 0);
}

/** Axis labels: $250k, $1.2M. */
export function moneyShort(n: number): string {
  if (Math.abs(n) >= 1e6) return `$${+(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `$${Math.round(n / 1e3)}k`;
  return `$${Math.round(n)}`;
}

/** A fraction as a percent: 0.0125 → "1.25%". */
export function percent(fraction: number, digits = 2): string {
  return `${((Number.isFinite(fraction) ? fraction : 0) * 100).toFixed(digits)}%`;
}
