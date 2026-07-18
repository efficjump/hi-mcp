import { describe, expect, it } from 'vitest';

import {
  createOperationSelection,
  includedOperationIds,
  isOperationIncluded,
  replaceOperationSelection,
  updateOperationSelection,
} from './operation-selection.js';

describe('sparse operation selection', () => {
  it('represents all-included and all-excluded states without copying operation IDs', () => {
    const included = createOperationSelection(10_000);
    const excluded = createOperationSelection(10_000, false);

    expect(included.selectedCount).toBe(10_000);
    expect(included.overrides.size).toBe(0);
    expect(isOperationIncluded(included, 'any-operation')).toBe(true);
    expect(excluded.selectedCount).toBe(0);
    expect(excluded.overrides.size).toBe(0);
    expect(isOperationIncluded(excluded, 'any-operation')).toBe(false);
  });

  it('tracks only values that differ from the selection default', () => {
    const initial = createOperationSelection(4);
    const excluded = updateOperationSelection(initial, ['one', 'three'], false);
    const restored = updateOperationSelection(excluded, ['one'], true);

    expect(excluded.selectedCount).toBe(2);
    expect(excluded.overrides).toEqual(
      new Map([
        ['one', false],
        ['three', false],
      ]),
    );
    expect(restored.selectedCount).toBe(3);
    expect(restored.overrides).toEqual(new Map([['three', false]]));
  });

  it('rebases full-list bulk changes instead of retaining one override per operation', () => {
    const operationIds = Array.from({ length: 10_000 }, (_, index) => `operation-${index}`);
    const excluded = updateOperationSelection(
      createOperationSelection(operationIds.length),
      operationIds,
      false,
    );
    const restored = updateOperationSelection(excluded, operationIds, true);

    expect(excluded).toEqual(createOperationSelection(operationIds.length, false));
    expect(restored).toEqual(createOperationSelection(operationIds.length, true));
  });

  it('chooses the smaller representation when an exact preset replaces selection', () => {
    const operationIds = ['one', 'two', 'three', 'four'];
    const mostlyIncluded = replaceOperationSelection(operationIds, ['one', 'two', 'four']);
    const mostlyExcluded = replaceOperationSelection(operationIds, ['three']);

    expect(mostlyIncluded.defaultIncluded).toBe(true);
    expect(mostlyIncluded.overrides).toEqual(new Map([['three', false]]));
    expect(mostlyExcluded.defaultIncluded).toBe(false);
    expect(mostlyExcluded.overrides).toEqual(new Map([['three', true]]));
    expect(includedOperationIds(mostlyIncluded, operationIds)).toEqual(['one', 'two', 'four']);
  });

  it('rejects duplicate, unknown, and count-mismatched preset data', () => {
    expect(() => replaceOperationSelection(['one'], ['one', 'one'])).toThrow(/unique/i);
    expect(() => replaceOperationSelection(['one'], ['two'])).toThrow(/unknown/i);
    expect(() =>
      updateOperationSelection(createOperationSelection(1), ['one', 'one'], false),
    ).toThrow(/duplicate/i);
    expect(() => includedOperationIds(createOperationSelection(2), ['one'])).toThrow(/count/i);
  });
});
