import { Component } from '@angular/core';
import { NotYet } from '../../shared/not-yet';

/**
 * DuplicateReviewPage - scaffold placeholder.
 *
 * The route, its title, its guard and its lazy chunk are real; the screen is not
 * built yet. Scheduled for P2 per SPEC 15. The operations listed by
 * `app-not-yet` are the contract surface this screen will call.
 *
 * P2 is correct and already was. SPEC 453 puts rule-based duplicate flagging in P2
 * ("same category + within 150 m + open status, surfaced to a manager as SUGGESTED
 * rows. Never auto-merged"), and SPEC 453 is also why these three operations exist in
 * a contract at all: nothing generates a match in P1, so a reviewer would have an
 * empty queue.
 *
 * Navigation is the shell's business, so this page contributes content only.
 */
@Component({
  selector: 'app-duplicate-review-page',
  imports: [NotYet],
  template: `
    <app-not-yet [phase]="'P2'" [operations]="operations" />
  `,
})
export class DuplicateReviewPage {
  protected readonly operations: ReadonlyArray<string> = ['listDuplicates', 'confirmDuplicate', 'rejectDuplicate'];
}
