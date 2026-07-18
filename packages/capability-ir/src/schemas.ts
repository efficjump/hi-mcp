import { z } from 'zod';

import { validateHttpOperationPath } from './http-path.js';
import {
  isHttpFieldName,
  isTransportControlledCredentialHeader,
  isWellFormedUnicode,
} from './wire-text.js';

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = boolean | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const JsonSchemaSchema: z.ZodType<JsonSchema> = z.union([
  z.boolean(),
  z.record(z.string(), JsonValueSchema),
]);

/** Canonical SHA-256 content fingerprint used at every persisted IR boundary. */
export const FingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const WellFormedUnicodeStringSchema = z.string().refine(isWellFormedUnicode, {
  message: 'Text cannot contain unpaired Unicode surrogates.',
});
const HTTP_TOKEN_PATTERN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const HTTP_QUOTED_STRING_PATTERN =
  '"(?:[\\t !#-\\[\\]-~\\u0080-\\u00ff]|\\\\[\\t !-~\\u0080-\\u00ff])*"';
const HTTP_MEDIA_TYPE_PATTERN = new RegExp(
  `^${HTTP_TOKEN_PATTERN}\/${HTTP_TOKEN_PATTERN}(?:[\\t ]*;[\\t ]*${HTTP_TOKEN_PATTERN}[\\t ]*=[\\t ]*(?:${HTTP_TOKEN_PATTERN}|${HTTP_QUOTED_STRING_PATTERN}))*[\\t ]*$`,
);

/** JSON Schema pattern for canonical RFC 4648 base64 with required padding and zero pad bits. */
export const CANONICAL_PADDED_BASE64_PATTERN =
  '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$(?![\\s\\S])';

const CANONICAL_PADDED_BASE64_REGEXP = new RegExp(CANONICAL_PADDED_BASE64_PATTERN);

/** Runtime predicate paired exactly with CANONICAL_PADDED_BASE64_PATTERN. */
export function isCanonicalPaddedBase64(value: string): boolean {
  if (!CANONICAL_PADDED_BASE64_REGEXP.test(value)) return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
}

export const InputPathSegmentSchema = z
  .string()
  .min(1)
  .refine((segment) => !UNSAFE_OBJECT_KEYS.has(segment), {
    message: 'Input paths cannot contain prototype-sensitive object keys.',
  });

export const InputPathSchema = z.array(InputPathSegmentSchema).min(1);

/** RFC-style HTTP media type or media range, with syntactically valid parameters. */
export const HttpMediaTypeSchema = z
  .string()
  .min(1)
  .regex(HTTP_MEDIA_TYPE_PATTERN, 'Invalid HTTP media type.');

/** A canonical URL-path component that cannot be reinterpreted across WHATWG/backend decoders. */
export const HttpOperationPathSchema = z.string().superRefine((path, context) => {
  const issue = validateHttpOperationPath(path);
  if (issue === null) return;
  context.addIssue({ code: 'custom', message: issue.message });
});

export const DiagnosticSeveritySchema = z.enum(['info', 'warning', 'error']);

export const DiagnosticLocationSchema = z
  .object({
    sourceUri: z.string().min(1).optional(),
    pointer: z.string().startsWith('/').or(z.literal('')).optional(),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
  })
  .strict();

export const DiagnosticSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*(?:\.[A-Z0-9_]+)*$/),
    severity: DiagnosticSeveritySchema,
    message: z.string().min(1),
    location: DiagnosticLocationSchema.optional(),
    related: z.array(DiagnosticLocationSchema).default([]),
    recoverable: z.boolean().default(true),
    details: z.record(z.string(), JsonValueSchema).optional(),
  })
  .strict();

export const ServerVariableSchema = z
  .object({
    default: WellFormedUnicodeStringSchema,
    enum: z.array(WellFormedUnicodeStringSchema).min(1).optional(),
    description: z.string().optional(),
  })
  .strict();

export const ServerTargetSchema = z
  .object({
    template: WellFormedUnicodeStringSchema.pipe(z.string().min(1)),
    resolvedUrl: WellFormedUnicodeStringSchema.pipe(z.string().min(1)).optional(),
    description: z.string().optional(),
    variables: z.record(WellFormedUnicodeStringSchema, ServerVariableSchema).default({}),
    provenancePointer: z.string().optional(),
  })
  .strict();

export const SecuritySchemeTypeSchema = z.enum([
  'apiKey',
  'http',
  'mutualTLS',
  'oauth2',
  'openIdConnect',
]);

export const SecuritySchemeMetadataSchema = z
  .object({
    name: z.string().min(1),
    type: SecuritySchemeTypeSchema,
    description: z.string().optional(),
    location: z.enum(['query', 'header', 'cookie']).optional(),
    parameterName: z.string().optional(),
    scheme: z.string().optional(),
    bearerFormat: z.string().optional(),
    openIdConnectUrl: z.string().optional(),
    oauthFlows: z.record(z.string(), JsonSchemaSchema).optional(),
    provenancePointer: z.string().optional(),
    extensions: z.record(z.string(), JsonValueSchema).optional(),
  })
  .strict()
  .superRefine((scheme, context) => {
    if (scheme.type === 'apiKey') {
      if (scheme.location === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'apiKey security schemes require a credential location.',
          path: ['location'],
        });
      }
      if (scheme.parameterName === undefined || scheme.parameterName.trim().length === 0) {
        context.addIssue({
          code: 'custom',
          message: 'apiKey security schemes require a non-empty parameter name.',
          path: ['parameterName'],
        });
      } else if (UNSAFE_OBJECT_KEYS.has(scheme.parameterName)) {
        context.addIssue({
          code: 'custom',
          message: 'apiKey parameter names cannot use prototype-sensitive object keys.',
          path: ['parameterName'],
        });
      } else if (scheme.location === 'query' && !isWellFormedUnicode(scheme.parameterName)) {
        context.addIssue({
          code: 'custom',
          message: 'Query apiKey parameter names cannot contain unpaired Unicode surrogates.',
          path: ['parameterName'],
        });
      } else if (
        (scheme.location === 'header' || scheme.location === 'cookie') &&
        !isHttpFieldName(scheme.parameterName)
      ) {
        context.addIssue({
          code: 'custom',
          message: `${scheme.location === 'header' ? 'Header' : 'Cookie'} apiKey parameter names must be valid HTTP tokens.`,
          path: ['parameterName'],
        });
      } else if (
        scheme.location === 'header' &&
        isTransportControlledCredentialHeader(scheme.parameterName)
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Header apiKey schemes cannot target routing or framing headers.',
          path: ['parameterName'],
        });
      }
    }
    if (
      scheme.type === 'http' &&
      (scheme.scheme === undefined || scheme.scheme.trim().length === 0)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'HTTP security schemes require a non-empty authentication scheme.',
        path: ['scheme'],
      });
    }
    if (
      scheme.type === 'oauth2' &&
      (scheme.oauthFlows === undefined || Object.keys(scheme.oauthFlows).length === 0)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'OAuth 2.0 security schemes require at least one flow.',
        path: ['oauthFlows'],
      });
    }
    if (scheme.type === 'openIdConnect') {
      if (scheme.openIdConnectUrl === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'OpenID Connect security schemes require a discovery URL.',
          path: ['openIdConnectUrl'],
        });
      } else {
        try {
          new URL(scheme.openIdConnectUrl);
        } catch {
          context.addIssue({
            code: 'custom',
            message: 'OpenID Connect discovery URL must be absolute.',
            path: ['openIdConnectUrl'],
          });
        }
      }
    }
  });

export const SecurityRequirementItemSchema = z
  .object({
    scheme: z.string().min(1),
    scopes: z.array(z.string()).default([]),
  })
  .strict();

/** One array entry is an AND group; alternatives are represented by the outer array. */
export const SecurityRequirementSchema = z.array(SecurityRequirementItemSchema);

export const AuthMetadataSchema = z
  .object({
    required: z.boolean(),
    alternatives: z.array(SecurityRequirementSchema).default([]),
    schemes: z.record(z.string(), SecuritySchemeMetadataSchema).default({}),
  })
  .strict();

export const ParameterLocationSchema = z.enum(['path', 'query', 'header', 'cookie']);

export const ParameterBindingSchema = z
  .object({
    location: ParameterLocationSchema,
    name: z.string().min(1),
    inputPath: InputPathSchema,
    required: z.boolean(),
    description: z.string().optional(),
    deprecated: z.boolean().optional(),
    style: z.string().optional(),
    explode: z.boolean().optional(),
    allowReserved: z.boolean().optional(),
    contentType: HttpMediaTypeSchema.optional(),
    schema: JsonSchemaSchema,
    provenancePointer: z.string().optional(),
  })
  .strict()
  .superRefine((binding, context) => {
    if (
      (binding.location === 'path' || binding.location === 'query') &&
      !isWellFormedUnicode(binding.name)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Path and query parameter names cannot contain unpaired Unicode surrogates.',
        path: ['name'],
      });
    }
    if (binding.location === 'path' && !binding.required) {
      context.addIssue({
        code: 'custom',
        message: 'Path parameters must be required',
        path: ['required'],
      });
    }
  });

export const RequestBodyBindingSchema = z
  .object({
    contentType: HttpMediaTypeSchema,
    /** Explicit JSON-to-wire representation for media types that cannot be inferred safely. */
    serialization: z.enum(['json', 'form', 'text', 'base64']).optional(),
    inputPath: InputPathSchema,
    /** Optional tool-input path whose value must equal contentType to select this representation. */
    contentTypeInputPath: InputPathSchema.optional(),
    required: z.boolean(),
    description: z.string().optional(),
    schema: JsonSchemaSchema,
    provenancePointer: z.string().optional(),
  })
  .strict();

export const SuccessResponseSchema = z
  .object({
    statusCode: z.string().regex(/^(?:2(?:\d{2}|XX)|default)$/i),
    description: z.string().optional(),
    contentType: HttpMediaTypeSchema.optional(),
    schema: JsonSchemaSchema.optional(),
    provenancePointer: z.string().optional(),
  })
  .strict();

/** Canonical upper-case HTTP token, including registered extension methods such as PROPFIND. */
export const HttpMethodSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Z-]+$/);

export const HttpExecutionSchema = z
  .object({
    kind: z.literal('http'),
    method: HttpMethodSchema,
    pathTemplate: HttpOperationPathSchema,
    servers: z.array(ServerTargetSchema).min(1),
    parameterBindings: z.array(ParameterBindingSchema).default([]),
    requestBodies: z.array(RequestBodyBindingSchema).default([]),
    successResponses: z.array(SuccessResponseSchema).default([]),
  })
  .strict();

export const ProvenanceSchema = z
  .object({
    sourceKind: z.string().min(1),
    sourceId: z.string().min(1),
    sourceUri: z.string().min(1).optional(),
    documentFingerprint: FingerprintSchema,
    pointer: z.string().startsWith('/'),
    operationId: z.string().min(1).optional(),
  })
  .strict();

export const RiskMetadataSchema = z
  .object({
    level: z.enum(['read', 'write', 'destructive', 'unknown']),
    sideEffect: z.enum(['none', 'possible', 'definite', 'unknown']),
    idempotency: z.enum(['idempotent', 'conditional', 'non-idempotent', 'unknown']),
    requiresConfirmation: z.boolean(),
    rationale: z.array(z.string()).default([]),
  })
  .strict();

export const CapabilityIntentSchema = z
  .object({
    useWhen: z.array(z.string()).default([]),
    avoidWhen: z.array(z.string()).default([]),
    examples: z.array(z.string()).default([]),
    tags: z.array(z.string()).default([]),
  })
  .strict();

export const CapabilitySchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    name: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    title: z.string().min(1).optional(),
    description: z.string().min(1),
    intent: CapabilityIntentSchema,
    inputSchema: JsonSchemaSchema,
    outputSchema: JsonSchemaSchema.optional(),
    auth: AuthMetadataSchema,
    risk: RiskMetadataSchema,
    execution: HttpExecutionSchema,
    provenance: ProvenanceSchema,
    fingerprint: FingerprintSchema,
    extensions: z.record(z.string(), JsonValueSchema).optional(),
  })
  .strict();

export const NormalizedOperationSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    operationId: z.string().min(1).optional(),
    method: HttpMethodSchema,
    path: HttpOperationPathSchema,
    summary: z.string().optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).default([]),
    deprecated: z.boolean().default(false),
    servers: z.array(ServerTargetSchema).min(1),
    parameters: z.array(ParameterBindingSchema).default([]),
    requestBodies: z.array(RequestBodyBindingSchema).default([]),
    successResponses: z.array(SuccessResponseSchema).default([]),
    auth: AuthMetadataSchema,
    /** Optional authoritative override for APIs whose observed semantics are stricter than the HTTP method default. */
    risk: RiskMetadataSchema.optional(),
    provenance: ProvenanceSchema,
    fingerprint: FingerprintSchema,
  })
  .strict()
  .superRefine((operation, context) => {
    if (operation.requestBodies.length > 1) {
      const first = operation.requestBodies[0]!;
      const expectedInputPath = JSON.stringify(first.inputPath);
      const expectedSelector =
        first.contentTypeInputPath === undefined
          ? undefined
          : JSON.stringify(first.contentTypeInputPath);
      const contentTypes = new Set<string>();
      operation.requestBodies.forEach((binding, index) => {
        if (JSON.stringify(binding.inputPath) !== expectedInputPath) {
          context.addIssue({
            code: 'custom',
            message: 'All request body representations must share one input path.',
            path: ['requestBodies', index, 'inputPath'],
          });
        }
        if (binding.required !== first.required) {
          context.addIssue({
            code: 'custom',
            message: 'All request body representations must share one required state.',
            path: ['requestBodies', index, 'required'],
          });
        }
        if (binding.contentTypeInputPath === undefined) {
          context.addIssue({
            code: 'custom',
            message: 'Multiple request body representations require a content-type selector.',
            path: ['requestBodies', index, 'contentTypeInputPath'],
          });
        } else if (JSON.stringify(binding.contentTypeInputPath) !== expectedSelector) {
          context.addIssue({
            code: 'custom',
            message: 'All request body representations must share one selector path.',
            path: ['requestBodies', index, 'contentTypeInputPath'],
          });
        }
        const normalizedContentType = binding.contentType.trim().toLowerCase();
        if (contentTypes.has(normalizedContentType)) {
          context.addIssue({
            code: 'custom',
            message: `Duplicate request body representation: ${binding.contentType}.`,
            path: ['requestBodies', index, 'contentType'],
          });
        }
        contentTypes.add(normalizedContentType);
      });
    }

    const bindings = [
      ...operation.parameters.map((binding, index) => ({
        collection: 'parameters' as const,
        index,
        field: 'inputPath' as const,
        role: 'value' as const,
        inputPath: binding.inputPath,
      })),
      ...operation.requestBodies.map((binding, index) => ({
        collection: 'requestBodies' as const,
        index,
        field: 'inputPath' as const,
        role: 'value' as const,
        inputPath: binding.inputPath,
      })),
      ...operation.requestBodies.flatMap((binding, index) =>
        binding.contentTypeInputPath === undefined
          ? []
          : [
              {
                collection: 'requestBodies' as const,
                index,
                field: 'contentTypeInputPath' as const,
                role: 'selector' as const,
                inputPath: binding.contentTypeInputPath,
              },
            ],
      ),
    ];
    for (let leftIndex = 0; leftIndex < bindings.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < bindings.length; rightIndex += 1) {
        const left = bindings[leftIndex]!;
        const right = bindings[rightIndex]!;
        if (left.inputPath.length === right.inputPath.length) {
          if (
            left.role !== right.role &&
            left.inputPath.every((segment, index) => segment === right.inputPath[index])
          ) {
            context.addIssue({
              code: 'custom',
              message: `Selector path ${left.inputPath.join('.')} collides with a bound input value.`,
              path: [right.collection, right.index, right.field],
            });
          }
          continue;
        }
        const shorter = left.inputPath.length < right.inputPath.length ? left : right;
        const longer = shorter === left ? right : left;
        if (shorter.inputPath.every((segment, index) => segment === longer.inputPath[index])) {
          context.addIssue({
            code: 'custom',
            message: `Input path ${shorter.inputPath.join('.')} is a strict prefix of ${longer.inputPath.join('.')}.`,
            path: [longer.collection, longer.index, longer.field],
          });
        }
      }
    }
  });

export const NormalizedApiDocumentSchema = z
  .object({
    sourceId: z.string().min(1),
    sourceUri: z.string().min(1).optional(),
    sourceFormat: z.enum(['json', 'yaml', 'object']),
    sourceKind: z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/),
    sourceVersion: z.string().min(1).optional(),
    /** Deprecated compatibility alias emitted only by the OpenAPI adapter. */
    openapiVersion: z
      .string()
      .regex(/^3\.\d+(?:\.\d+)?(?:[-+].*)?$/)
      .optional(),
    title: z.string().min(1),
    version: z.string().optional(),
    description: z.string().optional(),
    documentFingerprint: FingerprintSchema,
    servers: z.array(ServerTargetSchema).min(1),
    securitySchemes: z.record(z.string(), SecuritySchemeMetadataSchema).default({}),
    operations: z.array(NormalizedOperationSchema),
  })
  .strict()
  .superRefine((document, context) => {
    const operationIds = new Map<string, number>();
    document.operations.forEach((operation, index) => {
      const previousIndex = operationIds.get(operation.id);
      if (previousIndex === undefined) {
        operationIds.set(operation.id, index);
        return;
      }
      context.addIssue({
        code: 'custom',
        message: `Operation id ${operation.id} duplicates operation index ${previousIndex}.`,
        path: ['operations', index, 'id'],
      });
    });

    if (document.sourceKind === 'openapi') {
      if (document.openapiVersion === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'OpenAPI documents must retain openapiVersion for compatibility.',
          path: ['openapiVersion'],
        });
      }
      if (document.sourceVersion === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'OpenAPI documents must retain their source version.',
          path: ['sourceVersion'],
        });
      }
    } else if (document.openapiVersion !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Only OpenAPI source documents may declare openapiVersion.',
        path: ['openapiVersion'],
      });
    }
    if (
      document.openapiVersion !== undefined &&
      document.sourceVersion !== undefined &&
      document.openapiVersion !== document.sourceVersion
    ) {
      context.addIssue({
        code: 'custom',
        message: 'sourceVersion and openapiVersion must match for OpenAPI documents.',
        path: ['sourceVersion'],
      });
    }
  });

export const CapabilityCandidateSchema = z
  .object({
    sourceOperationId: z.string().min(1),
    stage: z.enum(['baseline', 'semantic']),
    capability: CapabilitySchema,
    rationale: z.array(z.string()).default([]),
    diagnostics: z.array(DiagnosticSchema).default([]),
  })
  .strict();

export const ReleaseSourceSchema = z
  .object({
    sourceId: z.string().min(1),
    sourceUri: z.string().min(1).optional(),
    sourceKind: z.string().min(1),
    fingerprint: FingerprintSchema,
  })
  .strict();

export const CompilerMetadataSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    model: z
      .object({
        provider: z.string().min(1),
        name: z.string().min(1),
        promptFingerprint: FingerprintSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const ReleaseSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    sequence: z.number().int().nonnegative(),
    createdAt: z.string().datetime({ offset: true }),
    compiler: CompilerMetadataSchema,
    sources: z.array(ReleaseSourceSchema).min(1),
    capabilities: z.array(CapabilitySchema),
    diagnostics: z.array(DiagnosticSchema).default([]),
    fingerprint: FingerprintSchema,
    extensions: z.record(z.string(), JsonValueSchema).optional(),
  })
  .strict();

export type DiagnosticSeverity = z.infer<typeof DiagnosticSeveritySchema>;
export type DiagnosticLocation = z.infer<typeof DiagnosticLocationSchema>;
export type Diagnostic = z.infer<typeof DiagnosticSchema>;
export type ServerVariable = z.infer<typeof ServerVariableSchema>;
export type ServerTarget = z.infer<typeof ServerTargetSchema>;
export type SecuritySchemeType = z.infer<typeof SecuritySchemeTypeSchema>;
export type SecuritySchemeMetadata = z.infer<typeof SecuritySchemeMetadataSchema>;
export type SecurityRequirementItem = z.infer<typeof SecurityRequirementItemSchema>;
export type SecurityRequirement = z.infer<typeof SecurityRequirementSchema>;
export type AuthMetadata = z.infer<typeof AuthMetadataSchema>;
export type ParameterLocation = z.infer<typeof ParameterLocationSchema>;
export type ParameterBinding = z.infer<typeof ParameterBindingSchema>;
export type RequestBodyBinding = z.infer<typeof RequestBodyBindingSchema>;
export type SuccessResponse = z.infer<typeof SuccessResponseSchema>;
export type HttpMethod = z.infer<typeof HttpMethodSchema>;
export type HttpExecution = z.infer<typeof HttpExecutionSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type RiskMetadata = z.infer<typeof RiskMetadataSchema>;
export type CapabilityIntent = z.infer<typeof CapabilityIntentSchema>;
export type Capability = z.infer<typeof CapabilitySchema>;
export type NormalizedOperation = z.infer<typeof NormalizedOperationSchema>;
export type NormalizedApiDocument = z.infer<typeof NormalizedApiDocumentSchema>;
export type CapabilityCandidate = z.infer<typeof CapabilityCandidateSchema>;
export type ReleaseSource = z.infer<typeof ReleaseSourceSchema>;
export type CompilerMetadata = z.infer<typeof CompilerMetadataSchema>;
export type Release = z.infer<typeof ReleaseSchema>;
