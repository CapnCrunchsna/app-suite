/**
 * `GET /api/insights/*` — §2.3's five, and §6.6's page behind them.
 *
 * §2.3 lists them as one row: "`categories`, `movers`, `fees`, `outliers`,
 * `small-spend`". They are five routes rather than one because they have different
 * shapes and different costs — a stacked chart wants every month, an outlier list
 * wants none of them — and a single `/api/insights` returning all five would make
 * opening the page pay for four views nobody is looking at.
 *
 * ## The range is required, and defaulted only where §7.2 allows it
 *
 * Three of these take a date range because §6.6 gives the page "a date-range
 * selector". An absent range means the whole ledger, which is the honest reading of
 * "no selection" — and §7.2's coverage answer is computed against whatever range
 * arrives, so a wide default cannot silently widen what counts as covered.
 */

import type { FastifyInstance } from 'fastify';

import { isIsoDate } from '@metrum/ledgerline-domain';
import type { DateRange } from '@metrum/ledgerline-domain';

import { errorResponses } from './errors.js';
import { ref } from './schemas.js';
import type { LedgerlineContext } from '../context.js';
import { categorySpend, fees, movers, outliers, smallSpend } from '../insights-service.js';

interface RangeQuery {
  readonly from?: string;
  readonly to?: string;
  /** Comma-separated, matching the shape `/api/findings` already uses. */
  readonly accountIds?: string;
}

/** The whole ledger, when the page has no selection. Read from the data rather than
 *  from the clock, for §7.2's reason: "never the dataset maximum and never the wall
 *  clock" governs *liveness*, and this is a display window — but a range ending
 *  today over a ledger that stops in March would render nine empty hatched months. */
function wholeRange(context: LedgerlineContext): DateRange {
  const row = context.store.db
    .prepare<[], { lo: string | null; hi: string | null }>(
      'SELECT MIN(effective_date) AS lo, MAX(effective_date) AS hi FROM "transaction"',
    )
    .get();
  return { from: row?.lo ?? '1970-01-01', to: row?.hi ?? '1970-01-01' };
}

function rangeFrom(context: LedgerlineContext, query: RangeQuery): DateRange {
  const whole = wholeRange(context);
  const from = query.from && isIsoDate(query.from) ? query.from : whole.from;
  const to = query.to && isIsoDate(query.to) ? query.to : whole.to;
  return from <= to ? { from, to } : { from: to, to: from };
}

const accountsFrom = (query: RangeQuery): string[] =>
  (query.accountIds ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');

const rangeQuerySchema = {
  type: 'object',
  properties: {
    from: { type: 'string', description: 'YYYY-MM-DD. Defaults to the first row in the ledger.' },
    to: { type: 'string', description: 'YYYY-MM-DD. Defaults to the last row in the ledger.' },
    accountIds: {
      type: 'string',
      description:
        'Comma-separated. Spec 7.2’s coverage is the intersection across these accounts, so ' +
        'narrowing the selection can *widen* the covered window.',
    },
  },
} as const;

export function registerInsightRoutes(app: FastifyInstance, context: LedgerlineContext): void {
  app.get<{ Querystring: RangeQuery }>(
    '/api/insights/categories',
    {
      schema: {
        summary: 'Category spend by month (spec 6.6)',
        operationId: 'getCategoryInsight',
        description:
          'Spec 6.6’s stacked bars. Every month in the window is returned with its coverage ' +
          'state, including the uncovered ones — spec 6.6 requires those to be rendered hatched ' +
          'rather than omitted, "so a gap reads as a gap and not as a drop in spending". ' +
          '`window` reports what spec 7.2 considered covered.',
        tags: ['insights'],
        querystring: rangeQuerySchema,
        response: { 200: ref('CategoryInsight'), ...errorResponses },
      },
    },
    async (request) =>
      categorySpend(context, rangeFrom(context, request.query), accountsFrom(request.query)),
  );

  app.get<{ Querystring: RangeQuery }>(
    '/api/insights/movers',
    {
      schema: {
        summary: 'Biggest risers and fallers, month over month (spec 6.6)',
        operationId: 'getMoversInsight',
        description:
          'Compares the last two **covered** months rather than the last two months: a ' +
          'complete month against a half-imported one produces a table of enormous fallers ' +
          'that are all the same artefact (spec 7.2). With fewer than two covered months the ' +
          'answer is empty rather than a comparison against a month that is not there.',
        tags: ['insights'],
        querystring: rangeQuerySchema,
        response: { 200: ref('MoversInsight'), ...errorResponses },
      },
    },
    async (request) =>
      movers(context, rangeFrom(context, request.query), accountsFrom(request.query)),
  );

  app.get<{ Querystring: RangeQuery }>(
    '/api/insights/fees',
    {
      schema: {
        summary: 'Fees and interest rollup per account (spec 6.6)',
        operationId: 'getFeesInsight',
        description:
          'Everything the taxonomy calls a fee, totalled per account — not spec 5.8’s ' +
          'findings. Spec 5.8 makes a judgement about which fees are worth reporting and ' +
          'applies spec 5.1’s floor; this makes none, so the rollup does not go blank when ' +
          'every individual fee falls below it.',
        tags: ['insights'],
        querystring: rangeQuerySchema,
        response: { 200: ref('FeesInsight'), ...errorResponses },
      },
    },
    async (request) =>
      fees(context, rangeFrom(context, request.query), accountsFrom(request.query)),
  );

  app.get(
    '/api/insights/outliers',
    {
      schema: {
        summary: 'Spec 5.9’s outlier charges (spec 6.6)',
        operationId: 'getOutlierInsight',
        description:
          'Read from spec 5.9’s findings rather than re-derived: the z-score and the ' +
          'baseline are that rule’s business, and a second implementation here would carry ' +
          'its own copy of thresholds spec 7.4 keeps in one config object. Includes ' +
          'dismissed rows — spec 6.6 is a page about what your money did, and a dismissed ' +
          'outlier is still an outlier.',
        tags: ['insights'],
        response: { 200: ref('RuleBackedInsight'), ...errorResponses },
      },
    },
    async () => outliers(context),
  );

  app.get(
    '/api/insights/small-spend',
    {
      schema: {
        summary: 'Spec 5.11’s high-frequency small spend, annualized (spec 6.6)',
        operationId: 'getSmallSpendInsight',
        description:
          'Read from spec 5.11’s findings, for the same reason the outliers are. The ' +
          'annualized figure is the rule’s own `impactAnnualCents`, so the page and the ' +
          'finding card cannot disagree about it.',
        tags: ['insights'],
        response: { 200: ref('RuleBackedInsight'), ...errorResponses },
      },
    },
    async () => smallSpend(context),
  );
}
