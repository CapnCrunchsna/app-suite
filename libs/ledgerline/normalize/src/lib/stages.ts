/**
 * Stages 1–5 of the deterministic merchant chain (§4.1).
 *
 * "Runs in order, each stage cheap and inspectable. This is rules-first on purpose: it
 * is fast, reproducible, debuggable, and works with the LLM off."
 *
 * Each stage is an exported pure `string -> string` so it can be tested and traced in
 * isolation. `runStages` threads them and records what each one did, which is what
 * makes a bad transform findable instead of merely suspected.
 */

import { COUNTRY_CODES, PROCESSOR_PREFIXES, US_STATE_CODES } from './tables.js';

export interface StageTrace {
  readonly stage: number;
  readonly name: string;
  readonly before: string;
  readonly after: string;
}

/**
 * **Stage 1 — case and whitespace.**
 *
 * §4.1 describes this stage as "uppercase, collapse runs of spaces, strip punctuation
 * noise". The punctuation half is deliberately deferred to later stages, and that
 * ordering is load-bearing: stage 2's prefix table contains `SQ *`, `TST*` and
 * `PAYPAL *`, all of which are identified *by* their punctuation. Stripping `*` here
 * would leave `SQ BLUE BOTTLE` and every processor prefix would stop matching — the
 * chain would still run, still produce stable output, and quietly fail to unwrap any
 * Square, Toast or PayPal descriptor.
 *
 * What is safe to normalize now is character-level noise that carries no structure:
 * Unicode dashes and quotes folded to ASCII, whitespace collapsed, control characters
 * dropped.
 */
export function stageCaseAndWhitespace(input: string): string {
  return input
    .replace(/[\u2010-\u2015\u2212]/g, '-') // unicode dashes -> ASCII hyphen
    .replace(/[\u2018\u2019\u201B]/g, "'") // curly single quotes
    .replace(/[\u201C\u201D]/g, '"') // curly double quotes
    // Stripping control characters is the point: a stray 0x1F inside a descriptor
    // would otherwise survive into the merchant key.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F\u00A0]/g, ' ')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * **Stage 2 — processor prefixes.**
 *
 * Strips the prefix and keeps the tail. Loops, because descriptors nest:
 * `POS DEBIT SQ *BLUE BOTTLE` carries two. Capped so a pathological table entry cannot
 * spin, and never allowed to consume the string entirely — a descriptor that is
 * *only* a processor name keeps that name rather than becoming empty.
 */
export function stageProcessorPrefixes(
  input: string,
  prefixes: readonly string[] = PROCESSOR_PREFIXES
): string {
  let current = input;

  for (let pass = 0; pass < 4; pass++) {
    let stripped = false;

    for (const prefix of prefixes) {
      if (!current.startsWith(prefix)) continue;
      const tail = current.slice(prefix.length).trim();
      if (tail === '') continue;
      current = tail;
      stripped = true;
      break;
    }

    if (!stripped) break;
  }

  return current;
}

/**
 * **Stage 3 — store and terminal numbers.**
 *
 * `#0042`, `STORE 1234`, long digit runs, and trailing 3–5 digit runs.
 *
 * Only the long-run rule is unanchored — six consecutive digits is a reference number
 * wherever it sits. The short rules stay anchored to the end or to a marker word,
 * because an unanchored 3-digit rule would eat the `76` in `76 GAS` and the `7` in
 * `7-ELEVEN`.
 *
 * ## The asterisk is un-glued here, and this is the earliest it may be
 *
 * §4.1 keeps punctuation through stage 1 for one reason: stage 2's prefix table is
 * `SQ *`, `TST*`, `PAYPAL *`, "entries identified *by* their punctuation". Stage 2 is
 * therefore the **only** consumer of the asterisk, and once it has run the asterisk
 * stops being structure and becomes glue.
 *
 * Left in place it defeats every anchored rule downstream, because stages 3–5 are all
 * written around whitespace boundaries. `AMAZON MKTPL*5O6QH4PH1` reaches stage 5 with
 * its order reference welded on, so the trailing-reference rule — which wants `\s+`
 * before the run — never fires; stage 6's tidy then turns the `*` into a space long
 * after anything could have cleaned it. One merchant became ~150 distinct descriptors
 * that way. Un-gluing it at the top of stage 3 puts the boundary where the rest of the
 * chain already expects one. Recorded in §9o.
 */
export function stageStoreNumbers(input: string): string {
  let out = input;

  out = out.replace(/\*/g, ' ');
  out = out.replace(/\s*#\s*\d+/g, ' ');
  out = out.replace(/\b(?:STORE|STR|TERM|TERMINAL|LOC|UNIT)\s*#?\s*\d+\b/g, ' ');
  // Six or more consecutive digits is a reference or terminal number wherever it
  // appears — `SHELL OIL 57442100 PORTLAND`. Nothing that is part of a merchant name
  // runs that long, so unlike the shorter rules below this one is not anchored to the
  // end. Shorter runs stay anchored: an unanchored 3-digit rule would eat the `76` in
  // `76 GAS` and the year out of `1800 FLOWERS`.
  out = out.replace(/\b\d{6,}\b/g, ' ');
  out = out.replace(/\s+\d{3,5}\s*$/g, ' ');

  return out.replace(/\s+/g, ' ').trim();
}

/**
 * **Stage 4 — geographic and contact noise.**
 *
 * Phone numbers, URLs, country codes, and a trailing state code.
 *
 * ## One deliberate narrowing
 *
 * §4.1 specifies "trailing `CITY ST` pairs against a state-code list". The state code
 * is verifiable against a list; the city is not — it is simply whatever token precedes
 * it. Stripping it blind turns `BLUE BOTTLE COFFE CA` into `BLUE BOTTLE`, merging a
 * merchant with a different one whose name shares a prefix.
 *
 * The costs are asymmetric. Over-stripping silently merges two merchants, and every
 * §5 rule groups by merchant, so the damage lands in findings and is close to
 * invisible. Under-stripping leaves `STARBUCKS SEATTLE`, which is *stable* — the same
 * descriptor produces the same string every time, so recurrence, price creep and
 * duplicate detection all still work; it is only less pretty, and one user alias with
 * §6.3's "apply to all matching" fixes it permanently.
 *
 * So this strips the state code and leaves the city. The known limitation is that the
 * same chain merchant in two cities resolves to two provisional merchants until an
 * alias joins them — which is precisely the job §4.1 step 6 exists to do. Revisit with
 * a city list once real statements show how often it actually happens (§7.6).
 */
export function stageGeoAndContact(input: string): string {
  let out = input;

  out = out.replace(/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g, ' ');

  // A web address is *noise around* the merchant name, not noise instead of it.
  // `NETFLIX.COM 866-579-7172 CA` has to end up as `NETFLIX`; deleting the whole token
  // leaves `CA`, which then resolves to a merchant named after a US state. So strip the
  // scheme, the `WWW.` and the TLD, and keep the host label.
  out = out.replace(/\bHTTPS?:\/\//g, ' ');
  out = out.replace(/\bWWW\./g, ' ');
  out = out.replace(/\b([A-Z0-9-]+)\.(?:COM|NET|ORG|CO|IO|US|GOV|EDU)\b(?:\/\S*)?/g, '$1');
  out = out.replace(/\s+/g, ' ').trim();

  const tokens = out.split(' ').filter((t) => t !== '');

  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1];
    if (US_STATE_CODES.has(last) || COUNTRY_CODES.has(last)) {
      tokens.pop();
      continue;
    }
    break;
  }

  return tokens.join(' ');
}

/**
 * **Stage 5 — reference and date debris.**
 *
 * Transaction ids, `REF#`, and embedded `MM/DD`. The transaction-id rule requires the
 * run to contain both letters and digits and to sit at the end, so a merchant like
 * `A1 AUTO` survives.
 */
export function stageReferenceDebris(input: string): string {
  let out = input;

  // Both `\b`s matter, and so does requiring a digit in the tail. Without the closing
  // boundary, `TRAN` matches inside `TRANSFER` and the greedy tail eats the rest of the
  // word, turning `TRANSFER TO CHECKING` into `TO CHECKING`. Without the digit
  // lookahead, `AUTH` would swallow the following word of any descriptor that contains
  // it. A reference number has digits in it; a word does not.
  out = out.replace(
    /\b(?:REF|TRACE|AUTH|CONF|INV|TRAN|ID)\b\s*#?\s*(?=[A-Z0-9-]*\d)[A-Z0-9-]+/g,
    ' '
  );
  out = out.replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ');
  out = out.replace(/\s+(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{8,}\s*$/g, ' ');
  out = out.replace(/\s*\bX{2,}\d+\b/g, ' ');

  return out.replace(/\s+/g, ' ').trim();
}

/** Final tidy so the merchant key never carries stray punctuation or spacing. Applied
 *  after stage 5, which is the point at which structural punctuation has done its job. */
export function stageFinalTidy(input: string): string {
  return input
    .replace(/[^A-Z0-9&' -]/g, ' ')
    .replace(/\s*-\s*$/g, '')
    .replace(/^\s*-\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface StageRunResult {
  readonly output: string;
  readonly trace: readonly StageTrace[];
}

export function runStages(
  descriptionRaw: string,
  prefixes: readonly string[] = PROCESSOR_PREFIXES
): StageRunResult {
  const trace: StageTrace[] = [];
  let current = descriptionRaw;

  const apply = (stage: number, name: string, fn: (s: string) => string): void => {
    const before = current;
    const after = fn(before);
    trace.push({ stage, name, before, after });
    current = after;
  };

  apply(1, 'case and whitespace', stageCaseAndWhitespace);
  apply(2, 'processor prefixes', (s) => stageProcessorPrefixes(s, prefixes));
  apply(3, 'store and terminal numbers', stageStoreNumbers);
  apply(4, 'geographic and contact noise', stageGeoAndContact);
  apply(5, 'reference and date debris', stageReferenceDebris);
  apply(6, 'final tidy', stageFinalTidy);

  return { output: current, trace };
}
