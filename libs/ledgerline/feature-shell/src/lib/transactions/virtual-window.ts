/**
 * The windowing arithmetic behind §6.3's "virtualized table".
 *
 * A pure function over four numbers, separate from the component, because it is
 * the only part of the table with an off-by-one that a screenshot would not
 * reveal. A window that is one row short leaves a blank stripe at the bottom of a
 * fast scroll; one row long is invisible. Both are testable here and neither is
 * testable through the DOM without a real scroll.
 *
 * ## Why one expanded row is in the arithmetic
 *
 * Fixed-height virtualization assumes every row is `rowHeight` tall, and §6.3's
 * row expander breaks that assumption the moment it opens. Three ways out:
 * measure every row (defeats the point — you cannot know a row's height without
 * rendering it), forbid the expander (drops a requirement), or allow exactly one
 * expanded row and put its extra height into the offsets. The third is what this
 * does, and it is why `expandedIndex` and `expandedHeight` are parameters rather
 * than something the component patches up afterwards.
 *
 * Everything is in the *page* the API returned, not the whole table: the server
 * paginates (§2.3) and this virtualizes within a page. A household of 58,000
 * transactions (§2.2) is 233 pages of 250, and at 44px a row the browser is asked
 * for ~20 elements at a time either way.
 */

export interface VirtualWindowInput {
  /** Rows in the current page. */
  readonly count: number;
  readonly rowHeight: number;
  /** Height of the scrolling viewport in pixels. */
  readonly viewportHeight: number;
  readonly scrollTop: number;
  /** Index of the one expanded row, or `-1`. */
  readonly expandedIndex: number;
  /** Measured pixel height of the expanded row's detail panel. */
  readonly expandedHeight: number;
  /**
   * Rows rendered beyond each edge of the viewport.
   *
   * Not a performance knob — a correctness one. Without it, a scroll that lands
   * mid-row shows a gap at the leading edge for one frame, because the browser
   * scrolls before the next change detection has produced the row.
   */
  readonly overscan?: number;
}

export interface VirtualWindow {
  /** First rendered row index, inclusive. */
  readonly start: number;
  /** Last rendered row index, exclusive. */
  readonly end: number;
  /** Spacer above the rendered slice, in pixels. */
  readonly paddingTop: number;
  /** Spacer below it. */
  readonly paddingBottom: number;
  /** Total scrollable height, so the scrollbar is the right size. */
  readonly totalHeight: number;
}

const DEFAULT_OVERSCAN = 4;

export const ROW_HEIGHT = 44;

export function virtualWindow(input: VirtualWindowInput): VirtualWindow {
  const { count, rowHeight, viewportHeight, expandedIndex, expandedHeight } = input;
  const overscan = input.overscan ?? DEFAULT_OVERSCAN;
  const expanded = expandedIndex >= 0 && expandedIndex < count ? expandedHeight : 0;
  const totalHeight = count * rowHeight + expanded;

  if (count === 0 || rowHeight <= 0) {
    return {
      start: 0,
      end: 0,
      paddingTop: 0,
      paddingBottom: 0,
      totalHeight: 0,
    };
  }

  // Clamp before dividing. A browser can report a `scrollTop` past the content
  // during an overscroll bounce, and a negative `start` renders a slice from the
  // end of the array.
  const scrollTop = Math.max(
    0,
    Math.min(input.scrollTop, Math.max(0, totalHeight - viewportHeight)),
  );

  // How much of the scroll offset is the expanded panel rather than rows. Above
  // the expanded row this is zero; below it, the whole panel.
  const expandedAbove = (offset: number): number =>
    expanded > 0 && offset > expandedIndex * rowHeight + rowHeight ? expanded : 0;

  // Solve for the first row whose bottom edge is past the scroll offset. One
  // pass, because `expandedAbove` depends on the answer: assume no panel above,
  // then correct once. A second correction cannot change the result — the panel
  // is either entirely above the offset or entirely below it.
  const firstGuess = Math.floor(scrollTop / rowHeight);
  const correction = expandedAbove(scrollTop) > 0 ? Math.floor(expanded / rowHeight) : 0;
  const first = Math.max(0, firstGuess - correction);

  const visibleRows = Math.ceil(viewportHeight / rowHeight);
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, first + visibleRows + overscan * 2);

  // The spacers are measured in the same terms the rows are laid out in, so the
  // expanded panel counts toward whichever spacer it falls inside.
  const expandedBefore = expanded > 0 && expandedIndex < start ? expanded : 0;
  const expandedAfter = expanded > 0 && expandedIndex >= end ? expanded : 0;

  return {
    start,
    end,
    paddingTop: start * rowHeight + expandedBefore,
    paddingBottom: (count - end) * rowHeight + expandedAfter,
    totalHeight,
  };
}
