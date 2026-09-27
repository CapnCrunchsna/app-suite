import { basisFor, productLabel, productProblems } from './product.js';

describe('products', () => {
  it('takes the nutrition basis from the unit (§4)', () => {
    expect(basisFor('COUNT')).toBe('PER_UNIT');
    expect(basisFor('G')).toBe('PER_100');
    expect(basisFor('ML')).toBe('PER_100');
  });

  it('names what stops a draft from saving', () => {
    expect(productProblems({ name: 'Oats', packageAmount: 1000, kcal: null, proteinG: null })).toEqual([]);
    expect(productProblems({ name: ' ', packageAmount: NaN, kcal: -1, proteinG: 3 })).toEqual(['name', 'packageAmount', 'kcal']);
  });

  it('shows a brand only when the name does not already say it', () => {
    expect(productLabel({ name: 'Large Eggs', brand: 'Kirkland' })).toBe('Large Eggs · Kirkland');
    expect(productLabel({ name: 'Nutella', brand: 'Nutella' })).toBe('Nutella');
    expect(productLabel({ name: 'Quaker Rolled Oats', brand: 'quaker' })).toBe('Quaker Rolled Oats');
    expect(productLabel({ name: 'Milk', brand: null })).toBe('Milk');
  });
});
