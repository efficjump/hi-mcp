import { describe, expect, it } from 'vitest';

import {
  calculateMeasuredVirtualWindow,
  calculateVirtualWindow,
  createMeasuredVirtualLayout,
  rebaseVirtualScrollOffset,
} from './virtual-window.js';

describe('calculateVirtualWindow', () => {
  it('returns a half-open visible range and symmetric overscan', () => {
    expect(
      calculateVirtualWindow({
        itemCount: 100,
        rowHeight: 50,
        viewportHeight: 200,
        scrollOffset: 500,
        overscan: 2,
      }),
    ).toEqual({
      startIndex: 8,
      endIndex: 16,
      visibleStartIndex: 10,
      visibleEndIndex: 14,
      offsetTop: 400,
      offsetBottom: 4_200,
      totalHeight: 5_000,
      scrollOffset: 500,
    });
  });

  it('trims overscan at both list boundaries', () => {
    const firstWindow = calculateVirtualWindow({
      itemCount: 20,
      rowHeight: 40,
      viewportHeight: 120,
      scrollOffset: 0,
      overscan: 4,
    });
    const lastWindow = calculateVirtualWindow({
      itemCount: 20,
      rowHeight: 40,
      viewportHeight: 120,
      scrollOffset: 680,
      overscan: 4,
    });

    expect(firstWindow).toMatchObject({
      startIndex: 0,
      endIndex: 7,
      offsetTop: 0,
      offsetBottom: 520,
    });
    expect(lastWindow).toMatchObject({
      startIndex: 13,
      endIndex: 20,
      offsetTop: 520,
      offsetBottom: 0,
    });
  });

  it('clamps a stale scroll offset after filtering shortens the result', () => {
    const window = calculateVirtualWindow({
      itemCount: 4,
      rowHeight: 48,
      viewportHeight: 96,
      scrollOffset: 4_000,
      overscan: 1,
    });

    expect(window).toMatchObject({
      startIndex: 1,
      endIndex: 4,
      visibleStartIndex: 2,
      visibleEndIndex: 4,
      offsetTop: 48,
      offsetBottom: 0,
      scrollOffset: 96,
    });
  });

  it('uses caller-provided desktop and mobile row measurements', () => {
    const desktop = calculateVirtualWindow({
      itemCount: 200,
      rowHeight: 56,
      viewportHeight: 280,
      scrollOffset: 560,
      overscan: 1,
    });
    const mobile = calculateVirtualWindow({
      itemCount: 200,
      rowHeight: 168,
      viewportHeight: 504,
      scrollOffset: 1_680,
      overscan: 1,
    });

    expect(desktop).toMatchObject({
      startIndex: 9,
      endIndex: 16,
      visibleStartIndex: 10,
      visibleEndIndex: 15,
    });
    expect(mobile).toMatchObject({
      startIndex: 9,
      endIndex: 14,
      visibleStartIndex: 10,
      visibleEndIndex: 13,
    });
  });

  it('supports fractional row measurements reported by the browser', () => {
    expect(
      calculateVirtualWindow({
        itemCount: 10,
        rowHeight: 52.5,
        viewportHeight: 105,
        scrollOffset: 52.5,
        overscan: 0,
      }),
    ).toMatchObject({
      startIndex: 1,
      endIndex: 3,
      offsetTop: 52.5,
      offsetBottom: 367.5,
      totalHeight: 525,
    });
  });

  it('recalculates the range when the viewport changes', () => {
    const compactViewport = calculateVirtualWindow({
      itemCount: 50,
      rowHeight: 60,
      viewportHeight: 180,
      scrollOffset: 600,
      overscan: 2,
    });
    const expandedViewport = calculateVirtualWindow({
      itemCount: 50,
      rowHeight: 60,
      viewportHeight: 420,
      scrollOffset: 600,
      overscan: 2,
    });

    expect(compactViewport).toMatchObject({
      startIndex: 8,
      endIndex: 15,
      visibleEndIndex: 13,
    });
    expect(expandedViewport).toMatchObject({
      startIndex: 8,
      endIndex: 19,
      visibleEndIndex: 17,
    });
  });

  it('returns an empty range for empty or not-yet-measured viewports', () => {
    expect(
      calculateVirtualWindow({
        itemCount: 0,
        rowHeight: 50,
        viewportHeight: 200,
        scrollOffset: 900,
        overscan: 2,
      }),
    ).toEqual({
      startIndex: 0,
      endIndex: 0,
      visibleStartIndex: 0,
      visibleEndIndex: 0,
      offsetTop: 0,
      offsetBottom: 0,
      totalHeight: 0,
      scrollOffset: 0,
    });

    expect(
      calculateVirtualWindow({
        itemCount: 10,
        rowHeight: 50,
        viewportHeight: 0,
        scrollOffset: 150,
        overscan: 0,
      }),
    ).toMatchObject({
      startIndex: 3,
      endIndex: 3,
      visibleStartIndex: 3,
      visibleEndIndex: 3,
    });
  });

  it('normalizes elastic negative scrolling without hiding the first rows', () => {
    expect(
      calculateVirtualWindow({
        itemCount: 10,
        rowHeight: 50,
        viewportHeight: 100,
        scrollOffset: -24,
        overscan: 1,
      }),
    ).toMatchObject({
      startIndex: 0,
      endIndex: 3,
      visibleStartIndex: 0,
      visibleEndIndex: 2,
      scrollOffset: 0,
    });
  });

  it('keeps every calculated range and spacer within list invariants', () => {
    const itemCounts = [0, 1, 7, 1_000];
    const rowHeights = [32, 47.5, 180];
    const viewportHeights = [0, 1, 240, 900];
    const scrollOffsets = [-12, 0, 31, 480, 100_000];
    const overscans = [0, 1, 12];

    for (const itemCount of itemCounts) {
      for (const rowHeight of rowHeights) {
        for (const viewportHeight of viewportHeights) {
          for (const scrollOffset of scrollOffsets) {
            for (const overscan of overscans) {
              const window = calculateVirtualWindow({
                itemCount,
                rowHeight,
                viewportHeight,
                scrollOffset,
                overscan,
              });

              expect(window.startIndex).toBeGreaterThanOrEqual(0);
              expect(window.startIndex).toBeLessThanOrEqual(window.visibleStartIndex);
              expect(window.visibleStartIndex).toBeLessThanOrEqual(window.visibleEndIndex);
              expect(window.visibleEndIndex).toBeLessThanOrEqual(window.endIndex);
              expect(window.endIndex).toBeLessThanOrEqual(itemCount);
              expect(
                window.offsetTop +
                  (window.endIndex - window.startIndex) * rowHeight +
                  window.offsetBottom,
              ).toBe(window.totalHeight);
            }
          }
        }
      }
    }
  });

  it.each([
    ['itemCount', { itemCount: -1 }],
    ['itemCount', { itemCount: 1.2 }],
    ['overscan', { overscan: -1 }],
    ['overscan', { overscan: 1.2 }],
    ['rowHeight', { rowHeight: 0 }],
    ['rowHeight', { rowHeight: Number.NaN }],
    ['viewportHeight', { viewportHeight: -1 }],
    ['scrollOffset', { scrollOffset: Number.POSITIVE_INFINITY }],
  ])('rejects an invalid %s input', (_field, override) => {
    expect(() =>
      calculateVirtualWindow({
        itemCount: 10,
        rowHeight: 50,
        viewportHeight: 100,
        scrollOffset: 0,
        overscan: 1,
        ...override,
      }),
    ).toThrow();
  });
});

describe('rebaseVirtualScrollOffset', () => {
  it('preserves the leading row and fractional position across responsive row heights', () => {
    const desktopOffset = 10 * 56 + 14;

    expect(
      rebaseVirtualScrollOffset({
        itemCount: 100,
        previousRowHeight: 56,
        nextRowHeight: 168,
        previousScrollOffset: desktopOffset,
        nextViewportHeight: 504,
      }),
    ).toBe(10 * 168 + 42);
  });

  it('clamps the rebased offset after filtering or viewport expansion', () => {
    expect(
      rebaseVirtualScrollOffset({
        itemCount: 3,
        previousRowHeight: 50,
        nextRowHeight: 100,
        previousScrollOffset: 2_000,
        nextViewportHeight: 200,
      }),
    ).toBe(100);

    expect(
      rebaseVirtualScrollOffset({
        itemCount: 3,
        previousRowHeight: 50,
        nextRowHeight: 100,
        previousScrollOffset: 100,
        nextViewportHeight: 500,
      }),
    ).toBe(0);
  });

  it('normalizes a finite but stale previous offset before rebasing', () => {
    expect(
      rebaseVirtualScrollOffset({
        itemCount: 10,
        previousRowHeight: 50,
        nextRowHeight: 100,
        previousScrollOffset: Number.MAX_VALUE,
        nextViewportHeight: 200,
      }),
    ).toBe(800);
  });

  it.each([
    { itemCount: -1 },
    { itemCount: 1.2 },
    { previousRowHeight: 0 },
    { nextRowHeight: 0 },
    { nextViewportHeight: -1 },
    { previousScrollOffset: Number.NaN },
  ])('rejects invalid dimensions: $itemCount', (override) => {
    expect(() =>
      rebaseVirtualScrollOffset({
        itemCount: 10,
        previousRowHeight: 50,
        nextRowHeight: 100,
        previousScrollOffset: 500,
        nextViewportHeight: 300,
        ...override,
      }),
    ).toThrow();
  });
});

describe('measured virtual rows', () => {
  it('creates immutable prefix offsets from content-driven row measurements', () => {
    const layout = createMeasuredVirtualLayout([80, 120.5, 64, 180]);

    expect(layout).toEqual({
      itemCount: 4,
      offsets: [0, 80, 200.5, 264.5, 444.5],
      totalHeight: 444.5,
    });
    expect(Object.isFrozen(layout)).toBe(true);
    expect(Object.isFrozen(layout.offsets)).toBe(true);
  });

  it('finds variable-height visible rows with binary-search boundary semantics', () => {
    const layout = createMeasuredVirtualLayout([80, 120, 60, 180, 90]);
    const window = calculateMeasuredVirtualWindow({
      layout,
      viewportHeight: 200,
      scrollOffset: 80,
      overscan: 1,
    });

    expect(window).toEqual({
      startIndex: 0,
      endIndex: 5,
      visibleStartIndex: 1,
      visibleEndIndex: 4,
      offsetTop: 0,
      offsetBottom: 0,
      totalHeight: 530,
      scrollOffset: 80,
    });
  });

  it('clamps filtered layouts and keeps measured spacers exact', () => {
    const layout = createMeasuredVirtualLayout([72, 140, 96]);
    const window = calculateMeasuredVirtualWindow({
      layout,
      viewportHeight: 150,
      scrollOffset: 5_000,
      overscan: 0,
    });

    expect(window).toEqual({
      startIndex: 1,
      endIndex: 3,
      visibleStartIndex: 1,
      visibleEndIndex: 3,
      offsetTop: 72,
      offsetBottom: 0,
      totalHeight: 308,
      scrollOffset: 158,
    });
  });

  it('handles empty and zero-height viewports', () => {
    expect(
      calculateMeasuredVirtualWindow({
        layout: createMeasuredVirtualLayout([]),
        viewportHeight: 200,
        scrollOffset: 500,
        overscan: 2,
      }),
    ).toMatchObject({ startIndex: 0, endIndex: 0, totalHeight: 0, scrollOffset: 0 });

    expect(
      calculateMeasuredVirtualWindow({
        layout: createMeasuredVirtualLayout([50, 100, 75]),
        viewportHeight: 0,
        scrollOffset: 50,
        overscan: 0,
      }),
    ).toMatchObject({
      startIndex: 1,
      endIndex: 1,
      visibleStartIndex: 1,
      visibleEndIndex: 1,
    });
  });

  it.each([{ rowHeights: [0] }, { rowHeights: [-1] }, { rowHeights: [40, Number.NaN] }])(
    'rejects invalid measured row heights: $rowHeights',
    ({ rowHeights }) => {
      expect(() => createMeasuredVirtualLayout(rowHeights)).toThrow();
    },
  );

  it('rejects malformed external measured layouts', () => {
    expect(() =>
      calculateMeasuredVirtualWindow({
        layout: { itemCount: 2, offsets: [0, 50], totalHeight: 50 },
        viewportHeight: 100,
        scrollOffset: 0,
        overscan: 1,
      }),
    ).toThrow(/end sentinel/);

    expect(() =>
      calculateMeasuredVirtualWindow({
        layout: { itemCount: 2, offsets: [0, 80, 60], totalHeight: 60 },
        viewportHeight: 100,
        scrollOffset: 0,
        overscan: 1,
      }),
    ).toThrow(/strictly increasing/);
  });
});
