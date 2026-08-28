import { auditTheme } from '@metrum/ui';
import { LEDGERLINE_THEME } from './ledgerline.theme';

/**
 * The one thing about a palette that cannot be settled by looking at it.
 *
 * `@metrum/ui` runs the same audit over the house theme. This is the app half of
 * that arrangement, and it is the reason `auditTheme` is exported rather than
 * kept inside the lib's own spec: an app that brings its own palette brings its
 * own obligation to prove it is readable, and the proof is one line.
 *
 * The light half is the half this exists for. Every colour in the dark palette
 * was picked against a dark ground and looks right; `#46d492` on cream is 2.1:1
 * and looks right too, in the sense that it is definitely green.
 */
describe('the Ledgerline theme', () => {
  it('is legible in both modes, on every ground', () => {
    expect(auditTheme(LEDGERLINE_THEME).map((failure) => failure.message)).toEqual([]);
  });

  // styles.scss declares these two literally, as the ground colour painted
  // between the browser reading index.html and Angular's initializer running.
  // They are the only tokens duplicated anywhere, and this is what stops the
  // duplicate from drifting into a one-frame flash of the wrong colour.
  it('matches the pre-bootstrap floor in styles.scss', () => {
    expect(LEDGERLINE_THEME.dark.bg).toBe('#0b1220');
    expect(LEDGERLINE_THEME.dark.text).toBe('#e7eef8');
  });
});
