/**
 * What calibrating actually is, on the page where you do most of it.
 *
 * §7.6 asks for "a hand-labelled year of real statements with the expected findings
 * written down", and by §9ah every part of that existed: §9z's finding verdicts,
 * §9ab's row labels and this pass, the scorecard below it, and §6.8's thresholds with
 * their tallies beside them. What did not exist anywhere was the **sequence**. Each
 * screen explained its own job well and none of them said it was one step of six, or
 * which step had to come first.
 *
 * That gap is not cosmetic. Two of the six are gated — every recall figure compares a
 * label against what the rules concluded, so labelling before an analysis has run
 * produces a scorecard that refuses to answer (`unavailableReason`), and someone who
 * met that refusal first would reasonably conclude the feature was broken rather than
 * out of order.
 *
 * ## It derives, and asks for nothing
 *
 * Every number here already travels on `GET /api/calibration`: rows imported and
 * labelled from `progress`, whether an analysis has finished from
 * `unavailableReason`, and findings judged from the per-rule `judgedCorrect` and
 * `judgedIncorrect`. So the guide is a view over a payload this page already holds —
 * no second request, and nothing that can disagree with the scorecard under it.
 *
 * ## It gets out of the way
 *
 * Open until the first row is labelled, collapsed after. A permanent instruction
 * panel above the work is a panel that becomes furniture, and the person who has
 * labelled forty rows knows the loop. Derived from the work rather than remembered,
 * because there is nowhere in this app to remember it and a preference that resets on
 * reload is worse than one that follows what you have done.
 *
 * Presentational, like the pass beside it: the container owns every request.
 */

import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { Calibration } from '@metrum/api-client';

interface GuideStep {
  readonly n: number;
  readonly title: string;
  /** Where the work stands, in counts. Never a percentage — §7.6's own rule. */
  readonly status: string;
  /** The distinction between steps 3 and 4, which is the one worth spelling out. */
  readonly why: string | null;
  /** True when an earlier step has to happen first; the status says which. */
  readonly blocked: boolean;
  readonly here: boolean;
  readonly route: string | null;
  readonly routeLabel: string | null;
}

@Component({
  selector: 'll-calibration-guide',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './calibration-guide.html',
  styleUrl: './calibration-guide.scss',
})
export class CalibrationGuide {
  readonly report = input.required<Calibration | null>();

  /** Null until someone presses the toggle, after which their choice wins over the
   *  derived default for as long as the page is open. */
  private readonly override = signal<boolean | null>(null);

  protected readonly open = computed(
    () => this.override() ?? (this.report()?.progress.labelled ?? 0) === 0,
  );

  protected toggle(): void {
    this.override.set(!this.open());
  }

  protected readonly steps = computed<GuideStep[]>(() => {
    const report = this.report();
    const total = report?.progress.total ?? 0;
    const labelled = report?.progress.labelled ?? 0;
    // `unavailableReason` is set exactly when no analysis has finished, and a null
    // report is a read that has not landed — neither is a run.
    const analysed = report !== null && report.unavailableReason === null;
    const judged = (report?.rules ?? []).reduce(
      (count, rule) => count + rule.judgedCorrect + rule.judgedIncorrect,
      0,
    );

    return [
      {
        n: 1,
        title: 'Import your statements',
        status:
          total === 0
            ? 'nothing imported yet'
            : `${total} ${total === 1 ? 'charge' : 'charges'} imported`,
        why: null,
        blocked: false,
        here: false,
        route: '/imports',
        routeLabel: 'Import',
      },
      {
        n: 2,
        title: 'Run an analysis',
        status: analysed
          ? 'done — run it again after every change you make below'
          : 'no analysis has finished yet',
        why: null,
        blocked: total === 0,
        here: false,
        route: '/findings',
        routeLabel: 'Findings',
      },
      {
        n: 3,
        title: 'Say whether each finding was right',
        status: !analysed
          ? 'needs an analysis first'
          : judged === 0
            ? 'none judged yet'
            : `${judged} ${judged === 1 ? 'finding' : 'findings'} judged`,
        why: 'This measures what the rules got wrong. Marking one wrong is not dismissing it.',
        blocked: !analysed,
        here: false,
        route: '/findings',
        routeLabel: 'Findings',
      },
      {
        n: 4,
        title: 'Say what each charge really is',
        status:
          total === 0 ? 'nothing to go through yet' : `${labelled} of ${total} charges judged`,
        why: 'This measures what they missed, which nothing else in the app can show you.',
        blocked: total === 0,
        here: true,
        route: null,
        routeLabel: null,
      },
      {
        n: 5,
        title: 'Read what that says about the rules',
        status: analysed ? 'the panel below this one' : 'needs an analysis first',
        why: null,
        blocked: !analysed,
        here: false,
        route: null,
        routeLabel: null,
      },
      {
        n: 6,
        title: 'Move the thresholds the evidence points at',
        status: analysed ? 'then run the analysis again' : 'needs an analysis first',
        why: null,
        blocked: !analysed,
        here: false,
        route: '/settings',
        routeLabel: 'Settings',
      },
    ];
  });
}
