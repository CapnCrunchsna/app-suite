import type { HttpGet } from './http.js';
import { searchUsda, usdaSearchUrl } from './usda.js';

const reply =
  (status: number, body: unknown): HttpGet =>
  async () => ({ status, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('searchUsda', () => {
  it('builds the §7 URL', () => {
    expect(usdaSearchUrl('k&y', 'rolled oats')).toBe(
      'https://api.nal.usda.gov/fdc/v1/foods/search?api_key=k%26y&query=rolled%20oats&pageSize=10',
    );
  });

  it('maps kcal (1008) and protein (1003) per 100 g, with no package size', async () => {
    const result = await searchUsda(
      reply(200, {
        foods: [
          {
            description: 'OATS, ROLLED',
            foodNutrients: [
              { nutrientId: 1003, value: 13.2, unitName: 'G' },
              { nutrientId: 1008, value: 379, unitName: 'KCAL' },
            ],
          },
        ],
      }),
      'key',
      'oats',
    );
    expect(result).toEqual({
      kind: 'found',
      foods: [{ barcode: null, name: 'Oats, rolled', brand: null, packageUnit: 'G', packageAmount: null, kcal: 379, proteinG: 13.2, source: 'usda' }],
    });
  });

  it('falls back to the Atwater energy figures, and leaves kcal blank without any', async () => {
    const result = await searchUsda(
      reply(200, {
        foods: [
          { description: 'Lentils', brandOwner: 'Acme', foodNutrients: [{ nutrientId: 2047, value: 352.4, unitName: 'KCAL' }] },
          { description: 'Mystery', foodNutrients: [{ nutrientId: 1062, value: 1000, unitName: 'kJ' }] },
        ],
      }),
      'key',
      'x',
    );
    expect(result.kind === 'found' && result.foods.map((f) => [f.name, f.brand, f.kcal])).toEqual([
      ['Lentils', 'Acme', 352.4],
      ['Mystery', null, null],
    ]);
  });

  it('says when the key is refused, and when nothing came back', async () => {
    expect(await searchUsda(reply(403, ''), 'bad', 'x')).toEqual({ kind: 'unreachable', reason: 'USDA refused the API key. Check it in Settings.' });
    const offline: HttpGet = () => Promise.reject(new Error('offline'));
    expect(await searchUsda(offline, 'key', 'x')).toEqual({ kind: 'unreachable', reason: 'offline' });
  });
});
