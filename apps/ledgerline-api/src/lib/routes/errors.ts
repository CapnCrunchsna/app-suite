/**
 * One error shape, declared on every route that can produce one.
 *
 * Fastify serializes responses against the declared schema, so an undeclared
 * status code is an empty body at runtime and a type error at compile time —
 * which is the useful half of the same rule. Declaring them also puts the
 * failure modes in the emitted OpenAPI document, where the generated client can
 * see them.
 */

export const errorSchema = {
  type: 'object',
  properties: {
    error: { type: 'string', description: 'Stable machine-readable code' },
    message: { type: 'string' },
    rowIndexes: {
      type: 'array',
      items: { type: 'integer' },
      description: 'Present on `zero_amount_rows`: the rows that parsed to $0.00.',
    },
  },
} as const;

/** Spread into a route's `response` map. */
export const errorResponses = {
  400: errorSchema,
  404: errorSchema,
  409: errorSchema,
  415: errorSchema,
  422: errorSchema,
  500: errorSchema,
};
