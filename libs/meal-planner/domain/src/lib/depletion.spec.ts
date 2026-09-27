import { planDepletion, type StockRow } from './depletion.js';
import { perServingNeeds } from './pantry.js';

const row = (id: string, quantity: number, expiresOn: string | null, acquiredAt = '2026-09-01T00:00:00Z'): StockRow => ({
  id,
  quantity,
  expiresOn,
  acquiredAt,
});

describe('T2 — decrement (the pure half; the data lib runs it against SQLite)', () => {
  it('takes 2 eggs from 9 and 240 ml from 2000', () => {
    expect(planDepletion([row('eggs', 9, null)], 2)).toEqual({ decrements: [{ rowId: 'eggs', from: 9, to: 7 }], shortBy: 0 });
    expect(planDepletion([row('milk', 2000, null)], 240)).toEqual({
      decrements: [{ rowId: 'milk', from: 2000, to: 1760 }],
      shortBy: 0,
    });
  });

  it('draws one serving of a two-serving recipe: 4 eggs listed is 2 eggs cooked', () => {
    const needs = perServingNeeds([{ productId: 'eggs', quantity: 4, toTaste: false }], 2);
    expect(needs.get('eggs')).toBe(2);
    expect(planDepletion([row('eggs', 7, null)], needs.get('eggs') ?? 0).decrements[0].to).toBe(5);
  });
});

describe('§11 ordering', () => {
  it('uses the soonest expiry first and undated rows last', () => {
    const plan = planDepletion(
      [row('undated', 5, null), row('later', 5, '2026-10-10'), row('sooner', 5, '2026-10-01')],
      7,
    );
    expect(plan.decrements).toEqual([
      { rowId: 'sooner', from: 5, to: 0 },
      { rowId: 'later', from: 5, to: 3 },
    ]);
  });

  it('breaks an expiry tie on the oldest purchase', () => {
    const plan = planDepletion(
      [row('new', 5, null, '2026-09-20T00:00:00Z'), row('old', 5, null, '2026-09-01T00:00:00Z')],
      1,
    );
    expect(plan.decrements).toEqual([{ rowId: 'old', from: 5, to: 4 }]);
  });

  it('clamps at zero and reports what ran short', () => {
    const plan = planDepletion([row('eggs', 1, null)], 3);
    expect(plan.decrements).toEqual([{ rowId: 'eggs', from: 1, to: 0 }]);
    expect(plan.shortBy).toBe(2);
  });
});
