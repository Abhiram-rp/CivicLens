import { Component } from '@angular/core';
import { NotYet } from '../../shared/not-yet';

/**
 * CategoriesPage - scaffold placeholder.
 *
 * The route, its title, its guard and its lazy chunk are real; the screen is not
 * built yet. Scheduled for P2 per SPEC 15. The operations listed by
 * `app-not-yet` are the contract surface this screen will call.
 *
 * No `deleteCategory`: a category is retired through `updateCategory` with
 * `active: false`, never deleted, because the rows on `issues.category_id` have to
 * stay readable. This list previously named `deleteCategory`, which does not exist -
 * the contract's only DELETE is `deleteComment`. Anyone building this screen from the
 * placeholder text would have gone looking for an operation the API can never serve.
 *
 * Navigation is the shell's business, so this page contributes content only.
 */
@Component({
  selector: 'app-categories-page',
  imports: [NotYet],
  template: `
    <app-not-yet [phase]="'P2'" [operations]="operations" />
  `,
})
export class CategoriesPage {
  protected readonly operations: ReadonlyArray<string> = ['listCategories', 'createCategory', 'updateCategory'];
}
