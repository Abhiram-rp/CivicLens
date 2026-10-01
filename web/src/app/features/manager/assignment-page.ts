import { Component } from '@angular/core';
import { NotYet } from '../../shared/not-yet';

/**
 * AssignmentPage - scaffold placeholder.
 *
 * The route, its title, its guard and its lazy chunk are real; the screen is not
 * built yet. Scheduled for P2 per SPEC 15 - "Departments + routing, assignment" is a
 * P2 deliverable. Assignment cannot work in P1 in principle, not just in practice:
 * SPEC 78 notes the officer split only activates in P2 "when departments exist", so
 * in P1 a manager triages unassigned work by hand.
 *
 * The operations listed by `app-not-yet` are the contract surface this screen will
 * call.
 *
 * Navigation is the shell's business, so this page contributes content only.
 */
@Component({
  selector: 'app-assignment-page',
  imports: [NotYet],
  template: `
    <app-not-yet [phase]="'P2'" [operations]="operations" />
  `,
})
export class AssignmentPage {
  protected readonly operations: ReadonlyArray<string> = ['assignIssue', 'listUsers'];
}
