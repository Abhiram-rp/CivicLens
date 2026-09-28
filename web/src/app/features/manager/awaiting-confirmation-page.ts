import { Component } from '@angular/core';
import { ManagerShell } from '../../layouts/manager-shell';
import { NotYet } from '../../shared/not-yet';

/**
 * AwaitingConfirmationPage - scaffold placeholder.
 *
 * The route, its title, its guard and its lazy chunk are real; the screen is not
 * built yet. Scheduled for P1 per SPEC 15. The operations listed by
 * `app-not-yet` are the contract surface this screen will call.
 *
 * Navigation is the shell's business, so this page contributes content only.
 */
@Component({
  selector: 'app-awaiting-confirmation-page',
  imports: [ManagerShell, NotYet],
  template: `
    <app-manager-shell>
      <app-not-yet [phase]="'P1'" [operations]="operations" />
    </app-manager-shell>
  `,
})
export class AwaitingConfirmationPage {
  protected readonly operations: ReadonlyArray<string> = ['listIssues', 'confirmResolution'];
}
