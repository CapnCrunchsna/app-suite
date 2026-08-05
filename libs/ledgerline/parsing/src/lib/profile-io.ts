/**
 * Reading a `FormatProfile` out of untrusted JSON.
 *
 * Until the in-app column mapper exists (§6.1, roadmap v0.2), a profile is a file a
 * human wrote by hand, which means every field can be absent, misspelled or the wrong
 * type. Validating structurally here — rather than letting `undefined` flow into the
 * parser — is what turns "my import produced nonsense" into "line 4: amountMode must be
 * 'single' or 'debit_credit'".
 *
 * Hand-rolled rather than schema-library-based to keep `type:parsing` dependency-free.
 */

import type { AccountType } from '@app-suite/ledgerline-domain';

import { validateProfile } from './format-profile.js';
import type { AmountMode, ColumnRef, ColumnRole, FormatProfile, SignConvention } from './format-profile.js';

export type ProfileLoad =
  | { readonly ok: true; readonly profile: FormatProfile; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly errors: readonly string[] };

const COLUMN_ROLES: readonly ColumnRole[] = [
  'transactionDate',
  'postedDate',
  'description',
  'amount',
  'debit',
  'credit',
  'balance',
  'status',
];

const ACCOUNT_TYPES: readonly AccountType[] = ['checking', 'savings', 'credit_card'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A column may be written as a bare string (header name), a bare number (zero-based
 * index), or the explicit `{ by, name | index }` form. The shorthands exist because a
 * profile is hand-edited and `"description": "Description"` is what someone writes
 * without reading documentation first.
 */
function parseColumnRef(raw: unknown, role: string, errors: string[]): ColumnRef | undefined {
  if (raw === undefined || raw === null) return undefined;

  if (typeof raw === 'string') return { by: 'header', name: raw };

  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw < 0) {
      errors.push(`columnMap.${role}: index must be a non-negative integer`);
      return undefined;
    }
    return { by: 'index', index: raw };
  }

  if (isRecord(raw)) {
    if (raw.by === 'header' && typeof raw.name === 'string') {
      return { by: 'header', name: raw.name };
    }
    if (raw.by === 'index' && typeof raw.index === 'number' && Number.isInteger(raw.index) && raw.index >= 0) {
      return { by: 'index', index: raw.index };
    }
  }

  errors.push(
    `columnMap.${role}: expected a header name, a zero-based column index, or { "by": "header", "name": "..." }`
  );
  return undefined;
}

export function loadProfile(raw: unknown): ProfileLoad {
  const errors: string[] = [];

  if (!isRecord(raw)) {
    return { ok: false, errors: ['profile must be a JSON object'] };
  }

  const str = (key: string, fallback?: string): string => {
    const value = raw[key];
    if (typeof value === 'string') return value;
    if (value === undefined && fallback !== undefined) return fallback;
    errors.push(`${key} is required and must be a string`);
    return '';
  };

  const id = str('id');
  const institution = str('institution', '');
  const dateFormat = str('dateFormat');

  const amountModeRaw = raw.amountMode;
  if (amountModeRaw !== 'single' && amountModeRaw !== 'debit_credit') {
    errors.push("amountMode must be 'single' or 'debit_credit'");
  }
  const amountMode = (amountModeRaw ?? 'single') as AmountMode;

  const signRaw = raw.signConvention ?? 'as_is';
  if (signRaw !== 'as_is' && signRaw !== 'invert') {
    errors.push("signConvention must be 'as_is' or 'invert'");
  }
  const signConvention = signRaw as SignConvention;

  const accountTypeRaw = raw.accountTypeHint ?? null;
  if (accountTypeRaw !== null && !ACCOUNT_TYPES.includes(accountTypeRaw as AccountType)) {
    errors.push(`accountTypeHint must be null or one of ${ACCOUNT_TYPES.join(', ')}`);
  }

  const columnMap: Partial<Record<ColumnRole, ColumnRef>> = {};
  const columnMapRaw = raw.columnMap;
  if (!isRecord(columnMapRaw)) {
    errors.push('columnMap is required and must be an object');
  } else {
    for (const key of Object.keys(columnMapRaw)) {
      if (!COLUMN_ROLES.includes(key as ColumnRole) && key !== 'ignore') {
        errors.push(`columnMap.${key} is not a recognized role (${COLUMN_ROLES.join(', ')})`);
      }
    }
    for (const role of COLUMN_ROLES) {
      const ref = parseColumnRef(columnMapRaw[role], role, errors);
      if (ref) columnMap[role] = ref;
    }
  }

  const pendingValues = Array.isArray(raw.pendingValues)
    ? raw.pendingValues.filter((v): v is string => typeof v === 'string')
    : ['pending'];

  const headerTokens = Array.isArray(raw.headerTokens)
    ? raw.headerTokens.filter((v): v is string => typeof v === 'string')
    : [];

  if (errors.length > 0) return { ok: false, errors };

  const profile: FormatProfile = {
    id,
    institution,
    accountTypeHint: (accountTypeRaw as AccountType | null) ?? null,
    headerSignature: typeof raw.headerSignature === 'string' ? raw.headerSignature : '',
    headerTokens,
    hasHeader: raw.hasHeader === undefined ? true : raw.hasHeader === true,
    delimiter: typeof raw.delimiter === 'string' ? raw.delimiter : ',',
    skipLines: typeof raw.skipLines === 'number' && raw.skipLines >= 0 ? Math.trunc(raw.skipLines) : 0,
    dateFormat,
    amountMode,
    signConvention,
    columnMap,
    pendingValues,
    currency: 'USD',
    version: typeof raw.version === 'number' ? raw.version : 1,
    source: raw.source === 'user' ? 'user' : 'seed',
  };

  const validation = validateProfile(profile);
  if (!validation.ok) return { ok: false, errors: validation.errors };

  return { ok: true, profile, warnings: validation.warnings };
}
