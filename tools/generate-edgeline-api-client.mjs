/**
 * Generate `libs/edgeline/api-client` from `apps/edgeline-api/openapi.json`.
 *
 *   node tools/generate-edgeline-api-client.mjs           # write
 *   node tools/generate-edgeline-api-client.mjs --check   # fail if the committed output is stale
 *
 * ## Why a local emitter rather than openapi-ts
 *
 * Spec §11.3 suggests `openapi-ts` or `ng-openapi-gen`, and either would work.
 * Two things pointed the other way. This workspace already has exactly this
 * pattern in `tools/generate-api-client.mjs` for Ledgerline, with the same two
 * rules below, and a second generator with different naming heuristics would make
 * the two clients diverge in style for no reason. And a worktree cannot
 * `npm install` (see app-suite/CLAUDE.md), so adding a dependency here would have
 * to happen in the main checkout before this could run at all.
 *
 * This is a sibling of that file rather than a refactor of it: Ledgerline's
 * emitter reads Fastify's OpenAPI 3.0 output and its tests pin the result, while
 * FastAPI emits 3.1 with `anyOf`-style nullables. Two ~200-line emitters that are
 * each obviously correct beat one parameterised one whose behaviour depends on
 * which app called it.
 *
 * ## The two rules, same as its sibling
 *
 * **It invents no names.** Every exported type is a `components.schemas` key and
 * every method is an `operationId`. `apps/edgeline-api` sets an explicit
 * `operation_id` on every route for exactly this reason; an operation without one
 * is an error, not a guess.
 *
 * **Output is byte-deterministic.** Schemas and operations are emitted in the
 * order `openapi.json` declares them, which is FastAPI's route-registration
 * order and stable. That is what makes `--check` a gate rather than a coin flip.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OPENAPI = join(workspaceRoot, 'apps/edgeline-api/openapi.json');
const OUT_DIR = join(workspaceRoot, 'libs/edgeline/api-client/src');

const BANNER = `// GENERATED — NEVER HAND-EDIT.
//
// Emitted by \`tools/generate-edgeline-api-client.mjs\` from
// \`apps/edgeline-api/openapi.json\` (spec §11.3). Hand edits are silently
// overwritten by the next generation run.
//
// To change anything here, change the FastAPI route that produces it, then:
//
//     npx nx run edgeline-api-client:generate-client
`;

// ---------------------------------------------------------------- helpers ---

const camel = (name) =>
  name.replace(/[_-]+(.)/g, (_, c) => c.toUpperCase()).replace(/^(.)/, (_, c) => c.toLowerCase());

/** A TypeScript type for one OpenAPI schema node. */
function tsType(schema) {
  if (!schema || Object.keys(schema).length === 0) return 'unknown';

  if (schema.$ref) return schema.$ref.split('/').pop();

  if (Array.isArray(schema.anyOf)) {
    const parts = schema.anyOf.map(tsType);
    return [...new Set(parts)].join(' | ');
  }
  if (Array.isArray(schema.allOf)) return schema.allOf.map(tsType).join(' & ');

  if (Array.isArray(schema.enum)) {
    return schema.enum.map((value) => JSON.stringify(value)).join(' | ');
  }
  if (schema.const !== undefined) return JSON.stringify(schema.const);

  switch (schema.type) {
    case 'string':
      return 'string';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array':
      return `${wrap(tsType(schema.items))}[]`;
    case 'object': {
      if (schema.properties) return objectLiteral(schema);
      const value = schema.additionalProperties;
      if (value === true || value === undefined) return 'Record<string, unknown>';
      return `Record<string, ${tsType(value)}>`;
    }
    default:
      return 'unknown';
  }
}

/** Parenthesise a union before suffixing `[]`, or `a | b[]` means the wrong thing. */
const wrap = (type) => (type.includes(' | ') ? `(${type})` : type);

function objectLiteral(schema) {
  const required = new Set(schema.required ?? []);
  const fields = Object.entries(schema.properties ?? {}).map(
    ([name, value]) => `  ${JSON.stringify(name)}${required.has(name) ? '' : '?'}: ${tsType(value)};`
  );
  return `{\n${fields.join('\n')}\n}`;
}

function emitSchema(name, schema) {
  const doc = schema.description ? `/** ${schema.description.split('\n')[0]} */\n` : '';
  if (schema.type === 'object' || schema.properties) {
    const required = new Set(schema.required ?? []);
    const fields = Object.entries(schema.properties ?? {}).map(([field, value]) => {
      const optional = required.has(field) ? '' : '?';
      const key = /^[A-Za-z_$][\w$]*$/.test(field) ? field : JSON.stringify(field);
      return `  ${key}${optional}: ${tsType(value)};`;
    });
    return `${doc}export interface ${name} {\n${fields.join('\n')}\n}\n`;
  }
  return `${doc}export type ${name} = ${tsType(schema)};\n`;
}

// ------------------------------------------------------------- operations ---

function collectOperations(doc) {
  const operations = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!['get', 'put', 'post', 'patch', 'delete'].includes(method)) continue;
      if (!operation.operationId) {
        throw new Error(`${method.toUpperCase()} ${path} has no operationId`);
      }
      const parameters = operation.parameters ?? [];
      operations.push({
        id: operation.operationId,
        method: method.toUpperCase(),
        path,
        summary: (operation.summary ?? '').split('\n')[0],
        pathParams: parameters.filter((p) => p.in === 'path'),
        queryParams: parameters.filter((p) => p.in === 'query'),
        body: operation.requestBody?.content?.['application/json']?.schema,
        response:
          operation.responses?.['200']?.content?.['application/json']?.schema ??
          operation.responses?.['201']?.content?.['application/json']?.schema,
      });
    }
  }
  return operations;
}

function emitMethod(operation) {
  const args = [];
  for (const parameter of operation.pathParams) {
    args.push(`${camel(parameter.name)}: ${tsType(parameter.schema)}`);
  }
  if (operation.body) args.push(`body: ${tsType(operation.body)}`);

  let queryType = '';
  if (operation.queryParams.length) {
    const fields = operation.queryParams.map(
      (p) => `    ${JSON.stringify(p.name)}?: ${tsType(p.schema)};`
    );
    queryType = `{\n${fields.join('\n')}\n  }`;
    args.push(`query?: ${queryType}`);
  }
  args.push('options?: RequestOptions');

  // Template the path, substituting each path parameter by its camelCase arg.
  let url = '`' + operation.path.replace(/\{([^}]+)\}/g, (_, name) => `\${encodeURIComponent(String(${camel(name)}))}`) + '`';

  const returns = operation.response ? tsType(operation.response) : 'void';
  const doc = operation.summary ? `  /** ${operation.summary} */\n` : '';

  const call = [
    `    return this.request<${returns}>(`,
    `      ${JSON.stringify(operation.method)},`,
    `      ${url},`,
    `      { ${operation.body ? 'body, ' : ''}${operation.queryParams.length ? 'query, ' : ''}...options },`,
    `    );`,
  ].join('\n');

  return `${doc}  async ${operation.id}(${args.join(', ')}): Promise<${returns}> {\n${call}\n  }\n`;
}

// ------------------------------------------------------------------- emit ---

const RUNTIME = `export interface RequestOptions {
  /** Overrides the client's base URL for a single call. */
  baseUrl?: string;
  /** Injected for tests; defaults to the global \`fetch\`. */
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/** Thrown for any non-2xx response, carrying the parsed body when there is one. */
export class EdgelineApiError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: unknown,
  ) {
    super(\`\${status} for \${url}\`);
    this.name = 'EdgelineApiError';
  }
}

interface CallOptions extends RequestOptions {
  body?: unknown;
  query?: Record<string, unknown>;
}

export class EdgelineApiClient {
  constructor(private readonly baseUrl = '') {}

  private async request<T>(method: string, path: string, options: CallOptions = {}): Promise<T> {
    const base = options.baseUrl ?? this.baseUrl;
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === null) continue;
      search.append(key, String(value));
    }
    const query = search.toString();
    const url = \`\${base}\${path}\${query ? \`?\${query}\` : ''}\`;

    const doFetch = options.fetch ?? globalThis.fetch;
    const response = await doFetch(url, {
      method,
      signal: options.signal,
      headers: {
        Accept: 'application/json',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const text = await response.text();
    const parsed = text ? JSON.parse(text) : undefined;
    if (!response.ok) throw new EdgelineApiError(response.status, url, parsed);
    return parsed as T;
  }
`;

function generate() {
  if (!existsSync(OPENAPI)) {
    throw new Error(
      `${OPENAPI} is missing. Generate it first:\n` +
        '    cd apps/edgeline-api && uv run python -m edgeline.api.openapi'
    );
  }
  const doc = JSON.parse(readFileSync(OPENAPI, 'utf8'));

  const schemas = Object.entries(doc.components?.schemas ?? {})
    .map(([name, schema]) => emitSchema(name, schema))
    .join('\n');

  const operations = collectOperations(doc);
  const methods = operations.map(emitMethod).join('\n');

  const types = `${BANNER}\n${schemas}`;

  // Import only what the emitted methods actually mention. `noUnusedLocals` is on
  // across this workspace, so importing the whole schema set would make every
  // generated client fail typecheck for types nobody asked for.
  const referenced = Object.keys(doc.components?.schemas ?? {}).filter((name) =>
    new RegExp(`\\b${name}\\b`).test(methods)
  );
  const imports = referenced.length
    ? `import type {\n${referenced.map((name) => `  ${name},`).join('\n')}\n} from './types.js';\n\n`
    : '';

  // Explicit `.js` on relative imports: the workspace resolves with `nodenext`,
  // which requires the extension even though the source is `.ts`.
  const client = `${BANNER}\n${imports}${RUNTIME}\n${methods}}\n`;
  const index = `${BANNER}\nexport * from './types.js';\nexport * from './client.js';\n`;

  return {
    'types.ts': types,
    'client.ts': client,
    'index.ts': index,
  };
}

function main() {
  const check = process.argv.includes('--check');
  const files = generate();

  if (check) {
    const stale = Object.entries(files).filter(([name, content]) => {
      const path = join(OUT_DIR, name);
      return !existsSync(path) || readFileSync(path, 'utf8') !== content;
    });
    if (stale.length) {
      console.error(
        `stale generated client: ${stale.map(([n]) => n).join(', ')}\n` +
          'Regenerate with:  npx nx run edgeline-api-client:generate-client'
      );
      process.exit(1);
    }
    console.log(`edgeline api-client is up to date (${Object.keys(files).length} files)`);
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(OUT_DIR, name), content, 'utf8');
  }
  console.log(`wrote ${Object.keys(files).length} files to ${OUT_DIR}`);
}

main();
