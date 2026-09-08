/**
 * §6.9, against a stubbed `LedgerlineApiService`.
 *
 * These cases came from `settings-page.spec.ts` with the page they were testing
 * (§9s) and are unchanged apart from the container: what they pin is §4.1 step 7's
 * question reaching a person and §4.3's answer going back, and neither depended on
 * which page it happened on. Two are new — the badge's count, and what it counts.
 *
 * Stubbed rather than served, for the same reason the other six page specs are:
 * `apps/ledgerline-api`'s suite already drives the real HTTP surface.
 */

import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type {
  Calibration,
  Category,
  Job,
  Merchant,
  MerchantMergeResult,
  MerchantReviewQueue,
  MergeMerchantBody,
  ReviewMerchant,
  TransactionPage,
  UpdateMerchantBody,
} from '@metrum/api-client';

import { LedgerlineApiService } from '../ledgerline-api.service.js';
import { ReviewPage } from './review-page.js';
import { ReviewQueue } from './review-queue.service.js';

function reviewMerchant(id: string, name: string, transactionCount: number): ReviewMerchant {
  return {
    merchant: {
      id,
      canonicalName: name,
      displayName: name,
      website: null,
      defaultCategoryId: null,
      isKnownSubscription: false,
      isTransferKind: false,
      overlapGroup: null,
      source: 'rule',
    },
    transactionCount,
    sampleDescriptors: [name],
  };
}

/**
 * §7.6's scorecard, defaulted to a ledger part-way through calibration: statements
 * imported, an analysis run, some findings judged, some rows labelled.
 *
 * `unavailableReason: null` is the one field with a gate behind it — the API sets it
 * exactly when no analysis has finished, and three of §9ai's six steps read it.
 */
function calibrationOf(overrides: Partial<Calibration> = {}): Calibration {
  return {
    progress: { labelled: 42, fromReview: 40, fromCorrection: 2, total: 326 },
    normalization: {
      compared: 8,
      agreed: 6,
      disagreed: 2,
      fromReview: { compared: 6, agreed: 5 },
      fromCorrection: { compared: 2, agreed: 1 },
    },
    rules: [
      {
        ruleId: 'recurrence.v1',
        judgedCorrect: 3,
        judgedIncorrect: 1,
        expected: 5,
        found: 4,
        missed: 1,
        falsePositives: 1,
      },
      {
        ruleId: 'fees.v1',
        judgedCorrect: 2,
        judgedIncorrect: 0,
        expected: 3,
        found: 3,
        missed: 0,
        falsePositives: 0,
      },
    ],
    labels: [],
    unavailableReason: null,
    ...overrides,
  };
}

class ApiStub {
  // §4.1 step 7's queue. The shape is the spacing variant the first real
  // statement produced, because it is the case the page exists for.
  readonly merges: { id: string; intoMerchantId: string }[] = [];
  reads = 0;
  mergedTransactions = 14;

  reviewQueue: MerchantReviewQueue = {
    mergeCandidates: [
      {
        keep: reviewMerchant('samsclub', 'SAMSCLUB', 24),
        merge: reviewMerchant('sams-club', 'SAMS CLUB', 14),
        similarity: 0.583,
      },
    ],
    provisional: [
      reviewMerchant('samsclub', 'SAMSCLUB', 24),
      reviewMerchant('sams-club', 'SAMS CLUB', 14),
    ],
    llmProposals: [],
    llmProposalsUnavailableReason: 'Spec 4.2’s LLM stage needs spec 2.4’s provider seam.',
  };

  getMerchantReviewQueue(): Promise<MerchantReviewQueue> {
    this.reads += 1;
    return Promise.resolve(this.reviewQueue);
  }

  // §7.6's pass and the guide above it (§9ab, §9ai).
  calibration: Calibration = calibrationOf();

  getCalibration(): Promise<Calibration> {
    return Promise.resolve(this.calibration);
  }

  listTransactions(): Promise<TransactionPage> {
    return Promise.resolve({ rows: [], total: 0, limit: 500, offset: 0 });
  }

  jobState: Job['state'] = 'succeeded';

  getJob(): Promise<Job> {
    return Promise.resolve({
      id: 'job-1',
      kind: 'renormalize',
      state: this.jobState,
      progress: 100,
      message: null,
      resultJson: null,
      createdAt: '',
      updatedAt: '',
    } as Job);
  }

  mergeMerchant(id: string, body: MergeMerchantBody): Promise<MerchantMergeResult> {
    this.merges.push({ id, intoMerchantId: body.intoMerchantId });
    // §4.3's job is what actually moves the rows, so the queue only settles once
    // it has run — which is exactly what the page waits for.
    this.reviewQueue = { ...this.reviewQueue, mergeCandidates: [] };
    return Promise.resolve({
      merchantId: body.intoMerchantId,
      aliasKeysWritten: ['SAMS CLUB'],
      transactionsAffected: this.mergedTransactions,
      jobId: 'job-1',
      coalesced: false,
    });
  }

  /** §6.8's taxonomy, for the merchant editor's picker. */
  categories: Category[] = [
    {
      id: 'cat-groceries',
      name: 'Groceries',
      parentId: null,
      kind: 'spend',
      overlapGroup: null,
      source: 'seed',
    },
  ];

  listCategories(): Promise<Category[]> {
    return Promise.resolve(this.categories);
  }

  readonly merchantPatches: { id: string; body: UpdateMerchantBody }[] = [];

  updateMerchant(id: string, body: UpdateMerchantBody): Promise<Merchant> {
    this.merchantPatches.push({ id, body });
    // What the API does: the row is promoted to `user`, and the queue re-read
    // afterwards shows the new name.
    this.reviewQueue = {
      ...this.reviewQueue,
      provisional: this.reviewQueue.provisional.map((entry) =>
        entry.merchant.id === id
          ? {
              ...entry,
              merchant: { ...entry.merchant, ...body, source: 'user' as const },
            }
          : entry,
      ),
    };
    return Promise.resolve({} as Merchant);
  }
}

describe('ReviewPage', () => {
  let api: ApiStub;

  beforeEach(async () => {
    api = new ApiStub();
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [ReviewPage],
      // §9ai's guide links to the pages its other five steps live on.
      providers: [provideRouter([]), { provide: LedgerlineApiService, useValue: api }],
    }).compileComponents();
  });

  async function render() {
    const fixture = TestBed.createComponent(ReviewPage);
    await fixture.whenStable();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  // ------------------------------------------------- asking the question ---

  it('asks about a pair rather than merging it', async () => {
    const { el } = await render();

    expect(el.querySelectorAll('.card')).toHaveLength(1);
    expect(el.querySelector('.card__claim')?.textContent).toContain('SAMSCLUB');
    expect(el.querySelector('.card__claim')?.textContent).toContain('SAMS CLUB');
    // Nothing has been applied by rendering the question.
    expect(api.merges).toEqual([]);
  });

  it('names the effect in charges before anything is clicked', async () => {
    const { el } = await render();

    expect(el.querySelector('.card__effect')?.textContent).toContain('14 charges move');
    expect(el.querySelector('.card__effect')?.textContent).toContain('permanent');
  });

  it('says so plainly when there is nothing to review', async () => {
    api.reviewQueue = {
      mergeCandidates: [],
      provisional: [],
      llmProposals: [],
      llmProposalsUnavailableReason: null,
    };
    const { el } = await render();

    expect(el.textContent).toContain('Nothing to review');
    expect(el.querySelectorAll('.card')).toHaveLength(0);
  });

  // -------------------------------------------- editing a merchant (§9af) ---

  /**
   * §2.3's `PATCH /api/merchants/:id`, reached from the provisional list.
   *
   * The list was read-only, which was fine while its only purpose was to show
   * what the chain had named for itself. Once §5.2 and §2.5 read flags off these
   * rows and nothing could set them, the list was showing a problem with no way
   * to answer it.
   */
  describe('the merchant editor', () => {
    async function openFirstEditor() {
      const rendered = await render();
      const edit = rendered.el.querySelector('.provisional__edit') as HTMLButtonElement;
      edit.click();
      await rendered.fixture.whenStable();
      return rendered;
    }

    it('opens on the row, prefilled with what the merchant already says', async () => {
      const { el } = await openFirstEditor();

      const name = el.querySelector('.editor__input') as HTMLInputElement;
      expect(name.value).toBe('SAMSCLUB');
      // Offers §6.8's taxonomy, not a free-text category.
      expect([...el.querySelectorAll('.editor select option')].map((o) => o.textContent?.trim()))
        .toEqual(['— none —', 'Groceries']);
    });

    it('sends the rename and the flags as one PATCH', async () => {
      const { el, fixture } = await openFirstEditor();

      const name = el.querySelector('.editor__input') as HTMLInputElement;
      name.value = "Sam's Club";
      name.dispatchEvent(new Event('input'));

      const subscription = el.querySelector('.editor__check input') as HTMLInputElement;
      subscription.checked = true;
      subscription.dispatchEvent(new Event('change'));
      await fixture.whenStable();

      (el.querySelector('.editor .button--primary') as HTMLButtonElement).click();
      await fixture.whenStable();

      expect(api.merchantPatches).toEqual([
        {
          id: 'samsclub',
          body: {
            displayName: "Sam's Club",
            // Not `''` — §3.2 stores it nullable and RESTRICTs it, so a blank
            // string would be an id that does not exist rather than an absence.
            defaultCategoryId: null,
            isKnownSubscription: true,
            isTransferKind: false,
          },
        },
      ]);
    });

    it('opens no editor and writes nothing by rendering the list', async () => {
      const { el } = await render();

      expect(el.querySelector('.editor')).toBeNull();
      expect(api.merchantPatches).toEqual([]);
    });

    /**
     * The notice is the whole reason this is worth a test. A rename moves no
     * charges — unlike the merge above it — and the flags it sets are read by
     * §5.2 and §2.5 only at §2.7's next run. Saying "done" would be claiming a
     * recalculation that has not happened.
     */
    it('says plainly that nothing moved and the numbers follow later', async () => {
      const { el, fixture } = await openFirstEditor();

      (el.querySelector('.editor .button--primary') as HTMLButtonElement).click();
      await fixture.whenStable();

      const notice = el.querySelector('.notice')?.textContent ?? '';
      expect(notice).toContain('No charges moved');
      expect(notice).toContain('next analysis run');
    });

    /**
     * Answering the question removes it: the queue's provisional list is
     * `source = 'rule'`, and §2.3's edit promotes the row to `user`. Right for a
     * queue, and a trap for the minute afterwards — pick the wrong category and
     * the row is gone from the only screen that offered it. So an edited merchant
     * stays put, marked, until the page is left.
     */
    it('keeps an edited merchant on screen after it stops being a question', async () => {
      const { el, fixture } = await openFirstEditor();

      // The API drops it from `provisional` once it is no longer `rule`.
      api.reviewQueue = { ...api.reviewQueue, provisional: [] };

      (el.querySelector('.editor .button--primary') as HTMLButtonElement).click();
      await fixture.whenStable();

      const rows = [...el.querySelectorAll('.provisional__row')];
      expect(rows).toHaveLength(1);
      expect(rows[0].textContent).toContain('SAMSCLUB');
      expect(rows[0].querySelector('.tag--saved')).not.toBeNull();
      // And still editable, which is the whole reason it is still here.
      expect(rows[0].querySelector('.provisional__edit')).not.toBeNull();
    });

    it('refuses to save an empty name, which would leave a merchant nobody can pick', async () => {
      const { el, fixture } = await openFirstEditor();

      const name = el.querySelector('.editor__input') as HTMLInputElement;
      name.value = '   ';
      name.dispatchEvent(new Event('input'));
      await fixture.whenStable();

      expect((el.querySelector('.editor .button--primary') as HTMLButtonElement).disabled).toBe(
        true,
      );
    });
  });

  // ------------------------------------------------ answering it (§4.3) ---

  it('merges in the direction the card is pointing', async () => {
    const { el, fixture } = await render();
    (el.querySelector('.button--primary') as HTMLButtonElement).click();
    await fixture.whenStable();

    expect(api.merges).toEqual([{ id: 'sams-club', intoMerchantId: 'samsclub' }]);
  });

  it('flips the direction without merging anything', async () => {
    const { el, fixture } = await render();
    const flip = [...el.querySelectorAll('.card__actions .button')].find((b) =>
      b.textContent?.includes('Keep SAMS CLUB instead'),
    ) as HTMLButtonElement;

    flip.click();
    await fixture.whenStable();

    expect(api.merges).toEqual([]);
    expect(el.querySelector('.button--primary')?.textContent).toContain('Merge into SAMS CLUB');
  });

  it('clears the card once §4.3’s job has actually moved the rows', async () => {
    // The alias write is synchronous; the rows are not. A re-read issued before
    // the job lands re-proposes the merge that was just made.
    const { el, fixture } = await render();
    (el.querySelector('.button--primary') as HTMLButtonElement).click();
    await fixture.whenStable();

    expect(el.querySelectorAll('.card')).toHaveLength(0);
    expect(el.querySelector('.notice')?.textContent).toContain('have been recalculated');
  });

  // The other branch of `awaitJob` — a job still queued when the poll runs out —
  // is deliberately not covered here: reaching it means waiting out the full
  // bound, and a spec that sleeps fifteen seconds to assert one string is a spec
  // people start skipping. What matters is that a timeout is not treated as a
  // failure, which is visible in `awaitJob` returning a boolean rather than
  // throwing.

  it('reports the count the API returned, not the one the card showed', async () => {
    // They should agree. On the day they do not, a permanent change is owed the
    // true number.
    api.mergedTransactions = 9;
    const { el, fixture } = await render();
    (el.querySelector('.button--primary') as HTMLButtonElement).click();
    await fixture.whenStable();

    expect(el.querySelector('.notice')?.textContent).toContain('9 charges moved');
  });

  // ---------------------------------------------- the rail's count (§9s) ---

  describe('the count behind the rail badge', () => {
    it('counts questions, not provisional merchants', async () => {
      await render();

      // One pair to decide; the two provisional merchants are context, not a
      // question, and a badge of 3 here would be a badge nobody reads.
      expect(TestBed.inject(ReviewQueue).outstanding()).toBe(1);
    });

    it('falls to zero once the merge lands, from the API and not by subtraction', async () => {
      const { el, fixture } = await render();
      (el.querySelector('.button--primary') as HTMLButtonElement).click();
      await fixture.whenStable();

      expect(TestBed.inject(ReviewQueue).outstanding()).toBe(0);
      // One read on entry and one after the merge. The page holds no queue of its
      // own beside the shared one, so the rail cannot be shown a second number,
      // and a zero arrived at by decrementing would have left this at 1.
      expect(api.reads).toBe(2);
    });

    it('keeps the last known queue when a re-read fails', async () => {
      await render();
      const queue = TestBed.inject(ReviewQueue);

      api.getMerchantReviewQueue = () => Promise.reject(new Error('API is down'));
      await queue.refresh();

      // "The API is not answering" and "you have nothing left to review" are
      // different facts, and only one of them belongs in an empty badge.
      expect(queue.outstanding()).toBe(1);
      expect(queue.error()?.message).toBe('API is down');
    });
  });

  // ------------------------------------- §7.6's loop, on screen (§9ai) ---

  /**
   * Every part of calibrating existed before this and the **sequence** did not. The
   * cases worth pinning are the two that make the guide worth having: that it says
   * which step you are on, and that it says which steps cannot happen yet — because
   * meeting the scorecard's refusal without that explanation reads as a broken
   * feature rather than an out-of-order one.
   */
  describe('the calibration guide', () => {
    async function calibrateTab() {
      const rendered = await render();
      const tab = [...rendered.el.querySelectorAll('.mode')].find((node) =>
        node.textContent?.includes('Go through the charges'),
      ) as HTMLButtonElement;
      tab.click();
      await rendered.fixture.whenStable();
      return rendered;
    }

    /** The default fixture is part-way through, so the guide arrives folded. These
     *  cases are about what it says; the fold itself has its own case below. */
    async function expanded() {
      const rendered = await calibrateTab();
      if (rendered.el.querySelectorAll('.step').length === 0) {
        (rendered.el.querySelector('.guide__toggle') as HTMLButtonElement).click();
        await rendered.fixture.whenStable();
      }
      return rendered;
    }

    const stepFor = (el: HTMLElement, title: string) =>
      [...el.querySelectorAll('.step')].find((node) =>
        node.querySelector('.step__title')?.textContent?.includes(title),
      ) as HTMLElement;

    it('names all six steps and marks the one this page is', async () => {
      const { el } = await expanded();

      expect(el.querySelectorAll('.step')).toHaveLength(6);
      const here = el.querySelectorAll('.step--here');
      expect(here).toHaveLength(1);
      expect(here[0].textContent).toContain('Say what each charge really is');
    });

    it('reports each step in the counts the API gave it', async () => {
      const { el } = await expanded();

      expect(stepFor(el, 'Import your statements').textContent).toContain('326 charges imported');
      // 3 + 1 + 2 + 0 across the two rules in the fixture.
      expect(stepFor(el, 'each finding was right').textContent).toContain('6 findings judged');
      expect(stepFor(el, 'what each charge really is').textContent).toContain('42 of 326');
    });

    /**
     * The gate. Recall compares a label against what the rules concluded, so three of
     * the six steps genuinely cannot happen before a run — and the guide has to say
     * that rather than let someone label two hundred rows into a scorecard that will
     * refuse to answer.
     */
    it('says which steps an analysis has to come before', async () => {
      api.calibration = calibrationOf({
        rules: [],
        unavailableReason: 'No analysis has finished, so there is nothing to compare against.',
      });
      const { el } = await expanded();

      expect(stepFor(el, 'Run an analysis').textContent).toContain('no analysis has finished');
      for (const title of [
        'each finding was right',
        'what that says about the rules',
        'Move the thresholds',
      ]) {
        expect(stepFor(el, title).className).toContain('step--blocked');
        expect(stepFor(el, title).textContent).toContain('needs an analysis first');
      }

      // Labelling is not gated — it is the one step you can do before a run, and
      // the guide must not talk somebody out of it.
      expect(stepFor(el, 'what each charge really is').className).not.toContain('step--blocked');
    });

    /** Open until the work starts, collapsed after: a permanent instruction panel
     *  above the work becomes furniture. */
    it('opens itself on an untouched ledger and folds away once labelling starts', async () => {
      api.calibration = calibrationOf({
        progress: { labelled: 0, fromReview: 0, fromCorrection: 0, total: 326 },
      });
      const fresh = await calibrateTab();
      expect(fresh.el.querySelectorAll('.step').length).toBeGreaterThan(0);

      TestBed.resetTestingModule();
      api = new ApiStub();
      api.calibration = calibrationOf({
        progress: { labelled: 40, fromReview: 40, fromCorrection: 0, total: 326 },
      });
      await TestBed.configureTestingModule({
        imports: [ReviewPage],
        providers: [provideRouter([]), { provide: LedgerlineApiService, useValue: api }],
      }).compileComponents();

      const underway = await calibrateTab();
      expect(underway.el.querySelectorAll('.step')).toHaveLength(0);

      (underway.el.querySelector('.guide__toggle') as HTMLButtonElement).click();
      await underway.fixture.whenStable();
      expect(underway.el.querySelectorAll('.step')).toHaveLength(6);
    });

    it('is not on the queue tab, which is a different errand', async () => {
      const { el } = await render();
      expect(el.querySelector('ll-calibration-guide')).toBeNull();
    });
  });
});
