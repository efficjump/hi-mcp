import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
} from 'react';

import type { OperationSummary } from '../shared/contracts.js';
import { isOperationIncluded, type OperationSelection } from './operation-selection.js';
import {
  calculateMeasuredVirtualWindow,
  createMeasuredVirtualLayout,
  type MeasuredVirtualLayout,
  type VirtualWindow,
} from './virtual-window.js';

export interface OperationExplorerProps {
  readonly operations: readonly OperationSummary[];
  readonly selection: OperationSelection;
  readonly onToggle: (operationId: string, included: boolean) => void;
  readonly disabled?: boolean;
  readonly label?: string;
  readonly emptyMessage?: string;
}

interface LayoutSnapshot {
  readonly layout: MeasuredVirtualLayout;
  readonly operations: readonly OperationSummary[];
}

interface OperationRowProps {
  readonly disabled: boolean;
  readonly included: boolean;
  readonly index: number;
  readonly isRovingTarget: boolean;
  readonly operation: OperationSummary;
  readonly style?: CSSProperties;
  readonly onCheckboxRef: (operationId: string, node: HTMLInputElement | null) => void;
  readonly onFocus: (operationId: string) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLInputElement>, index: number) => void;
  readonly onRowRef: (operationId: string, node: HTMLDivElement | null) => void;
  readonly onToggle: (operationId: string, included: boolean) => void;
}

const DEFAULT_LABEL = '정규화된 operation 표, 스크롤할 수 있습니다';
const DEFAULT_EMPTY_MESSAGE = '현재 필터와 일치하는 operation이 없습니다.';

function measuredBlockSize(entry: ResizeObserverEntry): number {
  const borderBoxSize = entry.borderBoxSize as
    ResizeObserverSize | readonly ResizeObserverSize[] | undefined;
  const firstBorderBox = Array.isArray(borderBoxSize) ? borderBoxSize[0] : borderBoxSize;
  const blockSize = firstBorderBox?.blockSize ?? entry.target.getBoundingClientRect().height;
  return Number.isFinite(blockSize) && blockSize > 0 ? blockSize : 0;
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const upper = ordered[middle];
  if (upper === undefined) return undefined;
  if (ordered.length % 2 === 1) return upper;
  const lower = ordered[middle - 1];
  return lower === undefined ? upper : (lower + upper) / 2;
}

function operationTitle(operation: OperationSummary): string {
  return operation.summary ?? operation.operationId ?? operation.id;
}

function methodClassName(method: string): string {
  const normalized = method.toLocaleLowerCase('en-US').replace(/[^a-z0-9_-]/g, '-');
  return `method-badge method-${normalized}`;
}

function OperationRow({
  disabled,
  included,
  index,
  isRovingTarget,
  operation,
  style,
  onCheckboxRef,
  onFocus,
  onKeyDown,
  onRowRef,
  onToggle,
}: OperationRowProps) {
  const title = operationTitle(operation);
  const rowRef = useCallback(
    (node: HTMLDivElement | null) => onRowRef(operation.id, node),
    [onRowRef, operation.id],
  );
  const checkboxRef = useCallback(
    (node: HTMLInputElement | null) => onCheckboxRef(operation.id, node),
    [onCheckboxRef, operation.id],
  );

  return (
    <div
      ref={rowRef}
      className={`operation-explorer-row ${included ? 'operation-included' : 'operation-excluded'}`}
      role="row"
      aria-rowindex={index + 2}
      data-operation-index={index}
      style={style}
    >
      <div className="operation-explorer-cell operation-explorer-selection-cell" role="cell">
        <label className="operation-toggle">
          <input
            ref={checkboxRef}
            type="checkbox"
            checked={included}
            tabIndex={disabled || !isRovingTarget ? -1 : 0}
            aria-label={`operation ID ${operation.id} · ${title} ${operation.method} ${operation.path} MCP 도구 포함`}
            disabled={disabled}
            onChange={(event) => onToggle(operation.id, event.target.checked)}
            onFocus={() => onFocus(operation.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
          />
        </label>
      </div>
      <div className="operation-explorer-cell operation-explorer-operation-cell" role="cell">
        <strong>{title}</strong>
        <small>{operation.description ?? operation.id}</small>
      </div>
      <div className="operation-explorer-cell operation-explorer-request-cell" role="cell">
        <div className="request-cell">
          <span className={methodClassName(operation.method)}>{operation.method}</span>
          <code>{operation.path}</code>
        </div>
      </div>
      <div className="operation-explorer-cell operation-explorer-auth-cell" role="cell">
        <span>
          {operation.authRequired ? operation.authSchemes.join(', ') || 'required' : '없음'}
        </span>
      </div>
    </div>
  );
}

function useMeasuredElementHeight(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  onUnavailable: () => void,
): number | undefined {
  const [height, setHeight] = useState<number>();

  useLayoutEffect(() => {
    if (!enabled) return undefined;
    const element = ref.current;
    if (!element) return undefined;

    const update = (nextHeight: number) => {
      if (!Number.isFinite(nextHeight) || nextHeight <= 0) return;
      setHeight((current) => (current === nextHeight ? current : nextHeight));
    };

    update(element.getBoundingClientRect().height);
    try {
      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry) update(measuredBlockSize(entry));
      });
      observer.observe(element);
      return () => observer.disconnect();
    } catch {
      onUnavailable();
      return undefined;
    }
  }, [enabled, onUnavailable, ref]);

  return height;
}

function range(start: number, end: number): number[] {
  return Array.from({ length: Math.max(0, end - start) }, (_, offset) => start + offset);
}

export function OperationExplorer({
  operations,
  selection,
  onToggle,
  disabled = false,
  label = DEFAULT_LABEL,
  emptyMessage = DEFAULT_EMPTY_MESSAGE,
}: OperationExplorerProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const rowNodes = useRef(new Map<string, HTMLDivElement>());
  const rowIds = useRef(new WeakMap<Element, string>());
  const rowObserver = useRef<ResizeObserver | undefined>(undefined);
  const checkboxNodes = useRef(new Map<string, HTMLInputElement>());
  const previousLayout = useRef<LayoutSnapshot | undefined>(undefined);
  const [observerUnavailable, setObserverUnavailable] = useState(false);
  const [measuredHeights, setMeasuredHeights] = useState<ReadonlyMap<string, number>>(new Map());
  const [scrollOffset, setScrollOffset] = useState(0);
  const [rovingOperationId, setRovingOperationId] = useState<string>();
  const [pendingFocusId, setPendingFocusId] = useState<string>();

  const resizeObserverAvailable = typeof ResizeObserver !== 'undefined' && !observerUnavailable;
  const markObserverUnavailable = useCallback(() => setObserverUnavailable(true), []);
  const viewportHeight = useMeasuredElementHeight(
    viewportRef,
    resizeObserverAvailable,
    markObserverUnavailable,
  );
  const headerHeight = useMeasuredElementHeight(
    headerRef,
    resizeObserverAvailable,
    markObserverUnavailable,
  );

  const operationIndex = useMemo(() => {
    const indexes = new Map<string, number>();
    for (const [index, operation] of operations.entries()) {
      if (indexes.has(operation.id)) {
        throw new TypeError(`OperationExplorer requires unique operation IDs: ${operation.id}`);
      }
      indexes.set(operation.id, index);
    }
    return indexes;
  }, [operations]);

  const effectiveRovingId =
    rovingOperationId && operationIndex.has(rovingOperationId)
      ? rovingOperationId
      : operations[0]?.id;
  const rovingIndex =
    effectiveRovingId === undefined ? undefined : operationIndex.get(effectiveRovingId);

  const updateMeasuredHeights = useCallback(
    (updates: readonly Readonly<{ operationId: string; height: number }>[]) => {
      if (updates.length === 0) return;
      setMeasuredHeights((current) => {
        let next: Map<string, number> | undefined;
        for (const { operationId, height } of updates) {
          if (!Number.isFinite(height) || height <= 0) continue;
          const previous = current.get(operationId);
          if (previous !== undefined && Math.abs(previous - height) < 0.5) continue;
          next ??= new Map(current);
          next.set(operationId, height);
        }
        return next ?? current;
      });
    },
    [],
  );

  const registerRow = useCallback(
    (operationId: string, node: HTMLDivElement | null) => {
      const current = rowNodes.current.get(operationId);
      if (current && current !== node) {
        rowObserver.current?.unobserve(current);
        rowNodes.current.delete(operationId);
      }
      if (!node) return;

      rowNodes.current.set(operationId, node);
      rowIds.current.set(node, operationId);
      rowObserver.current?.observe(node);
      const height = node.getBoundingClientRect().height;
      if (height > 0) updateMeasuredHeights([{ operationId, height }]);
    },
    [updateMeasuredHeights],
  );

  const registerCheckbox = useCallback((operationId: string, node: HTMLInputElement | null) => {
    if (node) checkboxNodes.current.set(operationId, node);
    else checkboxNodes.current.delete(operationId);
  }, []);

  useLayoutEffect(() => {
    if (!resizeObserverAvailable) return undefined;
    try {
      const observer = new ResizeObserver((entries) => {
        const updates = entries.flatMap((entry) => {
          const operationId = rowIds.current.get(entry.target);
          if (!operationId) return [];
          const height = measuredBlockSize(entry);
          return height > 0 ? [{ operationId, height }] : [];
        });
        updateMeasuredHeights(updates);
      });
      rowObserver.current = observer;
      for (const node of rowNodes.current.values()) observer.observe(node);
      return () => {
        observer.disconnect();
        if (rowObserver.current === observer) rowObserver.current = undefined;
      };
    } catch {
      markObserverUnavailable();
      return undefined;
    }
  }, [markObserverUnavailable, resizeObserverAvailable, updateMeasuredHeights]);

  const estimatedHeight = useMemo(
    () =>
      median(
        operations.flatMap((operation) => {
          const height = measuredHeights.get(operation.id);
          return height === undefined ? [] : [height];
        }),
      ),
    [measuredHeights, operations],
  );

  const layout = useMemo(() => {
    if (!resizeObserverAvailable || operations.length === 0) return undefined;
    if (estimatedHeight === undefined) return undefined;
    return createMeasuredVirtualLayout(
      operations.map((operation) => measuredHeights.get(operation.id) ?? estimatedHeight),
    );
  }, [estimatedHeight, measuredHeights, operations, resizeObserverAvailable]);

  const usableViewportHeight =
    viewportHeight === undefined || headerHeight === undefined
      ? undefined
      : Math.max(0, viewportHeight - headerHeight);
  const virtualWindow = useMemo<VirtualWindow | undefined>(() => {
    if (!layout || usableViewportHeight === undefined || estimatedHeight === undefined) {
      return undefined;
    }
    const overscan = Math.ceil(usableViewportHeight / estimatedHeight);
    return calculateMeasuredVirtualWindow({
      layout,
      overscan,
      scrollOffset,
      viewportHeight: usableViewportHeight,
    });
  }, [estimatedHeight, layout, scrollOffset, usableViewportHeight]);

  useLayoutEffect(() => {
    if (!layout || usableViewportHeight === undefined) {
      previousLayout.current = undefined;
      return;
    }

    const previous = previousLayout.current;
    previousLayout.current = { layout, operations };
    if (!previous || previous.operations !== operations || previous.layout === layout) return;

    const previousVisibleWindow = calculateMeasuredVirtualWindow({
      layout: previous.layout,
      overscan: 0,
      scrollOffset,
      viewportHeight: usableViewportHeight,
    });
    const anchorIndex = previousVisibleWindow.visibleStartIndex;
    const previousAnchor = previous.layout.offsets[anchorIndex];
    const nextAnchor = layout.offsets[anchorIndex];
    if (previousAnchor === undefined || nextAnchor === undefined) return;

    const delta = nextAnchor - previousAnchor;
    if (Math.abs(delta) < 0.5) return;
    const maxOffset = Math.max(0, layout.totalHeight - usableViewportHeight);
    const nextOffset = Math.min(maxOffset, Math.max(0, scrollOffset + delta));
    if (viewportRef.current) viewportRef.current.scrollTop = nextOffset;
    setScrollOffset(nextOffset);
  }, [layout, operations, scrollOffset, usableViewportHeight]);

  const renderedIndexes = useMemo(() => {
    if (operations.length === 0) return [];
    if (!resizeObserverAvailable) return range(0, operations.length);
    if (!layout || !virtualWindow) return [0];

    const indexes = range(virtualWindow.startIndex, virtualWindow.endIndex);
    if (rovingIndex !== undefined && !indexes.includes(rovingIndex)) indexes.push(rovingIndex);
    return indexes.sort((left, right) => left - right);
  }, [layout, operations.length, resizeObserverAvailable, rovingIndex, virtualWindow]);

  const scrollToIndex = useCallback(
    (index: number) => {
      if (!layout || usableViewportHeight === undefined) return;
      const start = layout.offsets[index];
      const end = layout.offsets[index + 1];
      if (start === undefined || end === undefined) return;
      const visibleEnd = scrollOffset + usableViewportHeight;
      const nextOffset =
        start < scrollOffset
          ? start
          : end > visibleEnd
            ? Math.max(0, end - usableViewportHeight)
            : scrollOffset;
      if (nextOffset === scrollOffset) return;
      if (viewportRef.current) viewportRef.current.scrollTop = nextOffset;
      setScrollOffset(nextOffset);
    },
    [layout, scrollOffset, usableViewportHeight],
  );

  const moveFocus = useCallback(
    (index: number) => {
      const operationId = operations[index]?.id;
      if (!operationId) return;
      setRovingOperationId(operationId);
      setPendingFocusId(operationId);
      scrollToIndex(index);
    },
    [operations, scrollToIndex],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>, index: number) => {
      if (disabled || operations.length === 0) return;
      const visibleItemCount = virtualWindow
        ? Math.max(1, virtualWindow.visibleEndIndex - virtualWindow.visibleStartIndex)
        : Math.max(1, renderedIndexes.length);
      let nextIndex: number | undefined;

      switch (event.key) {
        case 'ArrowDown':
          nextIndex = Math.min(operations.length - 1, index + 1);
          break;
        case 'ArrowUp':
          nextIndex = Math.max(0, index - 1);
          break;
        case 'Home':
          nextIndex = 0;
          break;
        case 'End':
          nextIndex = operations.length - 1;
          break;
        case 'PageDown':
          nextIndex = Math.min(operations.length - 1, index + visibleItemCount);
          break;
        case 'PageUp':
          nextIndex = Math.max(0, index - visibleItemCount);
          break;
        default:
          return;
      }

      event.preventDefault();
      moveFocus(nextIndex);
    },
    [disabled, moveFocus, operations.length, renderedIndexes.length, virtualWindow],
  );

  useLayoutEffect(() => {
    if (!pendingFocusId) return;
    const checkbox = checkboxNodes.current.get(pendingFocusId);
    if (!checkbox) return;
    checkbox.focus();
    setPendingFocusId(undefined);
  }, [pendingFocusId, renderedIndexes]);

  const bodyStyle: CSSProperties | undefined = layout
    ? { height: layout.totalHeight, position: 'relative' }
    : undefined;

  return (
    <div
      ref={viewportRef}
      className={`operation-explorer-viewport ${resizeObserverAvailable ? 'operation-explorer-virtual' : 'operation-explorer-fallback'}`}
      role="region"
      aria-label={label}
      tabIndex={0}
      onScroll={(event) => setScrollOffset(event.currentTarget.scrollTop)}
    >
      <div
        className="operation-explorer-table"
        role="table"
        aria-colcount={4}
        aria-rowcount={operations.length === 0 ? 2 : operations.length + 1}
        aria-busy={resizeObserverAvailable && operations.length > 0 && !layout ? true : undefined}
      >
        <div ref={headerRef} className="operation-explorer-header" role="rowgroup">
          <div className="operation-explorer-header-row" role="row" aria-rowindex={1}>
            <div className="operation-explorer-header-cell" role="columnheader">
              포함
            </div>
            <div className="operation-explorer-header-cell" role="columnheader">
              Operation
            </div>
            <div className="operation-explorer-header-cell" role="columnheader">
              Request
            </div>
            <div className="operation-explorer-header-cell" role="columnheader">
              Authentication
            </div>
          </div>
        </div>
        <div className="operation-explorer-body" role="rowgroup" style={bodyStyle}>
          {renderedIndexes.map((index) => {
            const operation = operations[index];
            if (!operation) return null;
            const offset = layout?.offsets[index];
            const style: CSSProperties | undefined =
              layout && offset !== undefined
                ? {
                    position: 'absolute',
                    insetInline: 0,
                    top: 0,
                    transform: `translateY(${offset}px)`,
                  }
                : undefined;
            return (
              <OperationRow
                key={operation.id}
                operation={operation}
                index={index}
                included={isOperationIncluded(selection, operation.id)}
                disabled={disabled}
                isRovingTarget={operation.id === effectiveRovingId}
                {...(style === undefined ? {} : { style })}
                onCheckboxRef={registerCheckbox}
                onFocus={setRovingOperationId}
                onKeyDown={handleKeyDown}
                onRowRef={registerRow}
                onToggle={onToggle}
              />
            );
          })}
          {operations.length === 0 ? (
            <div className="operation-explorer-empty-row" role="row" aria-rowindex={2}>
              <div role="cell" aria-colspan={4}>
                {emptyMessage}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
