/**
 * One error shape, declared on every route that can produce one.
 *
 * Fastify serializes responses against the declared schema, so an undeclared
 * status code is an empty body at runtime and a type error at compile time —
 * which is the useful half of the same rule. Declaring them also puts the
 * failure modes in the emitted OpenAPI document, where the generated client can
 * see them.
 *
 * The shape itself now lives in `schemas.ts` as the shared `ApiError`, so the
 * generated client has one error interface rather than one per status code per
 * route, and `openapi.json` carries one definition rather than sixty copies.
 */

import { ref } from './schemas.js';

/** Spread into a route's `response` map. */
export const errorResponses = {
  400: ref('ApiError'),
  404: ref('ApiError'),
  409: ref('ApiError'),
  415: ref('ApiError'),
  422: ref('ApiError'),
  500: ref('ApiError'),
};
