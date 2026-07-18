import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

import type { JsonSchema } from './types.js';
import { assertJsonSchemaComplexity } from './complexity.js';
import type { JsonSchemaComplexityLimits } from './types.js';

export class SchemaValidator {
  readonly #ajv: Ajv2020;
  readonly #cache = new Map<JsonSchema, ValidateFunction>();
  readonly #limits: JsonSchemaComplexityLimits;

  constructor(limits: JsonSchemaComplexityLimits) {
    this.#limits = limits;
    this.#ajv = new Ajv2020({
      allErrors: true,
      strict: false,
      validateFormats: false,
      allowUnionTypes: true,
    });
  }

  validate(schema: JsonSchema, value: unknown): readonly ErrorObject[] | undefined {
    const validate = this.#validatorFor(schema);
    if (validate(value)) {
      return undefined;
    }

    return (validate.errors ?? []).map((error) => ({
      ...error,
      params: { ...error.params },
    }));
  }

  #validatorFor(schema: JsonSchema): ValidateFunction {
    const cached = this.#cache.get(schema);
    if (cached !== undefined) {
      return cached;
    }

    assertJsonSchemaComplexity(schema, this.#limits);
    const compiled = this.#ajv.compile(schema);
    this.#cache.set(schema, compiled);
    return compiled;
  }
}
