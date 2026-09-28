import { Component } from '@angular/core';
import { AdminShell } from '../../layouts/admin-shell';
import { NotYet } from '../../shared/not-yet';

/**
 * CategoriesPage - scaffold placeholder.
 *
 * The route, its title, its guard and its lazy chunk are real; the screen is not
 * built yet. Scheduled for P1 per SPEC 15. The operations listed by
 * `app-not-yet` are the contract surface this screen will call.
 *
 * Navigation is the shell's business, so this page contributes content only.
 */
@Component({
  selector: 'app-categories-page',
  imports: [AdminShell, NotYet],
  template: `
    <app-admin-shell>
      <app-not-yet [phase]="'P1'" [operations]="operations" />
    </app-admin-shell>
  `,
})
export class CategoriesPage {
  protected readonly operations: ReadonlyArray<string> = ['listCategories', 'createCategory', 'updateCategory', 'deleteCategory'];
}
