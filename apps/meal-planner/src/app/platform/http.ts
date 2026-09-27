/**
 * The app's `HttpGet` (libs/meal-planner/import): `CapacitorHttp` on a phone, `fetch` in
 * the browser build.
 *
 * Native requests go through the OS network stack, which is what lets recipe pages be
 * fetched at all (§8: recipe sites send no CORS headers) and lets Open Food Facts see a
 * real `User-Agent`. The browser build cannot set that header and cannot read most recipe
 * pages; Open Food Facts serves CORS, so barcode lookups still work there.
 */

import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { HttpGet } from '@metrum/meal-planner-import';

/**
 * Open Food Facts asks every client to identify itself. The contact is a project URL on
 * purpose (spec §7): every install sends it, so it must not be anyone's email address.
 */
export const APP_CONTACT = 'https://github.com/CapnCrunchsna';
export const USER_AGENT = `MetrumMealPlanner/0.1 (+${APP_CONTACT})`;

const TIMEOUT_MS = 15_000;

export const isNative = (): boolean => Capacitor.isNativePlatform();

export const httpGet: HttpGet = (url, headers) => (isNative() ? nativeGet(url, headers) : webGet(url, headers));

/** Headers for Open Food Facts; none on the web, where the browser owns `User-Agent`. */
export function offHeaders(): Record<string, string> | undefined {
  return isNative() ? { 'User-Agent': USER_AGENT } : undefined;
}

async function nativeGet(url: string, headers?: Readonly<Record<string, string>>) {
  const response = await CapacitorHttp.get({
    url,
    headers: { ...headers },
    responseType: 'text',
    connectTimeout: TIMEOUT_MS,
    readTimeout: TIMEOUT_MS,
  });
  const body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data ?? '');
  return { status: response.status, body };
}

async function webGet(url: string, headers?: Readonly<Record<string, string>>) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const allowed = Object.entries(headers ?? {}).filter(([name]) => name.toLowerCase() !== 'user-agent');
    const response = await fetch(url, { headers: allowed, signal: controller.signal });
    return { status: response.status, body: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}
