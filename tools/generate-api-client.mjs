/**
 * Generate `libs/shared/api-client` from `apps/ledgerline-api/openapi.json`.
 *
 *   node tools/generate-api-client.mjs           # write
 *   node tools/generate-api-client.mjs --check   # fail if the committed output is stale
 *
 * §2.2 gives `api-client` the note "Generated. Never hand-edited." This is the
 * thing that makes that sentence true rather than aspirational — before this, the
 * lib was a stub with a banner asking to be believed.
 *
 * ## Why this is written here and not delegated to a package
 *
 * The generated surface is small and completely determined: one local Fastify API,
 * every schema named by an `$id` its author chose, every operation named by an
 * explicit `operationId`. A general OpenAPI generator would bring a dependency,
 * its own naming heuristics, and its own opinion about HTTP — and `api-client`'s
 * boundary is `onlyDependOnLibsWithTags: []`, the tightest in the workspace. A
 * hundred lines of emitter keeps the generated code readable by the people who
 * have to review its diffs, which is the actual review surface for an API change.
 *
 * ## The two rules the emitter follows
 *
 * **It invents no names.** Every exported type is a `components.schemas` key and
 * every method is an `operationId`. If a name is wrong, it is wrong in a route
 * schema, and the fix is there. This is also why there is no fallback: an
 * operation without an `operationId` is an error, not a guess.
 *
 * **Output is byte-deterministic.** Schemas and operations are emitted in the
 * order `openapi.json` declares them, which is registration order and stable. That
 * is what makes `--check` a meaningful CI gate rather than a coin flip.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OPENAPI = join(workspaceRoot, 'apps/ledgerline-api/openapi.json');
const OUT_DIR = join(workspaceRoot, 'libs/shared/api-client/src');

const BANNER = `// GENERATED — NEVER HAND-EDIT.
//
// Emitted by \`tools/generate-api-client.mjs\` from
// \`apps/ledgerline-api/openapi.json\` (spec 2.1, 2.2, 2.3). Hand edits are
// silently overwritten by the next generation run.
//
// To change anything here, change the Fastify route schema that produces it and
// regenerate:
//
//     npx nx generate-client api-client
//
// \`ledgerline-api\`'s test suite fails if this directory and \`openapi.json\`
// disagree, so a stale client cannot reach a commit.
`;

// ---------------------------------------------------------------- helpers ---

/**
 * Every schema name the current emission actually referenced.
 *
 * `noUnusedLocals` is on workspace-wide, so `api-client.ts` cannot simply import
 * all fourteen component types and use nine of them — that is a compile error, not
 * a lint warning. The import list has to be exactly what was used.
 */
let referenced = new Set();

/** `#/components/schemas/Transaction` -> `Transaction`. */
function refName(ref) {
  const match = /^#\/components\/schemas\/(.+)$/.exec(ref);
  if (!match) throw new Error(`unsupported $ref: ${ref}`);
  referenced.add(match[1]);
  return match[1];
}

function quote(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** A doc comment at the given indent, or nothing. */
function docComment(schema, indent) {
  const text = schema?.description;
  if (!text) return '';
  const lines = String(text).split('\n');
  if (lines.length === 1 && lines[0].length + indent.length < 76) {
    return `${indent}/** ${lines[0]} */\n`;
  }
  return `${indent}/**\n${lines.map((line) => `${indent} * ${line}`.trimEnd()).join('\n')}\n${indent} */\n`;
}

/**
 * JSON Schema -> a TypeScript type expression.
 *
 * Only the subset Fastify actually emits is handled. Anything else becomes
 * `unknown` rather than a wrong guess: a route with no declared response schema
 * genuinely tells the client nothing about its body, and `unknown` is what forces
 * the call site to say what it believes instead of inheriting a fiction.
 */
function typeOf(schema, indent = '') {
  if (!schema || typeof schema !== 'object') return 'unknown';
  if (schema.$ref) return refName(schema.$ref);

  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const nullable = types.includes('null');
  const concrete = types.filter((type) => type !== 'null');

  const base = (() => {
    if (schema.enum) {
      // `type: ['string','null']` with a null in the enum is one nullable union,
      // not a union that also happens to include the string "null".
      const members = schema.enum.filter((value) => value !== null).map(quote);
      return members.length > 0 ? members.join(' | ') : 'never';
    }
    if (concrete.length === 0) return 'unknown';
    if (concrete.length > 1)
      return concrete.map((type) => scalar(type, schema, indent)).join(' | ');
    return scalar(concrete[0], schema, indent);
  })();

  if (!nullable) return base;
  return base.includes(' | ') && !base.startsWith('{') ? `${base} | null` : `${base} | null`;
}

function scalar(type, schema, indent) {
  switch (type) {
    case 'string':
      return 'string';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array': {
      const item = typeOf(schema.items, indent);
      return item.includes(' | ') ? `(${item})[]` : `${item}[]`;
    }
    case 'object':
      return schema.properties ? inlineObject(schema, indent) : 'Record<string, unknown>';
    default:
      return 'unknown';
  }
}

/** An anonymous object type, for a request body that was not given an `$id`. */
function inlineObject(schema, indent) {
  const required = new Set(schema.required ?? []);
  const inner = `${indent}  `;
  const lines = Object.entries(schema.properties).map(([name, property]) => {
    const optional = required.has(name) ? '' : '?';
    return `${docComment(property, inner)}${inner}readonly ${name}${optional}: ${typeOf(property, inner)};`;
  });
  return `{\n${lines.join('\n')}\n${indent}}`;
}

// ---------------------------------------------------------------- schemas ---

function emitSchemas(document) {
  const schemas = document.components?.schemas ?? {};
  const parts = [
    BANNER,
    `
/**
 * The wire types, one per \`components.schemas\` entry.
 *
 * \`readonly\` throughout: these are what the API said, and a UI that mutates a
 * response is a UI that has invented a fact about the store. Money is \`number\`
 * because every money field on the wire is integer cents (spec 3.1, 7.3) — format
 * it for display with \`formatCents\` and never parse a formatted string back.
 */
`,
  ];

  for (const [name, schema] of Object.entries(schemas)) {
    const required = new Set(schema.required ?? []);
    const properties = schema.properties ?? {};

    parts.push(docComment(schema, ''));
    parts.push(`export interface ${name} {\n`);
    for (const [property, propertySchema] of Object.entries(properties)) {
      const optional = required.has(property) ? '' : '?';
      parts.push(docComment(propertySchema, '  '));
      parts.push(`  readonly ${property}${optional}: ${typeOf(propertySchema, '  ')};\n`);
    }
    parts.push('}\n\n');
  }

  return parts.join('').trimEnd() + '\n';
}

// ------------------------------------------------------------- operations ---

const METHODS = ['get', 'post', 'patch', 'put', 'delete'];

function collectOperations(document) {
  const operations = [];

  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation) continue;

      if (!operation.operationId) {
        throw new Error(
          `${method.toUpperCase()} ${path} has no operationId. Add one to its Fastify route ` +
            `schema — this generator never invents a method name.`,
        );
      }

      const parameters = operation.parameters ?? [];
      const success = Object.entries(operation.responses ?? {})
        .filter(([code]) => code.startsWith('2'))
        .sort(([a], [b]) => a.localeCompare(b))[0];

      operations.push({
        path,
        method,
        operationId: operation.operationId,
        summary: operation.summary,
        description: operation.description,
        pathParams: parameters.filter((parameter) => parameter.in === 'path'),
        queryParams: parameters.filter((parameter) => parameter.in === 'query'),
        body: operation.requestBody?.content?.['application/json']?.schema ?? null,
        bodyRequired: operation.requestBody?.required === true,
        response: success?.[1]?.content?.['application/json']?.schema ?? null,
      });
    }
  }

  return operations;
}

function emitOperations(document) {
  const operations = collectOperations(document);

  referenced = new Set();
  // The runtime's `LedgerlineApiError` carries the API's own error body, so this
  // one is used whether or not any operation happens to reference it.
  referenced.add('ApiError');

  const parts = [];

  for (const operation of operations) {
    const queryTypeName = `${capitalize(operation.operationId)}Query`;
    if (operation.queryParams.length > 0) {
      parts.push(`export interface ${queryTypeName} {\n`);
      for (const parameter of operation.queryParams) {
        const optional = parameter.required ? '' : '?';
        parts.push(docComment(parameter.schema ?? parameter, '  '));
        parts.push(`  readonly ${parameter.name}${optional}: ${typeOf(parameter.schema, '  ')};\n`);
      }
      parts.push('}\n\n');
    }

    if (operation.body && !operation.body.$ref) {
      parts.push(
        `export type ${capitalize(operation.operationId)}Body = ${typeOf(operation.body, '')};\n\n`,
      );
    }

    // A response that is not a `$ref` gets a name here rather than being inlined
    // at the method. Inlining spells a twenty-line object literal twice — once as
    // the return type and once as the `request<T>` argument — and a caller who
    // wants to hold one has nothing to name it.
    if (operation.response && !operation.response.$ref) {
      parts.push(
        `export type ${capitalize(operation.operationId)}Response = ${typeOf(operation.response, '')};\n\n`,
      );
    }
  }

  parts.push('/**\n');
  parts.push(' * Every operation in the emitted contract, one method each.\n');
  parts.push(' *\n');
  parts.push(' * Framework-free on purpose: `api-client` may depend on nothing (spec 2.2), so\n');
  parts.push(' * this is `fetch` and not `HttpClient`. Wrap it in an injectable in the feature\n');
  parts.push(' * lib that consumes it — that is where Angular belongs.\n');
  parts.push(' */\n');
  parts.push('export class LedgerlineApi {\n');
  parts.push('  private readonly baseUrl: string;\n');
  parts.push('  private readonly fetchImpl: FetchLike;\n\n');
  parts.push('  constructor(options: LedgerlineApiOptions = {}) {\n');
  parts.push("    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\\/$/, '');\n");
  parts.push('    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);\n');
  parts.push('  }\n');

  for (const operation of operations) {
    parts.push('\n');
    parts.push(emitMethod(operation));
  }

  parts.push('}\n');

  // Written last, because the import list is only known once every type
  // expression has been emitted.
  const schemaNames = Object.keys(document.components?.schemas ?? {});
  const imports = schemaNames.filter((name) => referenced.has(name));
  const importLine =
    imports.length === 0
      ? ''
      : `import type {\n${imports.map((name) => `  ${name},`).join('\n')}\n} from './schemas.js';\n`;

  return `${BANNER}\n${importLine}${RUNTIME(document)}${parts.join('')}`;
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function emitMethod(operation) {
  const args = [];
  for (const parameter of operation.pathParams) {
    args.push(`${parameter.name}: ${typeOf(parameter.schema, '    ')}`);
  }
  if (operation.body) {
    const bodyType = operation.body.$ref
      ? refName(operation.body.$ref)
      : `${capitalize(operation.operationId)}Body`;
    args.push(`body${operation.bodyRequired ? '' : '?'}: ${bodyType}`);
  }
  if (operation.queryParams.length > 0) {
    args.push(`query: ${capitalize(operation.operationId)}Query = {}`);
  }

  const returnType = !operation.response
    ? 'unknown'
    : operation.response.$ref
      ? refName(operation.response.$ref)
      : `${capitalize(operation.operationId)}Response`;

  // The path template becomes a template literal with the params substituted.
  // `encodeURIComponent` on every one: an id is opaque above `data` and may
  // contain anything a surrogate generator produced.
  const url = operation.path.replace(
    /\{([^}]+)\}/g,
    (_m, name) => `\${encodeURIComponent(String(${name}))}`,
  );

  const doc = [operation.summary, operation.description].filter(Boolean).join('\n\n');

  const lines = [];
  lines.push(docComment({ description: doc }, '  '));
  lines.push(`  ${operation.operationId}(${args.join(', ')}): Promise<${returnType}> {\n`);
  lines.push(
    `    return this.request<${returnType}>(${quote(operation.method.toUpperCase())}, \`${url}\`, {\n`,
  );
  if (operation.queryParams.length > 0) lines.push('      query,\n');
  if (operation.body) lines.push('      body,\n');
  lines.push('    });\n');
  lines.push('  }\n');
  return lines.join('');
}

/** The hand-written runtime — emitted, so nothing under `src/` is hand-edited. */
function RUNTIME(document) {
  const description = (document.info?.description ?? '').replace(/\n/g, ' ');
  return `
/** Where the API listens by default (spec 2.1: it binds loopback, never 0.0.0.0). */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:4310';

/** Base path every operation in spec 2.3's table is mounted under. */
export const API_BASE_PATH = '/api';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface LedgerlineApiOptions {
  /** Defaults to \`DEFAULT_BASE_URL\`. */
  readonly baseUrl?: string;
  /** Injectable for tests. Defaults to the global \`fetch\`. */
  readonly fetch?: FetchLike;
}

/**
 * A non-2xx response, carrying the API's own error body.
 *
 * The API declares one error shape on every route that can fail (\`ApiError\`), and
 * \`error\` there is documented as a "stable machine-readable code". Throwing the
 * parsed body rather than a bare status is what lets a caller branch on the code
 * instead of on prose that may be reworded.
 */
export class LedgerlineApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError | null,
    message: string
  ) {
    super(message);
    this.name = 'LedgerlineApiError';
  }

  /** The machine-readable code, when the API sent one. */
  get code(): string | null {
    return this.body?.error ?? null;
  }
}

/**
 * ${description}
 */
function buildQuery(query: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    // An array parameter is comma-joined, because that is how the API declares
    // every list filter it accepts: \`accountIds\` is one string of ids, not
    // repeated keys (see \`GET /api/transactions\`).
    search.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const encoded = search.toString();
  return encoded === '' ? '' : \`?\${encoded}\`;
}

interface RequestOptions {
  /** \`object\` rather than \`Record<string, unknown>\`: the generated query
   *  interfaces have \`readonly\` properties and no index signature, which makes
   *  them unassignable to a \`Record\`. \`Object.entries\` needs neither. */
  readonly query?: object;
  readonly body?: unknown;
}

`;
}

const REQUEST_METHOD = `
  // ------------------------------------------------------------ plumbing ---

  private async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {}
  ): Promise<T> {
    const response = await this.fetchImpl(
      \`\${this.baseUrl}\${path}\${buildQuery(options.query ?? {})}\`,
      {
        method,
        headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      }
    );

    if (!response.ok) {
      let body: ApiError | null = null;
      try {
        body = (await response.json()) as ApiError;
      } catch {
        body = null;
      }
      throw new LedgerlineApiError(
        response.status,
        body,
        body?.message ?? \`\${method} \${path} failed with \${response.status}\`
      );
    }

    // 204 has no body, and \`DELETE\` may legitimately return one.
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text === '' ? undefined : JSON.parse(text)) as T;
  }
`;

// ------------------------------------------------------------------- main ---

function generate(document) {
  const operations = emitOperations(document);
  // The private request helper goes in last, after the generated methods, so the
  // class reads as its API first and its plumbing second.
  const withRequest = operations.replace(/\n\}\n$/, `${REQUEST_METHOD}}\n`);

  return new Map([
    ['lib/schemas.ts', emitSchemas(document)],
    ['lib/api-client.ts', `${withRequest}`],
    [
      'index.ts',
      `${BANNER}
export * from './lib/schemas.js';
export * from './lib/api-client.js';
`,
    ],
  ]);
}

function main() {
  if (!existsSync(OPENAPI)) {
    process.stderr.write(
      `${OPENAPI} is missing. Run \`npx nx build ledgerline-api\` to emit it.\n`,
    );
    process.exit(1);
  }

  const document = JSON.parse(readFileSync(OPENAPI, 'utf8'));
  const files = generate(document);
  const check = process.argv.includes('--check');
  const stale = [];

  for (const [relative, contents] of files) {
    const target = join(OUT_DIR, relative);

    if (check) {
      const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
      if (current !== contents) stale.push(relative);
      continue;
    }

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, 'utf8');
  }

  if (check) {
    if (stale.length > 0) {
      process.stderr.write(
        `api-client is stale against openapi.json:\n${stale
          .map((file) => `  - src/${file}`)
          .join('\n')}\n\nRegenerate with: npx nx generate-client api-client\n`,
      );
      process.exit(1);
    }
    process.stdout.write('api-client matches openapi.json\n');
    return;
  }

  process.stdout.write(
    `api-client generated from openapi.json:\n${[...files.keys()]
      .map((file) => `  - src/${file}`)
      .join('\n')}\n`,
  );
}

main();
