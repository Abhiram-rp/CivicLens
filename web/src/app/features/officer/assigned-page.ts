import { Component } from '@angular/core';
import { NotYet } from '../../shared/not-yet';

/**
 * AssignedPage - scaffold placeholder.
 *
 * The route, its title, its guard and its lazy chunk are real; the screen is not
 * built yet. Scheduled for P2 per SPEC 15. The operations listed by
 * `app-not-yet` are the contract surface this screen will call.
 *
 * P2 is right here even though an officer resolving a report is plainly a P1 story,
 * and it is worth recording why so it is not "corrected" upward later. SPEC 78:
 * "P1 exercises CITIZEN + DEPARTMENT_MANAGER ... The officer split activates in P2
 * when departments exist." An "assigned to me" queue has nothing to show until work
 * is routed to a named officer, which needs departments, which are a P2 deliverable
 * (PLAN.md 174).
 *
 * Navigation is the shell's business, so this page contributes content only.
 */
@Component({
  selector: 'app-assigned-page',
  imports: [NotYet],
  template: `
    <app-not-yet [phase]="'P2'" [operations]="operations" />
  `,
})
export class AssignedPage {
  protected readonly operations: ReadonlyArray<string> = ['listIssues', 'changeIssueStatus', 'resolveIssue'];
}
