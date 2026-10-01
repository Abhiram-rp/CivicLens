import { Component } from '@angular/core';
import { NotYet } from '../../shared/not-yet';

/**
 * CategoryProposalsPage - scaffold placeholder.
 *
 * The route, its title, its guard and its lazy chunk are real; the screen is not
 * built yet. Scheduled for P2 per SPEC 15 - the "`category_proposals` promotion flow"
 * is a P2 deliverable, and PLAN.md 174 names it explicitly as out of scope for P1.
 *
 * What *is* P1 is the reporter half: SPEC 367 has `proposed_category_text` set when
 * the reporter picks `OTHER`, which "creates nothing; surfaced in the manager's triage
 * queue". A reporter can therefore propose a category in P1; acting on those proposals
 * is what waits for P2.
 *
 * The operations listed by `app-not-yet` are the contract surface this screen will
 * call.
 *
 * Navigation is the shell's business, so this page contributes content only.
 */
@Component({
  selector: 'app-category-proposals-page',
  imports: [NotYet],
  template: `
    <app-not-yet [phase]="'P2'" [operations]="operations" />
  `,
})
export class CategoryProposalsPage {
  protected readonly operations: ReadonlyArray<string> = ['listCategories', 'createCategory'];
}
