/**
 * Inputs needed to calculate a uniformly sized virtual list window.
 *
 * `rowHeight` is intentionally supplied by the caller so the same calculation
 * can use measured desktop, mobile, or user-scaled dimensions without coupling
 * this module to CSS breakpoints.
 */
export interface VirtualWindowInput {
  readonly itemCount: number;
  readonly overscan: number;
  readonly rowHeight: number;
  readonly scrollOffset: number;
  readonly viewportHeight: number;
}

/** A half-open range where `endIndex` is excluded. */
export interface VirtualWindow {
  /** First rendered item, including overscan. */
  readonly startIndex: number;
  /** First item after the rendered range, including overscan. */
  readonly endIndex: number;
  /** First item intersecting the viewport. */
  readonly visibleStartIndex: number;
  /** First item after the viewport's visible range. */
  readonly visibleEndIndex: number;
  /** Spacer size before the rendered range. */
  readonly offsetTop: number;
  /** Spacer size after the rendered range. */
  readonly offsetBottom: number;
  /** Full scrollable height represented by every item. */
  readonly totalHeight: number;
  /** Scroll offset clamped to the current item count and viewport. */
  readonly scrollOffset: number;
}

export interface VirtualScrollRebaseInput {
  readonly itemCount: number;
  readonly nextRowHeight: number;
  readonly nextViewportHeight: number;
  readonly previousRowHeight: number;
  readonly previousScrollOffset: number;
}

/**
 * Immutable prefix offsets for rows whose rendered heights are not uniform.
 * Recreate this layout only when measurements or filtered results change;
 * window lookup itself is logarithmic in the number of rows.
 */
export interface MeasuredVirtualLayout {
  readonly itemCount: number;
  readonly offsets: readonly number[];
  readonly totalHeight: number;
}

export interface MeasuredVirtualWindowInput {
  readonly layout: MeasuredVirtualLayout;
  readonly overscan: number;
  readonly scrollOffset: number;
  readonly viewportHeight: number;
}

const verifiedMeasuredLayouts = new WeakSet<object>();

/**
 * Calculates the rows and spacers needed for a virtual list.
 *
 * The returned ranges are half-open, making them safe to pass to `Array.slice`.
 * A stale scroll offset is clamped before calculating the range, which prevents
 * an empty viewport when filtering removes items near the end of a list.
 */
export function calculateVirtualWindow(input: VirtualWindowInput): VirtualWindow {
  const { itemCount, overscan, rowHeight, scrollOffset, viewportHeight } = input;

  assertSafeInteger('itemCount', itemCount);
  assertSafeInteger('overscan', overscan);
  assertFiniteNumber('rowHeight', rowHeight);
  assertFiniteNumber('scrollOffset', scrollOffset);
  assertFiniteNumber('viewportHeight', viewportHeight);

  if (itemCount < 0) throw new RangeError('itemCount must be greater than or equal to 0.');
  if (overscan < 0) throw new RangeError('overscan must be greater than or equal to 0.');
  if (rowHeight <= 0) throw new RangeError('rowHeight must be greater than 0.');
  if (viewportHeight < 0) {
    throw new RangeError('viewportHeight must be greater than or equal to 0.');
  }

  const totalHeight = itemCount * rowHeight;
  if (!Number.isFinite(totalHeight) || totalHeight > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('itemCount multiplied by rowHeight must not exceed safe pixel bounds.');
  }

  const normalizedScrollOffset = clampScrollOffset(scrollOffset, totalHeight, viewportHeight);

  if (itemCount === 0) {
    return {
      startIndex: 0,
      endIndex: 0,
      visibleStartIndex: 0,
      visibleEndIndex: 0,
      offsetTop: 0,
      offsetBottom: 0,
      totalHeight: 0,
      scrollOffset: 0,
    };
  }

  const visibleStartIndex = Math.min(itemCount, Math.floor(normalizedScrollOffset / rowHeight));
  const visibleEndIndex =
    viewportHeight === 0
      ? visibleStartIndex
      : Math.min(itemCount, Math.ceil((normalizedScrollOffset + viewportHeight) / rowHeight));
  const startIndex = Math.max(0, visibleStartIndex - overscan);
  const endIndex = visibleEndIndex >= itemCount - overscan ? itemCount : visibleEndIndex + overscan;

  return {
    startIndex,
    endIndex,
    visibleStartIndex,
    visibleEndIndex,
    offsetTop: startIndex * rowHeight,
    offsetBottom: (itemCount - endIndex) * rowHeight,
    totalHeight,
    scrollOffset: normalizedScrollOffset,
  };
}

/**
 * Builds reusable prefix offsets for variable-height rows, including content-
 * driven mobile cards. The final offset is a sentinel equal to `totalHeight`.
 */
export function createMeasuredVirtualLayout(rowHeights: readonly number[]): MeasuredVirtualLayout {
  const offsets = new Array<number>(rowHeights.length + 1);
  offsets[0] = 0;

  let totalHeight = 0;
  for (const [index, rowHeight] of rowHeights.entries()) {
    assertFiniteNumber(`rowHeights[${index}]`, rowHeight);
    if (rowHeight <= 0) {
      throw new RangeError(`rowHeights[${index}] must be greater than 0.`);
    }

    totalHeight += rowHeight;
    if (!Number.isFinite(totalHeight) || totalHeight > Number.MAX_SAFE_INTEGER) {
      throw new RangeError('The measured row heights must not exceed safe pixel bounds.');
    }
    offsets[index + 1] = totalHeight;
  }

  const layout: MeasuredVirtualLayout = Object.freeze({
    itemCount: rowHeights.length,
    offsets: Object.freeze(offsets),
    totalHeight,
  });
  verifiedMeasuredLayouts.add(layout);
  return layout;
}

/** Calculates a virtual window from a reusable variable-height row layout. */
export function calculateMeasuredVirtualWindow(input: MeasuredVirtualWindowInput): VirtualWindow {
  const { layout, overscan, scrollOffset, viewportHeight } = input;
  validateMeasuredLayout(layout);
  assertSafeInteger('overscan', overscan);
  assertFiniteNumber('scrollOffset', scrollOffset);
  assertFiniteNumber('viewportHeight', viewportHeight);

  if (overscan < 0) throw new RangeError('overscan must be greater than or equal to 0.');
  if (viewportHeight < 0) {
    throw new RangeError('viewportHeight must be greater than or equal to 0.');
  }

  const { itemCount, offsets, totalHeight } = layout;
  const normalizedScrollOffset = clampScrollOffset(scrollOffset, totalHeight, viewportHeight);

  if (itemCount === 0) {
    return {
      startIndex: 0,
      endIndex: 0,
      visibleStartIndex: 0,
      visibleEndIndex: 0,
      offsetTop: 0,
      offsetBottom: 0,
      totalHeight: 0,
      scrollOffset: 0,
    };
  }

  const visibleStartIndex = upperBound(offsets, normalizedScrollOffset) - 1;
  const visibleEndIndex =
    viewportHeight === 0
      ? visibleStartIndex
      : Math.min(itemCount, lowerBound(offsets, normalizedScrollOffset + viewportHeight));
  const startIndex = Math.max(0, visibleStartIndex - overscan);
  const endIndex = visibleEndIndex >= itemCount - overscan ? itemCount : visibleEndIndex + overscan;
  const offsetTop = offsets[startIndex];
  const renderedEndOffset = offsets[endIndex];
  if (offsetTop === undefined || renderedEndOffset === undefined) {
    throw new RangeError('The measured virtual layout is incomplete.');
  }

  return {
    startIndex,
    endIndex,
    visibleStartIndex,
    visibleEndIndex,
    offsetTop,
    offsetBottom: totalHeight - renderedEndOffset,
    totalHeight,
    scrollOffset: normalizedScrollOffset,
  };
}

/**
 * Preserves the leading row and its fractional progress when a responsive
 * layout changes row height. The result is also clamped for a changed viewport
 * or filtered item count.
 */
export function rebaseVirtualScrollOffset(input: VirtualScrollRebaseInput): number {
  const { itemCount, nextRowHeight, nextViewportHeight, previousRowHeight, previousScrollOffset } =
    input;

  assertSafeInteger('itemCount', itemCount);
  assertFiniteNumber('nextRowHeight', nextRowHeight);
  assertFiniteNumber('nextViewportHeight', nextViewportHeight);
  assertFiniteNumber('previousRowHeight', previousRowHeight);
  assertFiniteNumber('previousScrollOffset', previousScrollOffset);

  if (itemCount < 0) throw new RangeError('itemCount must be greater than or equal to 0.');
  if (nextRowHeight <= 0) throw new RangeError('nextRowHeight must be greater than 0.');
  if (previousRowHeight <= 0) {
    throw new RangeError('previousRowHeight must be greater than 0.');
  }
  if (nextViewportHeight < 0) {
    throw new RangeError('nextViewportHeight must be greater than or equal to 0.');
  }

  const nextTotalHeight = itemCount * nextRowHeight;
  if (!Number.isFinite(nextTotalHeight) || nextTotalHeight > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(
      'itemCount multiplied by nextRowHeight must not exceed safe pixel bounds.',
    );
  }
  const previousTotalHeight = itemCount * previousRowHeight;
  if (!Number.isFinite(previousTotalHeight) || previousTotalHeight > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(
      'itemCount multiplied by previousRowHeight must not exceed safe pixel bounds.',
    );
  }

  const normalizedPreviousOffset = Math.min(previousTotalHeight, Math.max(0, previousScrollOffset));
  const leadingRow = Math.floor(normalizedPreviousOffset / previousRowHeight);
  const progressWithinRow =
    (normalizedPreviousOffset - leadingRow * previousRowHeight) / previousRowHeight;
  const rebasedOffset = (leadingRow + progressWithinRow) * nextRowHeight;

  return clampScrollOffset(rebasedOffset, nextTotalHeight, nextViewportHeight);
}

function clampScrollOffset(
  scrollOffset: number,
  totalHeight: number,
  viewportHeight: number,
): number {
  const maximumOffset = Math.max(0, totalHeight - viewportHeight);
  return Math.min(maximumOffset, Math.max(0, scrollOffset));
}

function assertFiniteNumber(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be a finite number.`);
}

function assertSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer.`);
}

function validateMeasuredLayout(layout: MeasuredVirtualLayout): void {
  if (verifiedMeasuredLayouts.has(layout)) return;

  assertSafeInteger('layout.itemCount', layout.itemCount);
  assertFiniteNumber('layout.totalHeight', layout.totalHeight);

  if (layout.itemCount < 0) {
    throw new RangeError('layout.itemCount must be greater than or equal to 0.');
  }
  if (layout.offsets.length !== layout.itemCount + 1) {
    throw new RangeError('layout.offsets must include one offset per item and an end sentinel.');
  }
  if (layout.totalHeight < 0 || layout.totalHeight > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('layout.totalHeight must be within safe pixel bounds.');
  }

  let previousOffset = -1;
  for (const [index, offset] of layout.offsets.entries()) {
    assertFiniteNumber(`layout.offsets[${index}]`, offset);
    if (index === 0 && offset !== 0) {
      throw new RangeError('layout.offsets must start at 0.');
    }
    if (index > 0 && offset <= previousOffset) {
      throw new RangeError('layout.offsets must be strictly increasing.');
    }
    previousOffset = offset;
  }

  if (previousOffset !== layout.totalHeight) {
    throw new RangeError('The final layout offset must equal layout.totalHeight.');
  }
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;

  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const value = values[middle];
    if (value === undefined || value >= target) high = middle;
    else low = middle + 1;
  }

  return low;
}

function upperBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;

  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const value = values[middle];
    if (value === undefined || value > target) high = middle;
    else low = middle + 1;
  }

  return low;
}
