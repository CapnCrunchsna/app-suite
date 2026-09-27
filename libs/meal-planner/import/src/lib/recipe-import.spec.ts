/**
 * meal-planner-spec.md §14 T3 (parser), T4 (matcher) and T8 (JSON-LD), plus the pipeline.
 */

import type { HttpGet } from './http.js';
import { parseIngredient } from './ingredient-parser.js';
import { autoMatch, jaccard, matchTokens, rankProducts } from './matcher.js';
import { RecipeImportError, importRecipe } from './recipe-import.js';
import { NO_RECIPE_MESSAGE, NoRecipeError, decodeEntities, extractRecipe } from './recipe-jsonld.js';

describe('T3 — ingredient parser', () => {
  it('reads "2 cups shredded cheddar cheese" as 480 ml, for the density step to confirm', () => {
    expect(parseIngredient('2 cups shredded cheddar cheese')).toEqual({
      qty: 480,
      unit: 'ML',
      rawUnit: 'cup',
      name: 'shredded cheddar cheese',
      note: null,
      toTaste: false,
    });
  });

  it('reads "1 (15 oz) can black beans, drained" as one can with both notes', () => {
    expect(parseIngredient('1 (15 oz) can black beans, drained')).toEqual({
      qty: 1,
      unit: 'COUNT',
      rawUnit: 'can',
      name: 'black beans',
      note: '15 oz; drained',
      toTaste: false,
    });
  });

  it('reads "3 large eggs" as a count with no unit word', () => {
    expect(parseIngredient('3 large eggs')).toEqual({
      qty: 3,
      unit: 'COUNT',
      rawUnit: null,
      name: 'large eggs',
      note: null,
      toTaste: false,
    });
  });

  it('reads "½ cup milk" as 120 ml', () => {
    expect(parseIngredient('½ cup milk')).toMatchObject({ qty: 120, unit: 'ML', rawUnit: 'cup', name: 'milk' });
  });

  it('reads "1 1/2 lbs ground beef" as 680.4 g', () => {
    expect(parseIngredient('1 1/2 lbs ground beef')).toMatchObject({ qty: 680.4, unit: 'G', rawUnit: 'lb', name: 'ground beef' });
  });

  it('reads "Salt to taste" as to-taste with no quantity', () => {
    expect(parseIngredient('Salt to taste')).toEqual({
      qty: null,
      unit: null,
      rawUnit: null,
      name: 'salt',
      note: null,
      toTaste: true,
    });
  });

  it('parses a bare fraction as a fraction, which the spec’s original regex could not', () => {
    expect(parseIngredient('3/4 cup sugar')).toMatchObject({ qty: 180, unit: 'ML', name: 'sugar' });
  });

  it.each([
    ['1½ cups flour', 360],
    ['1 ½ cups flour', 360],
    ['2-3 tbsp olive oil', 30],
    ['2 to 3 tbsp olive oil', 30],
  ])('reads %j', (line, qty) => {
    expect(parseIngredient(line).qty).toBe(qty);
  });

  it('keeps unit-like words that are not units in the name', () => {
    expect(parseIngredient('2 garlic cloves, minced')).toMatchObject({ qty: 2, rawUnit: null, name: 'garlic cloves', note: 'minced' });
    expect(parseIngredient('2 cloves garlic')).toMatchObject({ qty: 2, rawUnit: 'clove', name: 'garlic' });
    expect(parseIngredient('1 tsp. vanilla extract')).toMatchObject({ qty: 5, rawUnit: 'tsp', name: 'vanilla extract' });
    expect(parseIngredient('8 fl oz chicken stock')).toMatchObject({ qty: 240, rawUnit: 'floz', name: 'chicken stock' });
  });

  it('reads the nested notes recipe plugins write, seen on a live page', () => {
    expect(parseIngredient('120g (4oz) bacon (, excess fat trimmed, chopped (Note 1))')).toEqual({
      qty: 120,
      unit: 'G',
      rawUnit: 'g',
      name: 'bacon',
      note: '4oz; Note 1; excess fat trimmed, chopped',
      toTaste: false,
    });
    expect(parseIngredient('1 small carrot* (, peeled and diced)')).toMatchObject({ qty: 1, name: 'small carrot', note: 'peeled and diced' });
    expect(parseIngredient('lemon wedges to serve (optional)')).toMatchObject({ name: 'lemon wedges', toTaste: true });
  });

  it('strips a leading "of" and flags garnish lines', () => {
    expect(parseIngredient('1 pinch of salt')).toMatchObject({ qty: 1, rawUnit: 'pinch', name: 'salt' });
    expect(parseIngredient('Parsley, for garnish')).toMatchObject({ name: 'parsley', toTaste: true, qty: null });
  });
});

describe('T4 — product matcher', () => {
  const products = [
    { id: 'cheddar', name: 'Cheddar Cheese Block' },
    { id: 'mozz', name: 'Mozzarella' },
    { id: 'milk', name: 'Milk' },
  ];

  it('scores {cheddar, cheese} against {cheddar, cheese, block} at 2/3 and auto-maps', () => {
    expect(matchTokens('shredded cheddar cheese')).toEqual(new Set(['cheddar', 'cheese']));
    const ranked = rankProducts('shredded cheddar cheese', products);
    expect(ranked).toEqual([{ productId: 'cheddar', score: 2 / 3 }]);
    expect(autoMatch(ranked)).toBe('cheddar');
  });

  it('asks when two products are about as good', () => {
    const ranked = rankProducts('cheddar cheese', [
      { id: 'a', name: 'Sharp Cheddar Cheese' },
      { id: 'b', name: 'Mild Cheddar Cheese' },
    ]);
    expect(ranked[0].score).toBeCloseTo(2 / 3, 10);
    expect(autoMatch(ranked)).toBeNull();
  });

  it('asks when the best score is low', () => {
    expect(autoMatch(rankProducts('whole milk yogurt', [{ id: 'milk', name: 'Milk' }]))).toBeNull();
  });

  it('meets plurals halfway: eggs find Egg, oats find Rolled Oats', () => {
    expect(autoMatch(rankProducts('large eggs', [{ id: 'egg', name: 'Egg' }]))).toBe('egg');
    expect(jaccard(matchTokens('oats'), matchTokens('Oat'))).toBe(1);
    // Stems need not be words, only the same on both sides.
    expect(jaccard(matchTokens('hummus'), matchTokens('Classic Hummus'))).toBe(0.5);
    expect(matchTokens('glass')).toEqual(new Set(['glass']));
  });
});

const page = (...blocks: string[]) =>
  `<html><head>${blocks.map((b) => `<script type="application/ld+json">${b}</script>`).join('')}</head><body>…</body></html>`;

const GRAPH = JSON.stringify({
  '@context': 'https://schema.org',
  '@graph': [
    { '@type': 'WebPage', name: 'Tacos | Example Kitchen' },
    {
      '@type': ['Recipe', 'NewsArticle'],
      name: 'Weeknight Beef Tacos &amp; Slaw',
      recipeYield: ['4', '4 servings'],
      recipeIngredient: ['1 lb ground beef', '8 corn tortillas', '1 cup salsa', 'Salt to taste'],
      nutrition: { '@type': 'NutritionInformation', calories: '520 calories', proteinContent: '31 g' },
    },
  ],
});

describe('T8 — JSON-LD extraction', () => {
  it('finds a Recipe inside an @graph and reads name, yield and ingredient lines', () => {
    const recipe = extractRecipe(page(GRAPH));
    expect(recipe).toEqual({
      name: 'Weeknight Beef Tacos & Slaw',
      servings: 4,
      ingredients: ['1 lb ground beef', '8 corn tortillas', '1 cup salsa', 'Salt to taste'],
      kcal: 520,
      protein: 31,
    });
  });

  it('fails with exactly the spec’s message when there is no recipe', () => {
    expect(() => extractRecipe(page(JSON.stringify({ '@type': 'WebPage' })))).toThrow(NoRecipeError);
    expect(() => extractRecipe('<html><body>no data</body></html>')).toThrow(NO_RECIPE_MESSAGE);
  });

  it('skips a malformed block and keeps looking', () => {
    expect(extractRecipe(page('{ not json', GRAPH)).servings).toBe(4);
  });

  it('accepts a top-level array and defaults a missing yield to one', () => {
    const recipe = extractRecipe(page(JSON.stringify([{ '@type': 'Recipe', name: 'Toast', recipeIngredient: ['2 slices bread'] }])));
    expect(recipe).toMatchObject({ name: 'Toast', servings: 1, kcal: null, protein: null });
  });

  it('decodes the entities recipe plugins leave in their JSON', () => {
    expect(decodeEntities('&frac12; cup milk &#8211; cold &amp; fresh &#x2019;')).toBe('½ cup milk – cold & fresh ’');
  });
});

describe('importRecipe', () => {
  const products = [
    { id: 'beef', name: 'Ground Beef' },
    { id: 'tortilla', name: 'Corn Tortillas' },
    { id: 'salsa', name: 'Salsa' },
    { id: 'salt', name: 'Salt' },
  ];

  it('parses and ranks every line, and never auto-maps a to-taste line', async () => {
    const http: HttpGet = async () => ({ status: 200, body: page(GRAPH) });
    const result = await importRecipe(http, 'https://example.test/tacos', products);
    expect(result).toMatchObject({ name: 'Weeknight Beef Tacos & Slaw', servings: 4, siteKcal: 520, siteProtein: 31 });
    expect(result.lines.map((l) => l.autoProductId)).toEqual(['beef', 'tortilla', 'salsa', null]);
    expect(result.lines[3].candidates[0]).toEqual({ productId: 'salt', score: 1 });
  });

  it('says why a page could not be read', async () => {
    await expect(importRecipe(async () => ({ status: 403, body: '' }), 'u', products)).rejects.toThrow('This site refused the request (403)');
    await expect(importRecipe(async () => ({ status: 500, body: '' }), 'u', products)).rejects.toThrow('The page answered 500');
    await expect(
      importRecipe(
        async () => {
          throw new Error('Failed to fetch');
        },
        'u',
        products,
      ),
    ).rejects.toThrow(RecipeImportError);
    await expect(importRecipe(async () => ({ status: 200, body: '<html></html>' }), 'u', products)).rejects.toThrow(
      NO_RECIPE_MESSAGE,
    );
  });
});
