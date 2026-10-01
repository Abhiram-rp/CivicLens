import { Component } from '@angular/core';
import { NotYet } from '../../shared/not-yet';

/**
 * UsersPage - scaffold placeholder.
 *
 * The route, its title, its guard and its lazy chunk are real; the screen is not
 * built yet. Scheduled for P2 per SPEC 15. The operations listed by
 * `app-not-yet` are the contract surface this screen will call.
 *
 * The phase here is a judgement call on a thin spec, so the reasoning is worth
 * writing down. SPEC.md 546 lists "Auth, roles" in P1, which could be read as
 * covering this screen. The deciding constraint is `createUser`: the contract
 * requires a `departmentId` for every `FIELD_OFFICER` and `DEPARTMENT_MANAGER`, and
 * departments are a P2 deliverable that PLAN.md 174 puts explicitly out of scope for
 * P1. In P1 there are no departments, so there is nothing meaningful to create a
 * staff account into. Sign-in and the role model are P1; administering the staff
 * list is not.
 *
 * Navigation is the shell's business, so this page contributes content only.
 */
@Component({
  selector: 'app-users-page',
  imports: [NotYet],
  template: `
    <app-not-yet [phase]="'P2'" [operations]="operations" />
  `,
})
export class UsersPage {
  protected readonly operations: ReadonlyArray<string> = ['listUsers', 'createUser', 'changeUserRole', 'changeUserStatus'];
}
