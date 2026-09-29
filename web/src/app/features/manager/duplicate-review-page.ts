import { Component } from '@angular/core';
import { NotYet } from '../../shared/not-yet';

/**
 * DuplicateReviewPage - scaffold placeholder.
 *
 * The route, its title, its guard and its lazy chunk are real; the screen is not
 * built yet. Scheduled for P2 per SPEC 15. The operations listed by
 * `app-not-yet` are the contract surface this screen will call.
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
