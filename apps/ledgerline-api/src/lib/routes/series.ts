/**
 * `/api/series` — §2.3's three series routes, and the ledger §6.5 renders from them.
 *
 * ## The computed half and the user half never meet
 *
 * §5.2 recomputes a series on every analysis run; §6.5 puts three fields on it that a
 * human owns — `cancellation_url`, `notes` and a manual `user_status` — and says "a
 * manual status always beats the computed one". `AnalysisRepository.replaceSeries`
 * writes the first half and never touches the second after the insert; `patchSeries`
 * writes the second and never the first. This route is the only place the two are
 * visible together, and it resolves the precedence once, into `effectiveStatus`, so
 * that the page and §6.4's headline cannot disagree about how many subscriptions are
 * active.
 *
 * ## The money is computed here, not in the page
 *
 * §5.2: "`cadences_per_year` is stored on the series, not recomputed per rule, so
 * §5.5's `delta × cadences_per_year` and the Subscriptions page's annual totals cannot
 * disagree." A client-side multiplication would put that arithmetic in a second place.
 * `totalPaidCents` is deliberately *not* derived from the rate — it is the sum of the
 * charges actually observed, which is what §6.5's "total paid to date" means and is a
 * different number from `annualCents × years`.
 *
 * ## Charges and price steps are read, never re-derived
 *
 * Both are stored on the series by the run that fitted it (migration `005`, §9i). §5.3
 * forbids re-deriving the series contract downstream, and a read-time derivation would
 * answer with today's grouping rather than the run's — charting a history the series
 * was never fitted from.
 */

import type { FastifyInstance } from 'fastify';

import type { SeriesRecord, SeriesStatus } from '@metrum/ledgerline-data';

import { errorResponses } from './errors.js';
import { ref, SERIES_STATUSES } from './schemas.js';
import type { LedgerlineContext } from '../context.js';

interface SeriesPatchBody {
  userStatus?: SeriesStatus | null;
  cancellationUrl?: string | null;
  notes?: string | null;
}

/**
 * §6.5's drawer renders this as a link, so a stored `javascript:` URL would be one
 * click from executing in the page. An allow-list of two schemes rather than a
 * blocklist: `javascript:`, `data:` and `vbscript:` are the ones anybody thinks of, and
 * a blocklist is wrong the first time a browser ships a fourth.
 *
 * Empty and `null` both mean "no URL" and are accepted — clearing the field is a
 * legitimate edit, and refusing it would leave a bad URL unremovable.
 */
function cancellationUrlProblem(url: string | null | undefined): string | null {
  if (url === undefined || url === null || url.trim() === '') return null;

  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return 'cancellationUrl must be an absolute http(s) URL';
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:'
    ? null
    : `cancellationUrl must use http or https, not ${parsed.protocol}`;
}

/** `COALESCE(user_status, status)` — §6.5's precedence, resolved once. */
const effectiveStatusOf = (record: SeriesRecord): SeriesStatus =>
  record.userStatus ?? record.status;

/**
 * The wire shape, and the one sign asymmetry on it.
 *
 * `amountCentsCurrent` and `amountCentsFirst` are **magnitudes** — §5.2 derives them as
 * "the median of the current price step, and of the first", and a price is a positive
 * number the same way §5.5's steps are. `charges[].amountCents` is **signed**, because
 * it is the transaction as stored and negative is money leaving (§3.1).
 *
 * So the annual figure multiplies straight through, and `totalPaidCents` is the one
 * place that has to take absolute values. Recorded in §9i, because the asymmetry is not
 * guessable from the field names.
 */
function toWire(record: SeriesRecord) {
  const annualCents = Math.round((record.amountCentsCurrent ?? 0) * (record.cadencesPerYear ?? 0));

  return {
    id: record.id,
    merchantId: record.merchantId,
    accountId: record.accountId,
    cadenceDays: record.cadenceDays,
    cadenceLabel: record.cadenceLabel,
    cadencesPerYear: record.cadencesPerYear,
    amountCentsCurrent: record.amountCentsCurrent,
    amountCentsFirst: record.amountCentsFirst,
    firstSeen: record.firstSeen,
    lastSeen: record.lastSeen,
    nextExpected: record.nextExpected,
    occurrenceCount: record.occurrenceCount,
    status: record.status,
    userStatus: record.userStatus,
    effectiveStatus: effectiveStatusOf(record),
    cancellationUrl: record.cancellationUrl,
    notes: record.notes,
    regularity: record.regularity,
    confidence: record.confidence,
    // Rounded once, at the end, and in integer cents (§7.3).
    annualCents,
    monthlyCents: Math.round(annualCents / 12),
    // The charges are signed; "total paid" is not. See the header.
    totalPaidCents: record.charges.reduce((sum, charge) => sum + Math.abs(charge.amountCents), 0),
    charges: record.charges,
    priceSteps: record.priceSteps,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function registerSeriesRoutes(app: FastifyInstance, context: LedgerlineContext): void {
  app.get(
    '/api/series',
    {
      schema: {
        summary: 'The recurring ledger behind spec 6.5’s Subscriptions page',
        operationId: 'listSeries',
        description:
          'Every series spec 5.2 fitted, with its charge history and price steps as the run ' +
          'that produced it recorded them. Sorted by annual cost, descending — spec 6.5 calls ' +
          'that "the view that produces the *I pay what for that?* reaction", so it is the ' +
          'order the list arrives in rather than one the page has to ask for.',
        tags: ['analysis'],
        response: { 200: { type: 'array', items: ref('Series') }, ...errorResponses },
      },
    },
    async () =>
      context.store.analysis
        .listSeries()
        .map(toWire)
        .sort((a, b) => b.annualCents - a.annualCents),
  );

  app.get<{ Params: { id: string } }>(
    '/api/series/:id',
    {
      schema: {
        summary: 'One series, with its full charge history',
        operationId: 'getSeries',
        description:
          'The same shape the list returns. Spec 6.5’s detail drawer needs the charge history ' +
          'and the price-step table, and both travel on every series rather than behind a ' +
          'second request, because the drawer opens from a row the page already holds.',
        tags: ['analysis'],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        response: { 200: ref('Series'), ...errorResponses },
      },
    },
    async (request, reply) => {
      const record = context.store.analysis.getSeries(request.params.id);
      if (!record) {
        return reply.code(404).send({ error: 'not_found', message: 'no such series' });
      }
      return toWire(record);
    },
  );

  app.patch<{ Params: { id: string }; Body: SeriesPatchBody }>(
    '/api/series/:id',
    {
      schema: {
        summary: 'Spec 6.5’s three user-owned fields',
        operationId: 'updateSeries',
        description:
          'The cancellation URL, the notes, and the manual status override — which always ' +
          'beats the computed one (spec 6.5). Omitting a field leaves it alone; sending ' +
          '`userStatus: null` clears the override and hands the series back to spec 5.2. ' +
          'Nothing here is recomputed by an analysis run: `replaceSeries` writes the other ' +
          'half of the row and never these three.',
        tags: ['analysis'],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        body: ref('SeriesPatch'),
        response: { 200: ref('Series'), ...errorResponses },
      },
    },
    async (request, reply) => {
      const problem = cancellationUrlProblem(request.body.cancellationUrl);
      if (problem) {
        return reply.code(422).send({ error: 'invalid_url', message: problem });
      }

      // An empty string is the field being cleared. Storing `''` would make "no URL"
      // two different values, and the page would have to know both.
      const cancellationUrl =
        request.body.cancellationUrl === undefined
          ? undefined
          : (request.body.cancellationUrl?.trim() ?? '') === ''
            ? null
            : (request.body.cancellationUrl as string).trim();

      const notes =
        request.body.notes === undefined
          ? undefined
          : (request.body.notes?.trim() ?? '') === ''
            ? null
            : (request.body.notes as string).trim();

      const updated = context.store.analysis.patchSeries(request.params.id, {
        ...(request.body.userStatus === undefined ? {} : { userStatus: request.body.userStatus }),
        ...(cancellationUrl === undefined ? {} : { cancellationUrl }),
        ...(notes === undefined ? {} : { notes }),
      });

      if (!updated) {
        return reply.code(404).send({ error: 'not_found', message: 'no such series' });
      }
      return toWire(updated);
    },
  );
}

export { SERIES_STATUSES };
