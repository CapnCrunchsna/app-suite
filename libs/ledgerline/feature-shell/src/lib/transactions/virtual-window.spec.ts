/**
 * The window arithmetic, including the expanded-row case that makes it more than
 * a division.
 *
 * The invariant every test here checks in one form or another: the rendered slice
 * plus the two spacers must always add up to the total height, or the scrollbar
 * lies and the rows drift away from the pointer.
 */

import { ROW_HEIGHT, virtualWindow } from './virtual-window.js';

const base = {
  count: 250,
  rowHeight: ROW_HEIGHT,
  viewportHeight: 440,
  scrollTop: 0,
  expandedIndex: -1,
  expandedHeight: 0,
};

describe('virtualWindow', () => {
  it('renders from the top with overscan below only', () => {
    const window = virtualWindow(base);

    expect(window.start).toBe(0);
    expect(window.paddingTop).toBe(0);
    // Ten rows fit in 440px; the slice carries the overscan on both sides but
    // cannot start before zero.
    expect(window.end).toBe(18);
    expect(window.totalHeight).toBe(250 * ROW_HEIGHT);
  });

  it('keeps the slice and the spacers summing to the total height', () => {
    for (const scrollTop of [0, 100, 1000, 4400, 10_000, 10_560]) {
      const window = virtualWindow({ ...base, scrollTop });
      const rendered = (window.end - window.start) * ROW_HEIGHT;

      expect(window.paddingTop + rendered + window.paddingBottom).toBe(window.totalHeight);
    }
  });

  it('shows the row under the scroll offset', () => {
    // Scrolled to row 100 exactly.
    const window = virtualWindow({ ...base, scrollTop: 100 * ROW_HEIGHT });

    expect(window.start).toBeLessThanOrEqual(100);
    expect(window.end).toBeGreaterThan(100);
  });

  it('clamps an overscrolled offset rather than slicing past the end', () => {
    const window = virtualWindow({ ...base, scrollTop: 999_999 });

    expect(window.end).toBe(250);
    expect(window.start).toBeLessThan(250);
    expect(window.paddingBottom).toBe(0);
  });

  it('clamps a negative offset rather than slicing from the end', () => {
    const window = virtualWindow({ ...base, scrollTop: -500 });

    expect(window.start).toBe(0);
    expect(window.paddingTop).toBe(0);
  });

  it('is empty for an empty page', () => {
    expect(virtualWindow({ ...base, count: 0 })).toEqual({
      start: 0,
      end: 0,
      paddingTop: 0,
      paddingBottom: 0,
      totalHeight: 0,
    });
  });

  it('adds the expanded panel to the total height', () => {
    const window = virtualWindow({
      ...base,
      expandedIndex: 5,
      expandedHeight: 180,
    });

    expect(window.totalHeight).toBe(250 * ROW_HEIGHT + 180);
  });

  it('ignores an expanded index outside the page', () => {
    const window = virtualWindow({
      ...base,
      expandedIndex: 900,
      expandedHeight: 180,
    });

    expect(window.totalHeight).toBe(250 * ROW_HEIGHT);
  });

  it('counts the expanded panel into whichever spacer it falls inside', () => {
    // Expanded row 2, scrolled well past it: the panel is above the slice, so it
    // belongs to the top spacer and the sum still holds.
    const above = virtualWindow({
      ...base,
      scrollTop: 100 * ROW_HEIGHT,
      expandedIndex: 2,
      expandedHeight: 180,
    });
    const renderedAbove = (above.end - above.start) * ROW_HEIGHT;
    expect(above.paddingTop + renderedAbove + above.paddingBottom).toBe(above.totalHeight);
    expect(above.paddingTop).toBeGreaterThan(above.start * ROW_HEIGHT);

    // Expanded row 200, scrolled to the top: the panel is below the slice.
    const below = virtualWindow({
      ...base,
      expandedIndex: 200,
      expandedHeight: 180,
    });
    const renderedBelow = (below.end - below.start) * ROW_HEIGHT;
    expect(below.paddingTop + renderedBelow + below.paddingBottom).toBe(below.totalHeight);
    expect(below.paddingBottom).toBe((250 - below.end) * ROW_HEIGHT + 180);
  });

  it('keeps the sum right while the expanded row is inside the slice', () => {
    // The panel is neither above nor below — it is being rendered, so it must not
    // be double-counted into a spacer.
    const window = virtualWindow({
      ...base,
      scrollTop: 5 * ROW_HEIGHT,
      expandedIndex: 6,
      expandedHeight: 180,
    });
    const rendered = (window.end - window.start) * ROW_HEIGHT;

    expect(window.paddingTop + rendered + window.paddingBottom + 180).toBe(window.totalHeight);
  });

  it('does not scroll a row off the top once a panel above it opens', () => {
    // The user expands row 2, then scrolls. Without the correction the extra 180px
    // of panel would be read as four more rows of offset and the slice would jump
    // four rows past where the pointer is.
    const scrollTop = 40 * ROW_HEIGHT;
    const withPanel = virtualWindow({
      ...base,
      scrollTop,
      expandedIndex: 2,
      expandedHeight: 180,
    });

    expect(withPanel.start).toBeLessThan(40);
    expect(withPanel.end).toBeGreaterThan(36);
  });
});
