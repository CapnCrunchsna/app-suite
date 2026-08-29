/**
 * §6.7's Ask, orchestrated: pick a query, run it deterministically, write prose over
 * what it returned, and check the prose's arithmetic before showing it.
 *
 * "The functions execute deterministically; the LLM only picks the query and writes
 * prose around the returned rows."
 *
 * ## Two calls, and the middle step is not negotiable
 *
 * The model is asked twice with a deterministic execution between: once to choose
 * from §6.7's six functions, once to describe what came back. Nothing it says in the
 * first call reaches the database except through `validateAskQuery`, and nothing it
 * sees in the second is more than `providerView` allows. The reason it is two calls
 * rather than one is that a single call would have to be handed the data *and*
 * trusted to choose — which is the arrangement §6.7 rejects in its first three
 * words.
 *
 * ## The answer can be withheld and the table still shown
 *
 * §6.7: "An answer that fails validation is not shown; the table is shown instead
 * with a note." So a failed numeric check is not an error — the query ran, the rows
 * are real, and the only thing missing is the prose. Same for a dead provider: the
 * deterministic half of this feature does not depend on the model at all once a
 * query has been chosen, and `llmAssist`'s fallback for the second call is simply no
 * prose.
 *
 * The *first* call is different, and it is the one place Ask genuinely needs a
 * provider: nothing else picks a query. Its fallback is a null query, which the
 * route reports as an answerless response rather than a 500.
 */

import { llmAssist } from '@metrum/ledgerline-llm';
import type { LlmProvider } from '@metrum/ledgerline-llm';

import type { LedgerlineContext } from '../context.js';
import {
  createLlmProvider,
  degradedCallSink,
  modelFor,
  readLlmSettings,
} from '../llm-service.js';
import { checkNumbers } from './numeric-check.js';
import { QUERY_NAMES, runAskQuery, validateAskQuery } from './queries.js';
import type { AskQuery, AskQueryDraft, AskRow, QueryResult } from './queries.js';

export interface AskRequest {
  readonly question: string;
  /** Injected by the specs, which must never start a real provider. */
  readonly provider?: LlmProvider;
}

export interface AskResult {
  readonly question: string;
  /** What ran, in words — §6.7: every answer "names the query it ran". */
  readonly queryDescription: string | null;
  readonly queryName: string | null;
  readonly rows: readonly AskRow[];
  readonly rowCount: number;
  readonly totalCents: number;
  /** Null when the model could not be reached, or when its prose failed §6.7's
   *  numeric check. The table is shown either way. */
  readonly answer: string | null;
  /** Why there is no prose, for the note §6.7 asks the page to show. */
  readonly withheldReason: string | null;
  /** §2.4's hard filter, counted. */
  readonly withheldP2P: number;
  readonly providerId: string;
}

/**
 * §6.7's first prompt.
 *
 * The six names and their parameters, stated as a closed list. No schema is
 * described beyond what a caller may send, because everything else is validated
 * afterwards anyway — and a longer prompt describing the database would be teaching
 * the model about data it is not allowed to reach.
 */
export function buildQueryPrompt(question: string): string {
  return [
    'You are choosing one query to answer a question about a personal bank ledger.',
    'You cannot write SQL and you cannot see the data. Choose exactly one function.',
    '',
    'spendByCategory  — needs from, to (YYYY-MM-DD). Totals per spend category.',
    'monthlyTotals    — needs from, to. One total per calendar month.',
    'topMerchants     — optional from, to, n. The n merchants with the most spend.',
    'merchantHistory  — needs merchant (a name). Optional from, to. That merchant’s charges.',
    'findRecurring    — no parameters. Active recurring subscriptions.',
    'transactionSearch— optional text, from, to, minAmountCents, maxAmountCents.',
    '',
    'Return JSON only, no prose:',
    '{"name":"<one of the six>","from":"YYYY-MM-DD","to":"YYYY-MM-DD",' +
      '"merchant":"...","n":10,"text":"...","minAmountCents":0,"maxAmountCents":0}',
    'Omit any parameter the chosen function does not need.',
    '',
    `Question: ${question}`,
  ].join('\n');
}

/**
 * §6.7's second prompt.
 *
 * The model is given `providerView` and told to describe it. The instruction not to
 * introduce numbers is belt-and-braces — `checkNumbers` is the braces, and it is the
 * one that actually holds — but it costs a line and makes the common case pass more
 * often, which means fewer answers withheld for a reason the user cannot act on.
 */
export function buildProsePrompt(question: string, view: unknown): string {
  return [
    'Answer the question in two or three plain sentences, using only the data below.',
    'Every number you write must appear in the data. Do not estimate, extrapolate,',
    'or add figures that are not there. Amounts ending in "Cents" are in cents.',
    'If the data does not answer the question, say so.',
    '',
    `Question: ${question}`,
    '',
    'Data:',
    JSON.stringify(view, null, 2),
  ].join('\n');
}

/**
 * Run one question.
 *
 * Never throws for a provider reason — the caller has already refused the request if
 * no provider is configured (§2.3's 409), and everything after that point degrades to
 * a table with a note.
 */
export async function runAsk(context: LedgerlineContext, request: AskRequest): Promise<AskResult> {
  const settings = readLlmSettings(context);
  const provider = request.provider ?? createLlmProvider(context);
  const onDegraded = degradedCallSink(context);
  const model = modelFor(settings);

  const empty = {
    question: request.question,
    queryDescription: null,
    queryName: null,
    rows: [],
    rowCount: 0,
    totalCents: 0,
    answer: null,
    withheldP2P: 0,
    providerId: settings.providerId,
  } as const;

  // ---- 1. Choose a query. The one step nothing deterministic can stand in for.
  const query = await llmAssist<AskQuery | null>(
    () =>
      provider.completeJson<AskQuery>({
        prompt: buildQueryPrompt(request.question),
        model,
        validate: (value) => validateAskQuery(value as AskQueryDraft),
      }),
    {
      fallback: () => null,
      operation: 'ask: choosing a query',
      onDegraded,
    },
  );

  if (query === null) {
    return {
      ...empty,
      withheldReason:
        'The model could not be reached, so no query was chosen. Nothing was read from your ' +
        'ledger. The degraded-call log in Settings has the reason.',
    };
  }

  // ---- 2. Run it. Deterministic, and the only path from Ask to the store.
  const result: QueryResult = runAskQuery(context, query);

  // ---- 3. Describe the result — over `providerView`, never over `rows`.
  const prose = await llmAssist<string | null>(
    () =>
      provider.complete({
        prompt: buildProsePrompt(request.question, result.providerView),
        model,
      }),
    {
      fallback: () => null,
      operation: 'ask: writing the answer',
      onDegraded,
    },
  );

  // ---- 4. §6.7's numeric post-validation.
  const validated = validateProse(prose, result);

  return {
    question: request.question,
    queryDescription: result.providerView.query,
    queryName: result.query.name,
    rows: result.rows,
    rowCount: result.rowCount,
    totalCents: result.totalCents,
    answer: validated.answer,
    withheldReason: validated.reason,
    withheldP2P: result.providerView.withheldP2P,
    providerId: settings.providerId,
  };
}

/**
 * §6.7's two grounds for withholding prose, and the messages for each.
 *
 * "An answer with no visible data behind it is not shown" is the third, and it is
 * checked here rather than in the page: an empty result with a confident paragraph
 * over it is the most misleading thing this feature can produce, and the page should
 * not have to remember to guard against it.
 */
function validateProse(
  prose: string | null,
  result: QueryResult,
): { answer: string | null; reason: string | null } {
  if (prose === null || prose.trim() === '') {
    return {
      answer: null,
      reason:
        'The model did not answer, so the table below is the whole result. It is the same ' +
        'data an answer would have been written from.',
    };
  }

  if (result.rows.length === 0) {
    return {
      answer: null,
      reason:
        'That query returned nothing, so there is no answer to show — §6.7 does not show ' +
        'prose with no data behind it.',
    };
  }

  const check = checkNumbers(prose, {
    rows: result.rows,
    totalCents: result.totalCents,
    rowCount: result.rowCount,
  });

  if (!check.ok) {
    return {
      answer: null,
      reason:
        `The written answer used ${check.unsupported.length === 1 ? 'a figure' : 'figures'} ` +
        `that ${check.unsupported.length === 1 ? 'is' : 'are'} not in the result ` +
        `(${check.unsupported.join(', ')}), so it is not shown. The table below is the ` +
        'actual result.',
    };
  }

  return { answer: prose.trim(), reason: null };
}

/** The six, for the route's description and the page's empty state. */
export const ASK_QUERY_NAMES = QUERY_NAMES;
