import { Route } from '@angular/router';
import { ledgerlineRoutes } from '@metrum/ledgerline-feature-shell';

/**
 * The shell's route table is the feature lib's route table.
 *
 * §2.2 keeps this app a shell — "Shell only" — and that means it holds chrome and
 * routing while §6's pages live in `libs/ledgerline/feature-shell`. The routes come
 * from there too, so adding a page is a change in the lib rather than a change here
 * plus a change there.
 */
export const appRoutes: Route[] = ledgerlineRoutes;
