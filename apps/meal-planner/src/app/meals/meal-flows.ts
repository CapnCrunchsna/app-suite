/**
 * Getting a meal into the library: build one (§10 Meal Builder), or import one from a
 * recipe URL (§8) through the review.
 *
 * URL import needs the phone: recipe sites send no CORS headers, so the browser build
 * cannot read them, and §8 forbids shipping a proxy to get around that. The browser build
 * says so rather than failing with a network error nobody can act on.
 */

import { Injectable, inject } from '@angular/core';
import { AlertController } from '@ionic/angular/alert-controller';
import { LoadingController } from '@ionic/angular/loading-controller';
import { ModalController } from '@ionic/angular/modal-controller';
import type { MealWithIngredients } from '@metrum/meal-planner-data';
import type { Meal } from '@metrum/meal-planner-domain';
import { importRecipe, NoRecipeError, type RecipeImport } from '@metrum/meal-planner-import';
import { Store } from '../data/store';
import { httpGet, isNative } from '../platform/http';
import { ImportReview } from './import-review';
import { MealBuilder } from './meal-builder';

export const WEB_IMPORT_MESSAGE = 'URL import requires the mobile app';

@Injectable({ providedIn: 'root' })
export class MealFlows {
  private readonly modals = inject(ModalController);
  private readonly alerts = inject(AlertController);
  private readonly loading = inject(LoadingController);
  private readonly store = inject(Store);

  async build(existing: MealWithIngredients | null = null): Promise<Meal | null> {
    const modal = await this.modals.create({ component: MealBuilder, componentProps: { existing } });
    await modal.present();
    const { data, role } = await modal.onDidDismiss<Meal>();
    return role === 'saved' && data ? data : null;
  }

  async importFromUrl(): Promise<Meal | null> {
    const url = await this.askForUrl();
    if (!url) return null;

    const { products } = await this.store.ready();
    const catalog = await products.search('', 10_000);
    const spinner = await this.loading.create({ message: 'Reading the recipe…' });
    await spinner.present();
    let recipe: RecipeImport;
    try {
      recipe = await importRecipe(httpGet, url, catalog);
    } catch (error) {
      await spinner.dismiss();
      const message =
        error instanceof NoRecipeError
          ? error.message
          : !isNative()
            ? WEB_IMPORT_MESSAGE
            : error instanceof Error
              ? error.message
              : 'The page could not be read.';
      await this.explain(message);
      return null;
    }
    await spinner.dismiss();

    const review = await this.modals.create({
      component: ImportReview,
      componentProps: { recipe, products: new Map(catalog.map((p) => [p.id, p])) },
    });
    await review.present();
    const { data, role } = await review.onDidDismiss<Meal>();
    return role === 'saved' && data ? data : null;
  }

  private async askForUrl(): Promise<string | null> {
    const alert = await this.alerts.create({
      header: 'Import from URL',
      message: 'Paste the address of a recipe page.',
      inputs: [{ name: 'url', type: 'url', placeholder: 'https://…' }],
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Import', role: 'confirm' },
      ],
    });
    await alert.present();
    const { data, role } = await alert.onDidDismiss<{ values: { url?: string } }>();
    if (role !== 'confirm') return null;
    const url = (data?.values.url ?? '').trim();
    if (!/^https?:\/\/\S+$/i.test(url)) {
      await this.explain('That doesn’t look like a web address. It should start with https://');
      return null;
    }
    return url;
  }

  private async explain(message: string): Promise<void> {
    const alert = await this.alerts.create({ header: 'Couldn’t import', message, buttons: ['OK'] });
    await alert.present();
    await alert.onDidDismiss();
  }
}
