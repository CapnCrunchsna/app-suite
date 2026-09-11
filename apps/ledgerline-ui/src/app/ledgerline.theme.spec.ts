import { LEDGERLINE_THEME } from '@metrum/ui';

/**
 * What stays with the app once the palette itself moved to `@metrum/ui`.
 *
 * The WCAG audit moved with it — `theming.spec.ts` now runs `auditTheme` over
 * every palette in `SUITE_THEMES`, because any app can be painted in any of
 * them. What cannot move is the assertion below: the pre-bootstrap floor is a
 * value in *this app's* stylesheet, and only this app knows what it declared.
 */
describe('the Ledgerline theme', () => {
  // styles.scss declares these two literally, as the ground colour painted
  // between the browser reading index.html and Angular's initializer running.
  // They are the only tokens duplicated anywhere, and this is what stops the
  // duplicate from drifting into a one-frame flash of the wrong colour.
  it('matches the pre-bootstrap floor in styles.scss', () => {
    expect(LEDGERLINE_THEME.dark.bg).toBe('#0b1220');
    expect(LEDGERLINE_THEME.dark.text).toBe('#e7eef8');
  });
});
