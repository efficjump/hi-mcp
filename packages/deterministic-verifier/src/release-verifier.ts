import {
  DiagnosticSchema,
  NormalizedApiDocumentSchema,
  ReleaseSchema,
  fingerprint,
  stableId,
  type Diagnostic,
  type NormalizedApiDocument,
  type NormalizedOperation,
  type Release,
} from '@hi-mcp/capability-ir';

import type {
  ReleaseVerificationOptions,
  ReleaseVerificationResult,
  VerifiedReleaseCapability,
} from './types.js';
import { inspectVerificationInput } from './input-safety.js';
import { verifyCapability } from './verifier.js';

interface DiagnosticInput {
  readonly code: string;
  readonly message: string;
  readonly pointer?: string;
  readonly recoverable?: boolean;
  readonly details?: Record<string, string | number | boolean | null>;
}

function escapePointerToken(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function pointer(...segments: readonly (string | number)[]): string {
  return `/${segments.map((segment) => escapePointerToken(String(segment))).join('/')}`;
}

function errorDiagnostic(input: DiagnosticInput): Diagnostic {
  return DiagnosticSchema.parse({
    code: input.code,
    severity: 'error',
    message: input.message,
    ...(input.pointer === undefined ? {} : { location: { pointer: input.pointer } }),
    related: [],
    recoverable: input.recoverable ?? false,
    ...(input.details === undefined ? {} : { details: input.details }),
  });
}

function withCapabilityLocation(
  item: Diagnostic,
  capabilityIndex: number,
  capabilityId: string,
  capabilityName: string,
): Diagnostic {
  const basePointer = pointer('capabilities', capabilityIndex);
  const nestedPointer = item.location?.pointer;
  const location = {
    ...item.location,
    pointer:
      nestedPointer === undefined || nestedPointer === ''
        ? basePointer
        : `${basePointer}${nestedPointer}`,
  };
  return DiagnosticSchema.parse({
    ...item,
    location,
    details: {
      ...item.details,
      capabilityId,
      capabilityName,
    },
  });
}

function orderDiagnostics(items: readonly Diagnostic[]): readonly Diagnostic[] {
  return [...items].sort(
    (left, right) =>
      (left.location?.pointer ?? '').localeCompare(right.location?.pointer ?? '') ||
      left.code.localeCompare(right.code) ||
      left.message.localeCompare(right.message),
  );
}

function expectedReleaseSourceKind(document: NormalizedApiDocument): string {
  return document.sourceVersion === undefined
    ? document.sourceKind
    : `${document.sourceKind}-${document.sourceVersion}`;
}

function verifySourceDocumentOperations(
  document: NormalizedApiDocument,
  documentIndex: number,
  diagnostics: Diagnostic[],
): void {
  document.operations.forEach((operation, operationIndex) => {
    const provenancePointer = pointer(
      'sourceDocuments',
      documentIndex,
      'operations',
      operationIndex,
      'provenance',
    );
    const mismatches = [
      ['sourceKind', operation.provenance.sourceKind, document.sourceKind],
      ['sourceId', operation.provenance.sourceId, document.sourceId],
      [
        'documentFingerprint',
        operation.provenance.documentFingerprint,
        document.documentFingerprint,
      ],
    ] as const;
    for (const [field, actual, expected] of mismatches) {
      if (actual === expected) continue;
      diagnostics.push(
        errorDiagnostic({
          code: 'RELEASE.SOURCE_OPERATION_PROVENANCE_MISMATCH',
          message: `Source operation ${operation.id} ${field} does not match its containing document.`,
          pointer: `${provenancePointer}/${field}`,
          details: { operationId: operation.id, field, actual, expected },
        }),
      );
    }

    const { fingerprint: declaredFingerprint, ...material } = operation;
    const actualFingerprint = fingerprint(material);
    if (declaredFingerprint !== actualFingerprint) {
      diagnostics.push(
        errorDiagnostic({
          code: 'RELEASE.SOURCE_OPERATION_FINGERPRINT_MISMATCH',
          message: `Source operation ${operation.id} fingerprint does not match its canonical content.`,
          pointer: pointer(
            'sourceDocuments',
            documentIndex,
            'operations',
            operationIndex,
            'fingerprint',
          ),
          details: { operationId: operation.id, declaredFingerprint, actualFingerprint },
        }),
      );
    }
  });
}

function parseSourceDocuments(
  inputs: readonly unknown[],
  diagnostics: Diagnostic[],
  inputLimits: ReleaseVerificationOptions['inputLimits'],
): readonly NormalizedApiDocument[] {
  return inputs.flatMap((input, index) => {
    const inputFailure = inspectVerificationInput(input, inputLimits);
    if (inputFailure !== null) {
      diagnostics.push(
        errorDiagnostic({
          code:
            inputFailure.kind === 'limit'
              ? 'RELEASE.SOURCE_INPUT_LIMIT_EXCEEDED'
              : 'RELEASE.UNSAFE_SOURCE_INPUT',
          message: inputFailure.message,
          pointer: pointer('sourceDocuments', index),
        }),
      );
      return [];
    }
    const parsed = NormalizedApiDocumentSchema.safeParse(input);
    if (parsed.success) {
      verifySourceDocumentOperations(parsed.data, index, diagnostics);
      return [parsed.data];
    }

    for (const issue of parsed.error.issues) {
      diagnostics.push(
        errorDiagnostic({
          code: 'RELEASE.INVALID_SOURCE_DOCUMENT',
          message: issue.message,
          pointer: pointer('sourceDocuments', index, ...issue.path.map(String)),
        }),
      );
    }
    return [];
  });
}

function findSourceOperation(
  capability: Release['capabilities'][number],
  document: NormalizedApiDocument,
): NormalizedOperation | undefined {
  return document.operations.find((operation) => operation.id === capability.id);
}

function findSourceOperationWithMatchingProvenance(
  capability: Release['capabilities'][number],
  document: NormalizedApiDocument,
): NormalizedOperation | undefined {
  return document.operations.find(
    (operation) =>
      operation.provenance.pointer === capability.provenance.pointer &&
      operation.provenance.sourceId === capability.provenance.sourceId,
  );
}

function matchingSourceDocument(
  capability: Release['capabilities'][number],
  sourceDocuments: readonly NormalizedApiDocument[],
): NormalizedApiDocument | undefined {
  return sourceDocuments.find(
    (document) =>
      document.sourceKind === capability.provenance.sourceKind &&
      document.sourceId === capability.provenance.sourceId &&
      document.documentFingerprint === capability.provenance.documentFingerprint,
  );
}

function verifyReleaseIdentity(release: Release, diagnostics: Diagnostic[]): void {
  const {
    id: declaredId,
    createdAt: _createdAt,
    fingerprint: declaredFingerprint,
    ...material
  } = release;
  const actualFingerprint = fingerprint(material);
  if (actualFingerprint !== declaredFingerprint) {
    diagnostics.push(
      errorDiagnostic({
        code: 'RELEASE.FINGERPRINT_MISMATCH',
        message: 'Release fingerprint does not match its canonical content.',
        pointer: '/fingerprint',
        details: { declaredFingerprint, actualFingerprint },
      }),
    );
  }

  const expectedId = stableId('release', declaredFingerprint);
  if (expectedId !== declaredId) {
    diagnostics.push(
      errorDiagnostic({
        code: 'RELEASE.ID_MISMATCH',
        message: 'Release id does not match its declared fingerprint.',
        pointer: '/id',
        details: { declaredId, expectedId },
      }),
    );
  }
}

function verifyReleaseUniqueness(release: Release, diagnostics: Diagnostic[]): void {
  const ids = new Map<string, number>();
  const names = new Map<string, number>();

  release.capabilities.forEach((capability, index) => {
    const previousId = ids.get(capability.id);
    if (previousId !== undefined) {
      diagnostics.push(
        errorDiagnostic({
          code: 'RELEASE.DUPLICATE_CAPABILITY_ID',
          message: `Capability id ${capability.id} occurs more than once.`,
          pointer: pointer('capabilities', index, 'id'),
          details: { capabilityId: capability.id, previousIndex: previousId },
        }),
      );
    } else {
      ids.set(capability.id, index);
    }

    const previousName = names.get(capability.name);
    if (previousName !== undefined) {
      diagnostics.push(
        errorDiagnostic({
          code: 'RELEASE.DUPLICATE_TOOL_NAME',
          message: `MCP tool name ${capability.name} occurs more than once.`,
          pointer: pointer('capabilities', index, 'name'),
          details: { capabilityName: capability.name, previousIndex: previousName },
        }),
      );
    } else {
      names.set(capability.name, index);
    }
  });
}

function verifyReleaseSources(
  release: Release,
  sourceDocuments: readonly NormalizedApiDocument[],
  diagnostics: Diagnostic[],
  requireCompleteGrounding: boolean,
): void {
  sourceDocuments.forEach((document, index) => {
    const identityMatches = release.sources.filter(
      (source) =>
        source.sourceId === document.sourceId &&
        source.fingerprint === document.documentFingerprint,
    );
    if (identityMatches.length === 0) {
      diagnostics.push(
        errorDiagnostic({
          code: 'RELEASE.SOURCE_FINGERPRINT_MISMATCH',
          message: `Source document ${document.sourceId} is not recorded by this release.`,
          pointer: pointer('sourceDocuments', index, 'documentFingerprint'),
          details: {
            sourceId: document.sourceId,
            documentFingerprint: document.documentFingerprint,
          },
        }),
      );
      return;
    }

    const expectedKind = expectedReleaseSourceKind(document);
    if (!identityMatches.some((source) => source.sourceKind === expectedKind)) {
      diagnostics.push(
        errorDiagnostic({
          code: 'RELEASE.SOURCE_KIND_MISMATCH',
          message: `Source document ${document.sourceId} kind/version is not recorded by this release.`,
          pointer: pointer('sourceDocuments', index, 'sourceKind'),
          details: {
            sourceId: document.sourceId,
            expectedSourceKind: expectedKind,
            recordedSourceKinds: identityMatches.map(({ sourceKind }) => sourceKind).join(','),
          },
        }),
      );
    }
  });

  if (requireCompleteGrounding) {
    release.sources.forEach((source, index) => {
      const supplied = sourceDocuments.some(
        (document) =>
          document.sourceId === source.sourceId &&
          document.documentFingerprint === source.fingerprint &&
          expectedReleaseSourceKind(document) === source.sourceKind,
      );
      if (!supplied) {
        diagnostics.push(
          errorDiagnostic({
            code: 'RELEASE.SOURCE_DOCUMENT_MISSING',
            message: `Source-grounded verification requires document ${source.sourceId}.`,
            pointer: pointer('sources', index),
            details: { sourceId: source.sourceId, fingerprint: source.fingerprint },
          }),
        );
      }
    });
  }

  release.capabilities.forEach((capability, index) => {
    const provenanceRecorded = release.sources.some(
      (source) =>
        source.sourceId === capability.provenance.sourceId &&
        source.fingerprint === capability.provenance.documentFingerprint,
    );
    if (!provenanceRecorded) {
      diagnostics.push(
        errorDiagnostic({
          code: 'RELEASE.UNRECORDED_CAPABILITY_SOURCE',
          message: `Capability ${capability.id} provenance is not recorded in release sources.`,
          pointer: pointer('capabilities', index, 'provenance'),
          details: {
            capabilityId: capability.id,
            sourceId: capability.provenance.sourceId,
            documentFingerprint: capability.provenance.documentFingerprint,
          },
        }),
      );
    }

    if (requireCompleteGrounding) {
      const sourceDocument = sourceDocuments.find(
        (document) =>
          document.sourceId === capability.provenance.sourceId &&
          document.documentFingerprint === capability.provenance.documentFingerprint,
      );
      if (
        sourceDocument !== undefined &&
        sourceDocument.sourceKind !== capability.provenance.sourceKind
      ) {
        diagnostics.push(
          errorDiagnostic({
            code: 'RELEASE.CAPABILITY_SOURCE_KIND_MISMATCH',
            message: `Capability ${capability.id} source kind does not match its supplied source document.`,
            pointer: pointer('capabilities', index, 'provenance', 'sourceKind'),
            details: {
              capabilityId: capability.id,
              actualSourceKind: capability.provenance.sourceKind,
              expectedSourceKind: sourceDocument.sourceKind,
            },
          }),
        );
      }
    }
  });
}

/**
 * Verifies the complete release envelope before any capability can be exposed or executed.
 * Content-addressed identity checks detect stale or modified release material; optional normalized
 * source documents additionally ground immutable HTTP/auth contracts against source operations.
 */
export function verifyRelease(
  input: unknown,
  options: ReleaseVerificationOptions = {},
): ReleaseVerificationResult {
  const inputFailure = inspectVerificationInput(input, options.inputLimits);
  if (inputFailure !== null) {
    const diagnostics = [
      errorDiagnostic({
        code:
          inputFailure.kind === 'limit' ? 'RELEASE.INPUT_LIMIT_EXCEEDED' : 'RELEASE.UNSAFE_INPUT',
        message: inputFailure.message,
        pointer: '/',
      }),
    ];
    return {
      valid: false,
      capabilities: [],
      diagnostics,
      errors: diagnostics,
      warnings: [],
    };
  }

  const parsed = ReleaseSchema.safeParse(input);
  if (!parsed.success) {
    const diagnostics = parsed.error.issues.map((issue) =>
      errorDiagnostic({
        code: 'RELEASE.INVALID_SCHEMA',
        message: issue.message,
        pointer: pointer(...issue.path.map(String)),
      }),
    );
    return {
      valid: false,
      capabilities: [],
      diagnostics,
      errors: diagnostics,
      warnings: [],
    };
  }

  const release = parsed.data;
  const diagnostics: Diagnostic[] = [];
  const sourceDocuments = parseSourceDocuments(
    options.sourceDocuments ?? [],
    diagnostics,
    options.inputLimits,
  );

  verifyReleaseIdentity(release, diagnostics);
  verifyReleaseUniqueness(release, diagnostics);
  verifyReleaseSources(
    release,
    sourceDocuments,
    diagnostics,
    options.sourceDocuments !== undefined,
  );

  if (release.diagnostics.some((item) => item.severity === 'error')) {
    diagnostics.push(
      errorDiagnostic({
        code: 'RELEASE.CONTAINS_ERROR_DIAGNOSTICS',
        message: 'Release embeds one or more error diagnostics.',
        pointer: '/diagnostics',
      }),
    );
  }

  const capabilityResults: VerifiedReleaseCapability[] = release.capabilities.map(
    (capability, index) => {
      const sourceDocument = matchingSourceDocument(capability, sourceDocuments);
      const sourceOperation =
        sourceDocument === undefined ? undefined : findSourceOperation(capability, sourceDocument);
      if (sourceDocument !== undefined && sourceOperation === undefined) {
        const provenanceMatch = findSourceOperationWithMatchingProvenance(
          capability,
          sourceDocument,
        );
        diagnostics.push(
          errorDiagnostic({
            code:
              provenanceMatch === undefined
                ? 'RELEASE.SOURCE_OPERATION_MISSING'
                : 'RELEASE.SOURCE_OPERATION_ID_MISMATCH',
            message:
              provenanceMatch === undefined
                ? `No source operation matches capability ${capability.id}.`
                : `Capability ${capability.id} provenance belongs to source operation ${provenanceMatch.id}.`,
            pointer: pointer('capabilities', index, 'id'),
            details: {
              capabilityId: capability.id,
              sourceId: capability.provenance.sourceId,
              ...(provenanceMatch === undefined ? {} : { sourceOperationId: provenanceMatch.id }),
            },
          }),
        );
      }

      const result = verifyCapability(capability, {
        ...(sourceOperation === undefined ? {} : { sourceOperation }),
        ...(options.ajv === undefined ? {} : { ajv: options.ajv }),
        ...(options.schemaLimits === undefined ? {} : { schemaLimits: options.schemaLimits }),
        ...(options.inputLimits === undefined ? {} : { inputLimits: options.inputLimits }),
      });
      diagnostics.push(
        ...result.diagnostics.map((item) =>
          withCapabilityLocation(item, index, capability.id, capability.name),
        ),
      );
      return { index, id: capability.id, name: capability.name, result };
    },
  );

  const ordered = orderDiagnostics(diagnostics);
  const errors = ordered.filter((item) => item.severity === 'error');
  const warnings = ordered.filter((item) => item.severity === 'warning');
  return {
    valid: errors.length === 0,
    release,
    capabilities: capabilityResults,
    diagnostics: ordered,
    errors,
    warnings,
  };
}
