import {
  HttpMethodSchema,
  HttpMediaTypeSchema,
  HttpOperationPathSchema,
  InputPathSchema,
  JsonSchemaSchema,
  JsonValueSchema,
  ParameterLocationSchema,
  RiskMetadataSchema,
  SecurityRequirementSchema,
  SecuritySchemeTypeSchema,
  isWellFormedUnicode,
} from '@hi-mcp/capability-ir';
import { z } from 'zod';

const IdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const PrototypeSafeNameSchema = z
  .string()
  .min(1)
  .refine((name) => !['__proto__', 'prototype', 'constructor'].includes(name), {
    message: 'Credential names cannot use prototype-sensitive object keys.',
  });
export const HttpManifestServerSchema = z
  .object({
    url: z.string().min(1).refine(isWellFormedUnicode, {
      message: 'Server URL cannot contain unpaired Unicode surrogates.',
    }),
    description: z.string().min(1).optional(),
  })
  .strict();

export const HttpManifestSecuritySchemeSchema = z
  .object({
    type: SecuritySchemeTypeSchema,
    description: z.string().optional(),
    location: z.enum(['query', 'header', 'cookie']).optional(),
    parameterName: PrototypeSafeNameSchema.optional(),
    scheme: z.string().min(1).optional(),
    bearerFormat: z.string().optional(),
    openIdConnectUrl: z.string().min(1).optional(),
    oauthFlows: z.record(z.string(), JsonSchemaSchema).optional(),
    extensions: z.record(z.string(), JsonValueSchema).optional(),
  })
  .strict()
  .superRefine((scheme, context) => {
    if (
      scheme.type === 'apiKey' &&
      scheme.location === 'query' &&
      scheme.parameterName !== undefined &&
      !isWellFormedUnicode(scheme.parameterName)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Query apiKey parameter names cannot contain unpaired Unicode surrogates.',
        path: ['parameterName'],
      });
    }
  });

export const HttpManifestParameterSchema = z
  .object({
    in: ParameterLocationSchema,
    name: z.string().min(1),
    inputPath: InputPathSchema.optional(),
    required: z.boolean().optional(),
    description: z.string().optional(),
    deprecated: z.boolean().optional(),
    style: z.string().min(1).optional(),
    explode: z.boolean().optional(),
    allowReserved: z.boolean().optional(),
    contentType: HttpMediaTypeSchema.optional(),
    schema: JsonSchemaSchema,
  })
  .strict()
  .superRefine((parameter, context) => {
    if (
      (parameter.in === 'path' || parameter.in === 'query') &&
      !isWellFormedUnicode(parameter.name)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Path and query parameter names cannot contain unpaired Unicode surrogates.',
        path: ['name'],
      });
    }
  });

export const HttpManifestRequestBodySchema = z
  .object({
    contentType: HttpMediaTypeSchema,
    serialization: z.enum(['json', 'form', 'text', 'base64']).optional(),
    inputPath: InputPathSchema.optional(),
    contentTypeInputPath: InputPathSchema.optional(),
    required: z.boolean().default(false),
    description: z.string().optional(),
    schema: JsonSchemaSchema,
  })
  .strict();

export const HttpManifestSuccessResponseSchema = z
  .object({
    statusCode: z.string().regex(/^(?:2(?:\d{2}|XX)|default)$/i),
    description: z.string().optional(),
    contentType: HttpMediaTypeSchema.optional(),
    schema: JsonSchemaSchema.optional(),
  })
  .strict();

export const HttpManifestOperationSchema = z
  .object({
    id: IdentifierSchema,
    method: HttpMethodSchema,
    path: HttpOperationPathSchema,
    summary: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    tags: z.array(z.string().min(1)).default([]),
    deprecated: z.boolean().default(false),
    servers: z.array(HttpManifestServerSchema).min(1).optional(),
    parameters: z.array(HttpManifestParameterSchema).default([]),
    requestBodies: z.array(HttpManifestRequestBodySchema).default([]),
    successResponses: z.array(HttpManifestSuccessResponseSchema).min(1),
    security: z.array(SecurityRequirementSchema).optional(),
    risk: RiskMetadataSchema.optional(),
  })
  .strict();

export const HttpApiManifestSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    kind: z.literal('http'),
    id: IdentifierSchema,
    title: z.string().min(1),
    version: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    servers: z.array(HttpManifestServerSchema).min(1),
    securitySchemes: z.record(IdentifierSchema, HttpManifestSecuritySchemeSchema).default({}),
    security: z.array(SecurityRequirementSchema).default([]),
    operations: z.array(HttpManifestOperationSchema).min(1),
  })
  .strict();

export type HttpApiManifest = z.infer<typeof HttpApiManifestSchema>;
