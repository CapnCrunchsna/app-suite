/**
 * Reading the period a statement **declares**, rather than inferring one from the
 * rows it happens to contain.
 *
 * ## Why this exists at all
 *
 * §7.2 makes a month covered "when a committed import's `[period_start,
 * period_end]` spans it", and until this file existed those two came from the
 * first and last row dates the parser saw. An ordinary January statement whose
 * first charge is the 3rd and whose last is the 30th therefore did not span
 * January — so `fullyCoveredMonths` was empty for essentially every real account,
 * and §5.10 and §5.11, which restrict themselves to that set, were correct and
 * silent. §9f diagnosed it; §9g confirmed both rules fire once the gate opens.
 *
 * ## The preamble, and only the preamble
 *
 * Banks print the period above the header, in the same block as the account
 * number and the address — which is exactly the block `skipLines` already names
 * and the parser already discards. Matching there rather than across the file
 * keeps the search bounded to a handful of short lines, and keeps a pattern that
 * happens to resemble a transaction descriptor from reading a period out of one.
 *
 * ## The dates are the profile's to read
 *
 * `parseDateToIso` against the profile's declared `dateFormat`, never
 * `Date.parse` — `domain/dates.ts` gives the reason at length, and it is the same
 * reason here as on every row: `01/02/2026` is two different days depending on the
 * bank, and nothing in the string says which.
 */

import { parseDateToIso } from '@metrum/ledgerline-domain';
import type { ParseWarning } from '@metrum/ledgerline-domain';

import { compilePeriodPattern } from './format-profile.js';
import type { FormatProfile } from './format-profile.js';

export interface DeclaredPeriod {
  readonly start: string;
  readonly end: string;
}

export interface PeriodRead {
  /** `null` when the profile declares no pattern, or when the preamble did not
   *  yield a usable pair — in both cases the caller falls back to row dates. */
  readonly period: DeclaredPeriod | null;
  readonly warnings: readonly ParseWarning[];
}

/** One preamble line, as the CSV reader saw it. */
export interface PreambleLine {
  readonly rawText: string;
  readonly lineNumber: number;
}

/**
 * The declared period, or nothing plus a reason.
 *
 * The three failure shapes are deliberately not collapsed. **No pattern** is the
 * designed case — most exports declare nothing — and is silent, because a warning
 * on every Cardinal import would train the reviewer to ignore the strip. **Pattern
 * but no match** and **match but unreadable dates** are both a profile that
 * promised something and did not deliver it, so both warn: the period silently
 * reverting to row dates is precisely the failure that took two amendments to
 * diagnose the first time.
 */
export function readDeclaredPeriod(
  preamble: readonly PreambleLine[],
  profile: FormatProfile
): PeriodRead {
  if (profile.periodPattern === null) return { period: null, warnings: [] };

  const compiled = compilePeriodPattern(profile.periodPattern);
  if (!compiled.ok) {
    // Unreachable through the parser, which validates first. Reported rather than
    // thrown so that a caller which skipped validation still degrades to row dates
    // instead of failing the whole import over a preamble.
    return {
      period: null,
      warnings: [
        {
          kind: 'declared_period_unreadable',
          message: `Profile "${profile.id}" periodPattern ${compiled.reason}. Period taken from row dates instead.`,
        },
      ],
    };
  }

  for (const line of preamble) {
    const match = compiled.regex.exec(line.rawText);
    if (!match) continue;

    const start = parseDateToIso(match[1] ?? '', profile.dateFormat);
    const end = parseDateToIso(match[2] ?? '', profile.dateFormat);

    if (!start.ok || !end.ok) {
      return {
        period: null,
        warnings: [
          {
            kind: 'declared_period_unreadable',
            message:
              `Line ${line.lineNumber} matched profile "${profile.id}"'s periodPattern, but its dates ` +
              `did not read as ${profile.dateFormat}: ${[start, end]
                .filter((parsed) => !parsed.ok)
                .map((parsed) => (parsed as { reason: string }).reason)
                .join('; ')}. Period taken from row dates instead.`,
            lineNumber: line.lineNumber,
          },
        ],
      };
    }

    // A backwards period would make `monthsBetween` return nothing and quietly
    // cost the import all of its coverage, so it is a mismatch rather than a
    // period. Swapping the two silently would be guessing which group the profile
    // meant.
    if (start.iso > end.iso) {
      return {
        period: null,
        warnings: [
          {
            kind: 'declared_period_unreadable',
            message:
              `Line ${line.lineNumber} declares a period that ends before it starts ` +
              `(${start.iso} to ${end.iso}) — the pattern's two capture groups may be the wrong way ` +
              `round. Period taken from row dates instead.`,
            lineNumber: line.lineNumber,
          },
        ],
      };
    }

    return { period: { start: start.iso, end: end.iso }, warnings: [] };
  }

  return {
    period: null,
    warnings: [
      {
        kind: 'declared_period_unreadable',
        message:
          `Profile "${profile.id}" declares a periodPattern, but none of the ${preamble.length} ` +
          `preamble line${preamble.length === 1 ? '' : 's'} matched it. The bank may have changed its ` +
          `export, or skipLines may be too small. Period taken from row dates instead.`,
      },
    ],
  };
}

/**
 * §6.1's review strip: "dates outside the detected period".
 *
 * Only worth computing against a *declared* period. Against a derived one the
 * check is vacuous by construction — the period is the min and max of the very
 * dates being tested — which is why §6.1 has asked for this since before it could
 * be answered.
 *
 * A warning, never a rejection. A statement legitimately carries the odd row
 * outside its cycle (a late-posting charge, a correction), and the rows are real
 * either way; what the reviewer needs to know is that coverage is being claimed
 * for a window some of this file's own rows fall outside of.
 */
export function checkRowsInPeriod(
  dates: readonly string[],
  period: DeclaredPeriod
): ParseWarning | null {
  const outside = dates.filter((date) => date < period.start || date > period.end);
  if (outside.length === 0) return null;

  const sorted = [...outside].sort();

  return {
    kind: 'rows_outside_period',
    message:
      `${outside.length} of ${dates.length} rows fall outside the declared statement period ` +
      `${period.start} to ${period.end} (${sorted[0]} to ${sorted[sorted.length - 1]}). ` +
      `The rows are kept; coverage is claimed for the declared period only (§7.2).`,
  };
}
