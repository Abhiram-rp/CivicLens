import { Component } from '@angular/core';
import { CitizenShell } from '../../layouts/citizen-shell';
import { NotYet } from '../../shared/not-yet';

/**
 * ContactVerifyPage - scaffold placeholder.
 *
 * The route, its title, its guard and its lazy chunk are real; the screen is not
 * built yet. Scheduled for P1 per SPEC 15. The operations listed by
 * `app-not-yet` are the contract surface this screen will call.
 *
 * Navigation is the shell's business, so this page contributes content only.
 */
@Component({
  selector: 'app-contact-verify-page',
  imports: [CitizenShell, NotYet],
  template: `
    <app-citizen-shell>
      <app-not-yet [phase]="'P1'" [operations]="operations" />
    </app-citizen-shell>
  `,
})
export class ContactVerifyPage {
  protected readonly operations: ReadonlyArray<string> = ['verifyContact'];
}
