// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OperationSummary } from '../shared/contracts.js';
import { OperationExplorer } from './OperationExplorer.js';
import { createOperationSelection } from './operation-selection.js';

function operation(index: number): OperationSummary {
  return {
    id: `operation-${index}`,
    operationId: `operation${index}`,
    method: index % 2 === 0 ? 'GET' : 'POST',
    path: `/resources/${index}`,
    summary: `Operation ${index}`,
    ...(index % 3 === 0 ? { description: `Description for operation ${index}` } : {}),
    tags: [`tag-${index % 5}`],
    authRequired: index % 2 === 1,
    authSchemes: index % 2 === 1 ? ['api-key'] : [],
  };
}

function operations(count: number): readonly OperationSummary[] {
  return Array.from({ length: count }, (_, index) => operation(index));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('OperationExplorer', () => {
  it('renders every small-list row without ResizeObserver and toggles by stable operation ID', async () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const source = operations(3);
    const onToggle = vi.fn();
    const user = userEvent.setup();

    render(
      <OperationExplorer
        operations={source}
        selection={createOperationSelection(source.length)}
        onToggle={onToggle}
      />,
    );

    const table = screen.getByRole('table');
    expect(table.getAttribute('aria-rowcount')).toBe('4');
    expect(screen.getAllByRole('row')).toHaveLength(4);
    const target = screen.getByRole('checkbox', {
      name: /operation ID operation-1 · Operation 1 POST \/resources\/1 MCP 도구 포함/,
    });
    expect((target as HTMLInputElement).checked).toBe(true);

    await user.click(target);

    expect(onToggle).toHaveBeenCalledWith('operation-1', false);
  });

  it('supports arrow, boundary, and page keyboard navigation with one roving tab stop', async () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const source = operations(6);
    const user = userEvent.setup();

    render(
      <OperationExplorer
        operations={source}
        selection={createOperationSelection(source.length)}
        onToggle={vi.fn()}
      />,
    );

    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes.map(({ tabIndex }) => tabIndex)).toEqual([0, -1, -1, -1, -1, -1]);

    checkboxes[0]?.focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(checkboxes[1]);

    await user.keyboard('{End}');
    expect(document.activeElement).toBe(checkboxes[5]);

    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(checkboxes[0]);

    await user.keyboard('{PageDown}');
    expect(document.activeElement).toBe(checkboxes[5]);

    await user.keyboard('{PageUp}');
    expect(document.activeElement).toBe(checkboxes[0]);

    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(checkboxes[0]);
    expect(screen.getAllByRole('checkbox').filter(({ tabIndex }) => tabIndex === 0)).toHaveLength(
      1,
    );
  });

  it('keeps a large variable-height collection bounded and exposes virtual row positions', async () => {
    class TestResizeObserver implements ResizeObserver {
      readonly callback: ResizeObserverCallback;

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }

      observe = (target: Element) => {
        const element = target as HTMLElement;
        const operationIndex = Number(element.dataset['operationIndex']);
        const height = element.classList.contains('operation-explorer-viewport')
          ? 420
          : element.classList.contains('operation-explorer-header')
            ? 48
            : 56 + (Number.isFinite(operationIndex) ? operationIndex % 4 : 0) * 12;
        queueMicrotask(() => {
          this.callback(
            [
              {
                target,
                contentRect: { height },
                borderBoxSize: [{ blockSize: height, inlineSize: 800 }],
              } as unknown as ResizeObserverEntry,
            ],
            this,
          );
        });
      };

      unobserve = vi.fn();
      disconnect = vi.fn();
    }

    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    const source = operations(5_000);
    const user = userEvent.setup();

    render(
      <OperationExplorer
        operations={source}
        selection={createOperationSelection(source.length)}
        onToggle={vi.fn()}
      />,
    );

    const table = screen.getByRole('table');
    expect(table.getAttribute('aria-rowcount')).toBe('5001');
    await waitFor(() => {
      const rendered = screen.getAllByRole('checkbox');
      expect(rendered.length).toBeGreaterThan(1);
      expect(rendered.length).toBeLessThan(50);
    });

    const viewport = screen.getByRole('region', { name: /정규화된 operation 표/ });
    viewport.scrollTop = 32_000;
    fireEvent.scroll(viewport);
    await waitFor(() => {
      const indexes = screen
        .getAllByRole('row')
        .map((row) => Number(row.getAttribute('aria-rowindex')))
        .filter((index) => index > 1);
      expect(Math.max(...indexes)).toBeGreaterThan(100);
    });

    const visibleCheckbox = screen.getAllByRole('checkbox')[0];
    visibleCheckbox?.focus();
    await user.keyboard('{End}');
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole('checkbox', {
          name: /operation ID operation-4999 · Operation 4999 POST \/resources\/4999/,
        }),
      );
    });
    expect(screen.getAllByRole('checkbox').length).toBeLessThan(50);
  });

  it('renders an accessible empty row', () => {
    vi.stubGlobal('ResizeObserver', undefined);

    render(
      <OperationExplorer
        operations={[]}
        selection={createOperationSelection(0)}
        onToggle={vi.fn()}
      />,
    );

    expect(screen.getByRole('table').getAttribute('aria-rowcount')).toBe('2');
    expect(
      screen
        .getByRole('cell', { name: '현재 필터와 일치하는 operation이 없습니다.' })
        .getAttribute('aria-colspan'),
    ).toBe('4');
  });
});
