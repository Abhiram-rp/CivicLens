import { Component } from '@angular/core';
import { NotYet } from '../../shared/not-yet';

/**
 * DepartmentsPage - scaffold placeholder.
 *
 * The route, its title, its guard and its lazy chunk are real; the screen is not
 * built yet. Scheduled for P2 per SPEC 15. The operations listed by
 * `app-not-yet` are the contract surface this screen will call.
 *
 * No `deleteDepartment`, for the same reason `categories-page` has no
 * `deleteCategory`: departments are retired with `active: false` and never deleted,
 * so reports already routed to one keep a readable history. PLAN.md 174 puts
 * departments in P2 explicitly.
 *
 * Navigation is the shell's business, so this page contributes content only.
 */
@Component({
  selector: 'app-departments-page',
  imports: [NotYet],
  template: `
    <app-not-yet [phase]="'P2'" [operations]="operations" />
  `,
})
export class DepartmentsPage {
  protected readonly operations: ReadonlyArray<string> = ['listDepartments', 'createDepartment', 'updateDepartment'];
}
