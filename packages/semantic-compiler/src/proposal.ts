import { FingerprintSchema, InputPathSchema, JsonValueSchema } from '@hi-mcp/capability-ir';
import { z } from 'zod';

const ConfidenceSchema = z.number().finite().min(0).max(1);
const NonEmptyStringListSchema = z.array(z.string().trim().min(1));

export const InputAnnotationProposalSchema = z
  .object({
    inputPath: InputPathSchema,
    title: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    examples: z.array(JsonValueSchema).optional(),
    confidence: ConfidenceSchema,
    rationale: z.string().trim().min(1),
  })
  .strict()
  .refine(
    (annotation) =>
      annotation.title !== undefined ||
      annotation.description !== undefined ||
      annotation.examples !== undefined,
    { message: 'An input annotation must propose at least one semantic improvement.' },
  );

export const RiskObservationSchema = z
  .object({
    level: z.enum(['read', 'write', 'destructive', 'unknown']),
    sideEffect: z.enum(['none', 'possible', 'definite', 'unknown']),
    idempotency: z.enum(['idempotent', 'conditional', 'non-idempotent', 'unknown']),
    requiresConfirmation: z.boolean(),
    confidence: ConfidenceSchema,
    rationale: z.string().trim().min(1),
  })
  .strict();

/**
 * Intentionally contains no execution, HTTP target, output contract, or auth fields.
 * A provider therefore cannot express endpoint/method/auth mutations as a valid proposal.
 */
export const SemanticProposalSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    capabilityId: z.string().min(1),
    baseFingerprint: FingerprintSchema,
    changes: z
      .object({
        name: z.string().trim().min(1).optional(),
        title: z.string().trim().min(1).optional(),
        description: z.string().trim().min(1).optional(),
        intent: z
          .object({
            useWhen: NonEmptyStringListSchema.optional(),
            avoidWhen: NonEmptyStringListSchema.optional(),
            examples: NonEmptyStringListSchema.optional(),
            tags: NonEmptyStringListSchema.optional(),
          })
          .strict()
          .optional(),
        inputAnnotations: z.array(InputAnnotationProposalSchema).optional(),
      })
      .strict(),
    riskObservation: RiskObservationSchema.optional(),
    confidence: ConfidenceSchema,
    rationale: NonEmptyStringListSchema,
  })
  .strict();

export type SemanticProposal = z.infer<typeof SemanticProposalSchema>;
export type InputAnnotationProposal = z.infer<typeof InputAnnotationProposalSchema>;
export type RiskObservation = z.infer<typeof RiskObservationSchema>;

export class SemanticProposalConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SemanticProposalConflictError';
  }
}

export class SemanticProposalApplicationError extends Error {
  readonly inputPath?: readonly string[];

  constructor(message: string, inputPath?: readonly string[]) {
    super(message);
    this.name = 'SemanticProposalApplicationError';
    if (inputPath !== undefined) this.inputPath = inputPath;
  }
}
