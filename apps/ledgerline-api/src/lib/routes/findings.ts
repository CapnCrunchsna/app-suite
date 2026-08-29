/**
 * `/api/analysis/run`, `/api/findings*` and `/api/dismissal-rules` (§2.3, §5.1).
 *
 * ## Running is an enqueue, not a call
 *
 * §2.7 puts `POST /api/analysis/run` in the same sentence as the re-normalize
 * job: both "**enqueue** and return a job id". A full run loads every
 * transaction and evaluates every rule over it — the design load is ~58,000 rows
 * (§2.2) — and a synchronous HTTP request that does that is a request that times
 * out on the household this app was sized for. The client polls
 * `GET /api/jobs/:id`, which already exists.
 *
 * ## Two dismissal endpoints, because there are two concerns
 *
 * `POST /api/findings/:id/state` is §5.1's per-finding verdict; the standing
 * scopes are `/api/dismissal-rules`. §3.1 explains why they are not one table and
 * the same reasoning makes them not one endpoint: "dismiss this rule for this
 * merchant" has no finding id to POST to, and a route that pretended otherwise
 * would have to invent one from whichever finding happened to be on screen.
 *
 * The two derived flags on the wire — `changedSinceDismissal` and
 * `reEvaluated` — are §5.1's two resurfacing reasons, computed here rather than
 * stored. They are comparisons between what the user's dismissal recorded and
 * what the finding currently says, so storing them would mean a column that is
 * wrong from the moment the next run writes a new hash.
 */

import type { FastifyInstance } from 'fastify';

import type {
  FindingBand,
  FindingLabelRecord,
  FindingLifecycleStatus,
  FindingQuery,
  FindingUserStatus,
  FindingVerdict,
  FindingView,
  FindingVisibility,
} from '@metrum/ledgerline-data';

import { errorResponses } from './errors.js';
import { ref } from './schemas.js';
import { currentConfigHash } from '../analysis-service.js';
import type { LedgerlineContext } from '../context.js';

/** §5.1: "**Snooze** is a fourth option — 90 days by default." */
const DEFAULT_SNOOZE_DAYS = 90;

interface FindingQueryString {
  ruleIds?: string;
  bands?: string;
  statuses?: string;
  accountIds?: string;
  impactKind?: 'savings' | 'visibility';
  minAnnualImpactCents?: number;
  visibility?: FindingVisibility;
  limit?: number;
  offset?: number;
}

const csv = (value: string | undefined): string[] | undefined =>
  value === undefined || value.trim() === ''
    ? undefined
    : value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '');

function toQuery(query: FindingQueryString): FindingQuery {
  return {
    ruleIds: csv(query.ruleIds),
    bands: csv(query.bands) as FindingBand[] | undefined,
    statuses: csv(query.statuses) as FindingLifecycleStatus[] | undefined,
    accountIds: csv(query.accountIds),
    impactKind: query.impactKind,
    minAnnualImpactCents: query.minAnnualImpactCents,
    visibility: query.visibility,
    limit: query.limit,
    offset: query.offset,
  };
}

/**
 * One finding as §6.4's card reads it.
 *
 * `detail` is re-parsed from the stored JSON rather than passed through as a
 * string: §5.1 makes the payload structured "so the page can present them and the
 * API can serialize them without either one parsing a sentence", and handing the
 * client a string to `JSON.parse` would put the parsing back.
 */
function toWire(view: FindingView, label?: FindingLabelRecord | null) {
  const { finding, state } = view;

  // §5.1: the finding "returns flagged **'changed since you dismissed this'**"
  // when the evidence hash moves — a price change, or a lapsed series resuming.
  const changedSinceDismissal =
    state?.status === 'dismissed' && state.dismissedEvidenceHash !== finding.evidenceHash;

  // §5.1's other reason, "grouped separately as 're-evaluated with an improved
  // rule' so the user knows why their dismissal was reopened." A null recorded
  // hash predates migration 002 and is not evidence that anything changed.
  const reEvaluated =
    state?.status === 'dismissed' &&
    state.dismissedConfigHash !== null &&
    state.dismissedConfigHash !== finding.configHash;

  return {
    id: finding.id,
    ruleId: finding.ruleId,
    ruleVersion: finding.ruleVersion,
    configHash: finding.configHash,
    naturalKey: finding.naturalKey,
    subjectType: finding.subjectType,
    subjectId: finding.subjectId,
    title: finding.title,
    detail: JSON.parse(finding.detailJson) as Record<string, unknown>,
    confidence: finding.confidence,
    band: finding.band,
    impactKind: finding.impactKind,
    impactMonthlyCents: finding.impactMonthlyCents,
    impactAnnualCents: finding.impactAnnualCents,
    llmDependent: finding.llmDependent,
    evidenceHash: finding.evidenceHash,
    evidenceTransactionIds: view.evidenceTransactionIds,
    firstDetectedAt: finding.firstDetectedAt,
    status: finding.status,
    userStatus: state?.status ?? null,
    /**
     * §7.6's judgement, carried beside §5.1's verdict and never merged into it.
     *
     * Two fields rather than one combined status, because they answer different
     * questions — *was it true* and *do I want to see it* — and a card that had to
     * derive one from the other is where the distinction would quietly collapse
     * (§9z).
     */
    verdict: label?.verdict ?? null,
    // The same staleness test §5.1 applies to a dismissal: a judgement about
    // evidence that has since moved is a judgement about a different claim.
    verdictStale: label != null && label.evidenceHash !== finding.evidenceHash,
    snoozeUntil: state?.snoozeUntil ?? null,
    changedSinceDismissal: changedSinceDismissal ?? false,
    reEvaluated: reEvaluated ?? false,
    createdAt: finding.createdAt,
    updatedAt: finding.updatedAt,
  };
}

export function registerFindingRoutes(app: FastifyInstance, context: LedgerlineContext): void {
  app.post(
    '/api/analysis/run',
    {
      schema: {
        summary: 'Enqueue an analysis run',
        operationId: 'runAnalysis',
        description:
          'Spec 2.7: enqueues and returns a job id; poll `GET /api/jobs/:id`. Runs of this ' +
          'kind coalesce, so two requests in flight are one run.',
        tags: ['analysis'],
        response: { 202: ref('Job'), ...errorResponses },
      },
    },
    async (_request, reply) => {
      // §2.7's coalescing, and the payload is empty because a run has no
      // arguments — it always analyzes everything. Two requests while one is
      // queued are one run, which is the same rule the renormalize job follows.
      const { job } = context.store.jobs.enqueueCoalesced({
        kind: 'analysis',
        mergePayload: () => null,
        message: 'analysis queued',
      });
      context.jobRunner.schedule();

      // 202, not 200: nothing has been analyzed yet and the body is a receipt.
      return reply.code(202).send(job);
    },
  );

  app.get<{ Querystring: FindingQueryString }>(
    '/api/findings',
    {
      schema: {
        summary: 'List findings with spec 6.4’s filters',
        operationId: 'listFindings',
        description:
          'Grouped by rule and sorted by annual impact descending (spec 6.4). Dismissed and ' +
          'snoozed findings are hidden by default and return the moment their evidence hash ' +
          'or the config hash moves (spec 5.1).',
        tags: ['analysis'],
        querystring: {
          type: 'object',
          properties: {
            ruleIds: { type: 'string', description: 'Comma-separated rule ids' },
            bands: {
              type: 'string',
              description: 'Comma-separated confidence bands (high, medium, low)',
            },
            statuses: {
              type: 'string',
              description:
                'Comma-separated lifecycle statuses (active, resolved, suppressed). ' +
                'Defaults to active.',
            },
            accountIds: {
              type: 'string',
              description: 'Comma-separated account ids, matched through finding_evidence',
            },
            impactKind: { type: 'string', enum: ['savings', 'visibility'] },
            minAnnualImpactCents: { type: 'integer', minimum: 0 },
            visibility: {
              type: 'string',
              enum: ['visible', 'hidden', 'all'],
              default: 'visible',
              description: 'Whether to include findings the user has dismissed or snoozed',
            },
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
            offset: { type: 'integer', minimum: 0, default: 0 },
          },
        },
        response: { 200: ref('FindingPage'), ...errorResponses },
      },
    },
    async (request) => {
      const page = context.store.findings.search(toQuery(request.query));
      // One lookup for the whole page rather than one per row: a findings page is
      // up to 500 cards, and a label read per card would be 500 statements to
      // decorate a list that already cost one.
      const labels = new Map(
        context.store.findingLabels.list(5000).map((entry) => [entry.naturalKey, entry] as const),
      );

      return {
        rows: page.rows.map((row) => toWire(row, labels.get(row.finding.naturalKey) ?? null)),
        total: page.total,
        limit: page.limit,
        offset: page.offset,
      };
    },
  );

  app.get<{ Querystring: FindingQueryString }>(
    '/api/findings/summary',
    {
      schema: {
        summary: 'Spec 6.4’s three headline numbers',
        operationId: 'getFindingsSummary',
        description:
          'Active subscriptions and their monthly/annual total, total flagged annual savings ' +
          '(`impact_kind = savings` only — spec 5.1 and 7.3), and the unreviewed count. Takes ' +
          'the same filters as the list so the headline and the cards describe one set.',
        tags: ['analysis'],
        querystring: {
          type: 'object',
          properties: {
            ruleIds: { type: 'string' },
            bands: { type: 'string' },
            accountIds: { type: 'string' },
            minAnnualImpactCents: { type: 'integer', minimum: 0 },
          },
        },
        response: { 200: ref('FindingsSummary'), ...errorResponses },
      },
    },
    async (request) => {
      const totals = context.store.findings.totals(toQuery(request.query));
      const series = context.store.analysis.seriesTotals();
      const run = context.store.analysis.latestFinished();

      return {
        subscriptions: series,
        savingsAnnualCents: totals.savingsAnnualCents,
        savingsMonthlyCents: totals.savingsMonthlyCents,
        activeFindingCount: totals.activeCount,
        unreviewedCount: totals.unreviewedCount,
        countsByRule: totals.countsByRule,
        countsByBand: totals.countsByBand,
        lastRunAt: run?.finishedAt ?? null,
        lastRunConfigHash: run?.configHash ?? null,
        lastRunSnapshotRows: run?.snapshotRows ?? null,
        // §7.4: a threshold edited in Settings since the last run means the
        // findings on screen were computed under different numbers than the ones
        // now in force. Saying so is cheaper than silently disagreeing.
        configHash: currentConfigHash(context),
      };
    },
  );

  app.post<{
    Params: { id: string };
    Body: { status: FindingUserStatus; reason?: string | null; snoozeDays?: number };
  }>(
    '/api/findings/:id/state',
    {
      schema: {
        summary: 'Acknowledge, snooze or dismiss one finding',
        operationId: 'setFindingState',
        description:
          'Spec 5.1’s per-finding scope. A dismissal stores the finding’s evidence hash and ' +
          'the config hash in force, which is what makes it stick — and what makes it lift ' +
          'when the price changes or a lapsed series resumes.',
        tags: ['analysis'],
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          required: ['status'],
          properties: {
            status: { type: 'string', enum: ['acknowledged', 'snoozed', 'dismissed'] },
            reason: { type: ['string', 'null'] },
            snoozeDays: {
              type: 'integer',
              minimum: 1,
              maximum: 3650,
              description: `Snooze length in days. Defaults to ${DEFAULT_SNOOZE_DAYS} (spec 5.1).`,
            },
          },
        },
        response: { 200: ref('Finding'), ...errorResponses },
      },
    },
    async (request, reply) => {
      const finding = context.store.findings.get(request.params.id);
      if (!finding) {
        return reply.code(404).send({ error: 'not_found', message: 'no such finding' });
      }

      context.store.findings.setState({
        naturalKey: finding.naturalKey,
        status: request.body.status,
        reason: request.body.reason ?? null,
        snoozeUntil:
          request.body.status === 'snoozed'
            ? snoozeUntil(request.body.snoozeDays ?? DEFAULT_SNOOZE_DAYS)
            : null,
        // Captured from the finding as it stands right now, which is the whole
        // mechanism: §5.1's dismissal is a statement about *this* evidence, and
        // reading the hash later instead would make every dismissal permanent.
        evidenceHash: finding.evidenceHash,
        configHash: finding.configHash,
      });

      return toWire(
        {
          finding,
          state: context.store.findings.getState(finding.naturalKey),
          evidenceTransactionIds: context.store.findings.listEvidence(finding.id),
        },
        context.store.findingLabels.get(finding.naturalKey),
      );
    },
  );

  /**
   * §7.6's judgement, which is a different question from §5.1's verdict above.
   *
   * `POST /api/findings/:id/state` asks *do I want to see this*. This asks *was it
   * true*, and the two come apart in both directions: a correct finding about a
   * subscription you have already decided to keep gets dismissed, and an incorrect
   * one sits unread at the bottom of the page for a month. §7.6 needs the second
   * question answered to re-derive §5's thresholds, and reading it off the first
   * would calibrate them toward what annoys the reader rather than toward what is
   * wrong (§9z).
   *
   * The evidence and config hashes are captured from the finding as it stands, for
   * the same reason the dismissal captures them: a judgement is about *this* claim,
   * and one whose evidence later moves is a judgement about a different one.
   */
  app.post<{
    Params: { id: string };
    Body: { verdict: FindingVerdict; note?: string | null };
  }>(
    '/api/findings/:id/label',
    {
      schema: {
        summary: 'Record whether this finding was right (spec 7.6)',
        operationId: 'labelFinding',
        description:
          'Spec 7.6 asks for "a hand-labelled year of real statements with the expected ' +
          'findings written down" before any spec 5 threshold is treated as settled. This ' +
          'collects that corpus a finding at a time, while its evidence is on screen. ' +
          'Deliberately not the same as a dismissal: this is whether the rule was correct, ' +
          'not whether you want to see it. Measures precision only — nothing in the app can ' +
          'show you what the rules failed to find.',
        tags: ['analysis'],
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          required: ['verdict'],
          properties: {
            verdict: { type: 'string', enum: ['correct', 'incorrect', 'unsure'] },
            note: { type: ['string', 'null'], maxLength: 1000 },
          },
        },
        response: { 200: ref('Finding'), ...errorResponses },
      },
    },
    async (request, reply) => {
      const finding = context.store.findings.get(request.params.id);
      if (!finding) {
        return reply.code(404).send({ error: 'not_found', message: 'no such finding' });
      }

      const label = context.store.findingLabels.put({
        naturalKey: finding.naturalKey,
        ruleId: finding.ruleId,
        verdict: request.body.verdict,
        note: request.body.note ?? null,
        evidenceHash: finding.evidenceHash,
        configHash: finding.configHash,
      });

      return toWire(
        {
          finding,
          state: context.store.findings.getState(finding.naturalKey),
          evidenceTransactionIds: context.store.findings.listEvidence(finding.id),
        },
        label,
      );
    },
  );

  app.get(
    '/api/dismissal-rules',
    {
      schema: {
        summary: 'Standing merchant-scoped and rule-scoped dismissals',
        operationId: 'listDismissalRules',
        description: 'Spec 5.1’s second and third dismissal scopes, applied at emit time.',
        tags: ['analysis'],
        response: {
          200: { type: 'array', items: ref('DismissalRule') },
          ...errorResponses,
        },
      },
    },
    async () => context.store.findings.listDismissalRules(),
  );

  app.post<{
    Body: {
      scope: 'merchant_rule' | 'rule';
      ruleId: string;
      merchantId?: string | null;
      reason?: string | null;
    };
  }>(
    '/api/dismissal-rules',
    {
      schema: {
        summary: 'Dismiss a rule, or a rule for one merchant',
        operationId: 'createDismissalRule',
        description:
          'Applied at emit time (spec 3.1), so findings it covers become `suppressed` on the ' +
          'next run rather than being deleted. Idempotent on (scope, ruleId, merchantId).',
        tags: ['analysis'],
        body: {
          type: 'object',
          required: ['scope', 'ruleId'],
          properties: {
            scope: { type: 'string', enum: ['merchant_rule', 'rule'] },
            ruleId: { type: 'string', minLength: 1 },
            merchantId: {
              type: ['string', 'null'],
              description: 'Required for `merchant_rule`, rejected for `rule`',
            },
            reason: { type: ['string', 'null'] },
          },
        },
        response: { 201: ref('DismissalRule'), ...errorResponses },
      },
    },
    async (request, reply) => {
      const { scope, ruleId, merchantId } = request.body;

      // §3.1 puts the same pairing in a CHECK constraint. Refusing here as well
      // is not belt and braces: a constraint violation reaches the client as a
      // 500 with SQLite's wording, and this is a request the caller can fix.
      if (scope === 'merchant_rule' && !merchantId) {
        return reply
          .code(400)
          .send({ error: 'bad_request', message: 'merchant_rule scope needs a merchantId' });
      }
      if (scope === 'merchant_rule' && !context.store.merchants.get(merchantId as string)) {
        return reply.code(404).send({ error: 'not_found', message: 'no such merchant' });
      }

      const rule = context.store.findings.createDismissalRule({
        scope,
        ruleId,
        merchantId,
        reason: request.body.reason ?? null,
      });

      return reply.code(201).send(rule);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/dismissal-rules/:id',
    {
      schema: {
        summary: 'Lift a standing dismissal',
        operationId: 'deleteDismissalRule',
        description:
          'The findings it suppressed return to `active` on the next run — their rows were ' +
          'never deleted, so `first_detected_at` and any per-finding state survive (spec 5.1).',
        tags: ['analysis'],
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        response: {
          200: {
            type: 'object',
            properties: { deleted: { type: 'boolean' } },
            required: ['deleted'],
          },
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const deleted = context.store.findings.deleteDismissalRule(request.params.id);
      if (!deleted) {
        return reply.code(404).send({ error: 'not_found', message: 'no such dismissal rule' });
      }
      return { deleted };
    },
  );
}

/**
 * A full ISO timestamp, not §7.1's `YYYY-MM-DD`.
 *
 * §7.1's date rule is about `effective_date` — the one date analysis may use —
 * and this is not one of those: a snooze is a moment, and it is compared against
 * `Clock.now()`, which is "ISO 8601 with a `Z`". Storing a bare date here would
 * make that comparison mix two formats, and `'2026-05-13' > '2026-05-13T09:00Z'`
 * is false by string ordering, so a snooze would quietly expire at midnight of
 * the day it was granted rather than at the end of it.
 */
function snoozeUntil(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}
