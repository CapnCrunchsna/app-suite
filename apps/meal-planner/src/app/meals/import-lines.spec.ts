import type { Product } from '@metrum/meal-planner-domain';
import { lineFor } from '@metrum/meal-planner-import';
import { blocking, initialLine, lineStatus, relink, toDraft } from './import-lines';

const product = (id: string, name: string, packageUnit: Product['packageUnit'], packageAmount: number) =>
  ({ id, name, packageUnit, packageAmount }) as Product;

const cheddar = product('cheddar', 'Cheddar Cheese', 'G', 227);
const milk = product('milk', 'Milk', 'ML', 2000);
const eggs = product('eggs', 'Eggs', 'COUNT', 12);
const beans = product('beans', 'Black beans', 'G', 425);
const paprika = product('paprika', 'Paprika', 'G', 50);
const catalog = [cheddar, milk, eggs, beans, paprika];

const line = (text: string, p: Product | null, key = 1) => initialLine(key, lineFor(text, catalog), p);

describe('import review lines', () => {
  it('converts a direct amount without asking', () => {
    const l = line('1 cup milk', milk);
    expect(l.quantity).toBe('240');
    expect(lineStatus(l)).toBe('linked');
    expect(toDraft(l)).toEqual({ productId: 'milk', quantity: 240, unit: 'ML', displayText: '1 cup milk', toTaste: false });
  });

  it('holds a cup of cheese as an estimate until confirmed (§6 rule 3)', () => {
    const l = line('2 cups shredded cheddar cheese', cheddar);
    expect(l.quantity).toBe('226');
    expect(l.estimate).toMatch(/cup/);
    expect(lineStatus(l)).toBe('estimated');
    expect(blocking([l])).toBe(1);
    expect(blocking([{ ...l, estimate: null }])).toBe(0);
  });

  it('reads a can of something sold by weight as one package, as an estimate', () => {
    const l = line('1 (15 oz) can black beans, drained', beans);
    expect(l.quantity).toBe('425');
    expect(lineStatus(l)).toBe('estimated');
  });

  it('asks for an amount it cannot convert', () => {
    const l = line('1 tbsp paprika', paprika);
    expect(l.quantity).toBe('');
    expect(lineStatus(l)).toBe('needs-amount');
    expect(blocking([l])).toBe(1);
  });

  it('keeps unlinked and to-taste lines as text that counts nothing, and does not block', () => {
    const unlinked = line('1 bay leaf', null);
    const salt = line('Salt to taste', eggs);
    expect(lineStatus(unlinked)).toBe('unlinked');
    expect(lineStatus(salt)).toBe('to-taste');
    expect(salt.product).toBeNull();
    expect(blocking([unlinked, salt])).toBe(0);
    expect(toDraft(salt)).toEqual({ productId: null, quantity: null, unit: null, displayText: 'Salt to taste', toTaste: true });
  });

  it('recomputes the amount from the recipe’s words when re-linked', () => {
    const l = relink(line('3 large eggs', null), eggs);
    expect(l.quantity).toBe('3');
    expect(lineStatus(l)).toBe('linked');
  });
});
