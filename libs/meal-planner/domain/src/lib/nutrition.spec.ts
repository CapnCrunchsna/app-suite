import { displayKcal, displayProtein, ingredientNutrition, mealNutritionPerServing, type NutritionProduct } from './nutrition.js';

const EGGS: NutritionProduct = { nutritionBasis: 'PER_UNIT', kcal: 70, proteinG: 6 };
const MILK: NutritionProduct = { nutritionBasis: 'PER_100', kcal: 42, proteinG: 3.4 };
const products = new Map([
  ['eggs', EGGS],
  ['milk', MILK],
]);

describe('T1 — nutrition math', () => {
  it('computes 2 eggs + 240 ml milk as 240.8 kcal and 20.16 g protein', () => {
    const facts = mealNutritionPerServing(
      [
        { productId: 'eggs', quantity: 2, toTaste: false },
        { productId: 'milk', quantity: 240, toTaste: false },
      ],
      products,
      1,
    );
    expect(facts.kcal).toBeCloseTo(240.8, 10);
    expect(facts.protein).toBeCloseTo(20.16, 10);
  });

  it('divides by servings', () => {
    const facts = mealNutritionPerServing([{ productId: 'eggs', quantity: 4, toTaste: false }], products, 2);
    expect(facts).toEqual({ kcal: 140, protein: 12 });
  });

  it('counts to-taste and unmapped lines as nothing', () => {
    expect(ingredientNutrition({ productId: 'milk', quantity: 100, toTaste: true }, MILK)).toEqual({ kcal: 0, protein: 0 });
    expect(ingredientNutrition({ productId: null, quantity: 100, toTaste: false }, undefined)).toEqual({ kcal: 0, protein: 0 });
  });

  it('treats a product with unknown nutrition as zero rather than failing', () => {
    expect(ingredientNutrition({ productId: 'x', quantity: 100, toTaste: false }, { nutritionBasis: 'PER_100', kcal: null, proteinG: null })).toEqual({
      kcal: 0,
      protein: 0,
    });
  });
});

describe('display rounding', () => {
  it('rounds kcal to whole numbers and protein to one decimal', () => {
    expect(displayKcal(240.8)).toBe('241');
    expect(displayProtein(20.16)).toBe('20.2');
    expect(displayProtein(12)).toBe('12');
  });
});
