import { Component } from '@angular/core';
import { NotYet } from '../../shared/not-yet';

/**
 * AwaitingConfirmationPage - scaffold placeholder.
 *
 * The route, its title, its guard and its lazy chunk are real; the screen is not
 * built yet. Scheduled for P2 per SPEC 15 - "confirmations" is listed among the P2
 * deliverables.
 *
 * Worth being precise about which "confirmation" this is, because the P1 ship gate
 * does include the reporter disputing a resolution and watching it reopen. What
 * ships in P1 is the *reporter's* side of that flow, on their own report. This
 * screen is the staff-side queue of resolutions waiting on a reporter, which is the
 * follow-the-up-work piece and lands in P2.
 *
 * The operations listed by `app-not-yet` are the contract surface this screen will
 * call.
 *
 * Navigation is the shell's business, so this page contributes content only.
 */
@Component({
  selector: 'app-awaiting-confirmation-page',
  imports: [NotYet],
  template: `
    <app-not-yet [phase]="'P2'" [operations]="operations" />
  `,
})
export class AwaitingConfirmationPage {
  protected readonly operations: ReadonlyArray<string> = ['listIssues', 'confirmResolution'];
}
