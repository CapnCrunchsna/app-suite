import { convertForProduct, densityFor, toBase } from './units.js';
import { formatAmount, formatRemaining } from './format.js';
import { fitsWithReserved, pantryStock, shortfalls } from './pantry.js';

describe('§6 conversions', () => {
  it('converts to base units', () => {
    expect(toBase(2, 'cup')).toEqual({ quantity: 480, unit: 'ML' });
    expect(toBase(1.5, 'lb').quantity).toBeCloseTo(680.4, 10);
    expect(toBase(3, null)).toEqual({ quantity: 3, unit: 'COUNT' });
    expect(toBase(1, 'can')).toEqual({ quantity: 1, unit: 'COUNT' });
  });

  it('prefers the more specific density entry', () => {
    expect(densityFor('Creamy Peanut Butter')).toBe(256);
    expect(densityFor('Salted Butter')).toBe(227);
    expect(densityFor('Light Brown Sugar')).toBe(220);
    expect(densityFor('Cheddar Cheese Block')).toBe(113);
    expect(densityFor('Olive Oil')).toBeNull();
  });

  it('applies the four rules', () => {
    expect(convertForProduct(240, 'ML', { packageUnit: 'ML', name: 'Milk' })).toEqual({ kind: 'direct', quantity: 240 });
    expect(convertForProduct(480, 'ML', { packageUnit: 'G', name: 'Shredded Cheddar Cheese' })).toEqual({
      kind: 'confirm',
      quantity: 226,
      gramsPerCup: 113,
    });
    expect(convertForProduct(15, 'ML', { packageUnit: 'G', name: 'Paprika' })).toEqual({ kind: 'ask', unit: 'G' });
    expect(convertForProduct(100, 'G', { packageUnit: 'COUNT', name: 'Eggs' })).toEqual({ kind: 'ask', unit: 'COUNT' });
  });
});

describe('§10 quantity formatting', () => {
  it('matches the spec examples', () => {
    expect(formatRemaining(9, 'COUNT', 12)).toBe('9 of 12');
    expect(formatRemaining(420, 'G', 500)).toBe('420 g of 500 g');
    expect(formatRemaining(1760, 'ML', 2000)).toBe('1.76 L of 2 L');
  });

  it('measures "of" in the whole packages a multi-package purchase still spans', () => {
    expect(formatRemaining(24, 'COUNT', 12)).toBe('24 of 24');
    expect(formatRemaining(21, 'COUNT', 12)).toBe('21 of 24');
    expect(formatRemaining(11, 'COUNT', 12)).toBe('11 of 12');
    expect(formatRemaining(3500, 'ML', 2000)).toBe('3.5 L of 4 L');
  });

  it('gives a product sold singly no "of"', () => {
    expect(formatRemaining(12, 'COUNT', 1)).toBe('12');
  });

  it('formats a lone amount in the larger unit once it passes a thousand', () => {
    expect(formatAmount(240, 'ML')).toBe('240 ml');
    expect(formatAmount(1500, 'G')).toBe('1.5 kg');
    expect(formatAmount(2, 'COUNT')).toBe('2');
  });
});

describe('§5 feasibility', () => {
  it('ignores deleted and empty rows when totalling stock', () => {
    const stock = pantryStock([
      { productId: 'egg', quantity: 6, deletedAt: null },
      { productId: 'egg', quantity: 6, deletedAt: '2026-09-01T00:00:00Z' },
      { productId: 'egg', quantity: 3, deletedAt: null },
      { productId: 'milk', quantity: 0, deletedAt: null },
    ]);
    expect(stock).toEqual(new Map([['egg', 9]]));
  });

  it('names what is short', () => {
    expect(shortfalls(new Map([['egg', 2], ['milk', 100]]), new Map([['egg', 5]]))).toEqual(['milk']);
  });

  it('checks a meal against what the rest of the plan already reserved', () => {
    const stock = new Map([['egg', 3]]);
    expect(fitsWithReserved(new Map([['egg', 2]]), new Map(), stock)).toBe(true);
    expect(fitsWithReserved(new Map([['egg', 2]]), new Map([['egg', 2]]), stock)).toBe(false);
  });
});
