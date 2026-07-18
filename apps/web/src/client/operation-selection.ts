export interface OperationSelection {
  readonly defaultIncluded: boolean;
  readonly overrides: ReadonlyMap<string, boolean>;
  readonly selectedCount: number;
  readonly operationCount: number;
}

export function createOperationSelection(
  operationCount: number,
  included = true,
): OperationSelection {
  if (!Number.isSafeInteger(operationCount) || operationCount < 0) {
    throw new TypeError('Operation count must be a non-negative safe integer.');
  }
  return {
    defaultIncluded: included,
    overrides: new Map(),
    selectedCount: included ? operationCount : 0,
    operationCount,
  };
}

export function isOperationIncluded(selection: OperationSelection, operationId: string): boolean {
  return selection.overrides.get(operationId) ?? selection.defaultIncluded;
}

export function updateOperationSelection(
  selection: OperationSelection,
  operationIds: readonly string[],
  included: boolean,
): OperationSelection {
  if (operationIds.length === 0) return selection;
  const uniqueIds = new Set(operationIds);
  if (uniqueIds.size !== operationIds.length) {
    throw new TypeError('Operation selection updates cannot contain duplicate IDs.');
  }
  if (operationIds.length === selection.operationCount) {
    return createOperationSelection(selection.operationCount, included);
  }

  const overrides = new Map(selection.overrides);
  let selectedCount = selection.selectedCount;
  for (const operationId of operationIds) {
    const current = overrides.get(operationId) ?? selection.defaultIncluded;
    if (current === included) continue;
    selectedCount += included ? 1 : -1;
    if (included === selection.defaultIncluded) overrides.delete(operationId);
    else overrides.set(operationId, included);
  }
  if (selectedCount < 0 || selectedCount > selection.operationCount) {
    throw new TypeError('Operation selection update is outside the analyzed operation set.');
  }
  return { ...selection, overrides, selectedCount };
}

export function replaceOperationSelection(
  operationIds: readonly string[],
  includedOperationIds: readonly string[],
): OperationSelection {
  const knownIds = new Set(operationIds);
  if (knownIds.size !== operationIds.length) {
    throw new TypeError('Analyzed operation IDs must be unique.');
  }
  const includedIds = new Set(includedOperationIds);
  if (includedIds.size !== includedOperationIds.length) {
    throw new TypeError('Included operation IDs must be unique.');
  }
  for (const operationId of includedIds) {
    if (!knownIds.has(operationId)) {
      throw new TypeError(`Unknown operation ID: ${operationId}`);
    }
  }

  const defaultIncluded = includedIds.size > operationIds.length / 2;
  const overrides = new Map<string, boolean>();
  for (const operationId of operationIds) {
    const included = includedIds.has(operationId);
    if (included !== defaultIncluded) overrides.set(operationId, included);
  }
  return {
    defaultIncluded,
    overrides,
    selectedCount: includedIds.size,
    operationCount: operationIds.length,
  };
}

export function includedOperationIds(
  selection: OperationSelection,
  operationIds: readonly string[],
): readonly string[] {
  if (operationIds.length !== selection.operationCount) {
    throw new TypeError('Analyzed operation count does not match selection state.');
  }
  return operationIds.filter((operationId) => isOperationIncluded(selection, operationId));
}
