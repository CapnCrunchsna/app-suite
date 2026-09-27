import type { HttpGet } from './http.js';
import { lookupOpenFoodFacts, offProductUrl } from './open-food-facts.js';
import { parsePackageQuantity } from './package-quantity.js';

const respond =
  (status: number, body: unknown): HttpGet =>
  async () => ({ status, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('parsePackageQuantity', () => {
  it.each([
    ['500 g', 'G', 500],
    ['1 L', 'ML', 1000],
    ['12', 'COUNT', 12],
    ['2 x 150 g', 'G', 300],
    ['6 × 330 ml', 'ML', 1980],
    ['1,5 kg', 'G', 1500],
    ['330ml', 'ML', 330],
    ['12 oz (340 g)', 'G', 340.2],
    ['16 fl oz', 'ML', 480],
    ['12 eggs', 'COUNT', 12],
    ['75 cl', 'ML', 750],
  ] as const)('reads %j as %s %d', (text, unit, amount) => {
    expect(parsePackageQuantity(text)).toEqual({ unit, amount });
  });

  it.each([null, '', 'family size', '0 g'])('gives up on %j', (text) => {
    expect(parsePackageQuantity(text)).toBeNull();
  });
});

describe('lookupOpenFoodFacts', () => {
  it('asks for only the fields it reads', () => {
    expect(offProductUrl('0123')).toBe(
      'https://world.openfoodfacts.org/api/v2/product/0123?fields=product_name,brands,quantity,serving_size,nutriments',
    );
  });

  it('prefills a weighed product per 100 g', async () => {
    const result = await lookupOpenFoodFacts(
      respond(200, {
        status: 1,
        product: {
          product_name: ' Rolled Oats ',
          brands: 'Quaker, PepsiCo',
          quantity: '1 kg',
          nutriments: { 'energy-kcal_100g': 379, proteins_100g: 13.15 },
        },
      }),
      '0300',
    );
    expect(result).toEqual({
      kind: 'found',
      prefill: {
        barcode: '0300',
        name: 'Rolled Oats',
        brand: 'Quaker',
        packageUnit: 'G',
        packageAmount: 1000,
        kcal: 379,
        proteinG: 13.2,
        source: 'off',
      },
    });
  });

  it('uses per-serving values for a counted product, never per-100 ones', async () => {
    const result = await lookupOpenFoodFacts(
      respond(200, {
        status: 1,
        product: {
          product_name: 'Large Eggs',
          quantity: '12',
          nutriments: { 'energy-kcal_100g': 143, 'energy-kcal_serving': 72, proteins_100g: 12.6, proteins_serving: 6.3 },
        },
      }),
      '0400',
    );
    expect(result.kind === 'found' && result.prefill).toMatchObject({ packageUnit: 'COUNT', packageAmount: 12, kcal: 72, proteinG: 6.3 });
  });

  it('falls back to kilojoules when kcal is missing', async () => {
    const result = await lookupOpenFoodFacts(
      respond(200, { status: 1, product: { product_name: 'Juice', quantity: '1 l', nutriments: { 'energy-kj_100g': 188 } } }),
      '0500',
    );
    expect(result.kind === 'found' && result.prefill.kcal).toBe(44.9);
  });

  it('leaves what it cannot read blank rather than guessing', async () => {
    const result = await lookupOpenFoodFacts(respond(200, { status: 1, product: { quantity: 'family size' } }), '0600');
    expect(result.kind === 'found' && result.prefill).toMatchObject({
      name: '',
      brand: null,
      packageUnit: null,
      packageAmount: null,
      kcal: null,
      proteinG: null,
    });
  });

  it('tells "not in the database" apart from "could not ask"', async () => {
    expect(await lookupOpenFoodFacts(respond(404, { status: 0 }), '1')).toEqual({ kind: 'not-found' });
    expect(await lookupOpenFoodFacts(respond(200, { status: 0, status_verbose: 'product not found' }), '1')).toEqual({
      kind: 'not-found',
    });
    expect(await lookupOpenFoodFacts(respond(503, 'busy'), '1')).toEqual({
      kind: 'unreachable',
      reason: 'Open Food Facts answered 503',
    });
    const offline: HttpGet = async () => {
      throw new Error('Unable to resolve host');
    };
    expect(await lookupOpenFoodFacts(offline, '1')).toEqual({ kind: 'unreachable', reason: 'Unable to resolve host' });
  });

  it('passes the caller’s headers through', async () => {
    let seen: Readonly<Record<string, string>> | undefined;
    const http: HttpGet = async (_url, headers) => {
      seen = headers;
      return { status: 404, body: '' };
    };
    await lookupOpenFoodFacts(http, '1', { 'User-Agent': 'MetrumMealPlanner/0.1 (+https://example.test)' });
    expect(seen).toEqual({ 'User-Agent': 'MetrumMealPlanner/0.1 (+https://example.test)' });
  });
});
