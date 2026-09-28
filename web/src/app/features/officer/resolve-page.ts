import { Component } from '@angular/core';
import { OfficerShell } from '../../layouts/officer-shell';
import { NotYet } from '../../shared/not-yet';

/**
 * ResolvePage - scaffold placeholder.
 *
 * The route, its title, its guard and its lazy chunk are real; the screen is not
 * built yet. Scheduled for P2 per SPEC 15. The operations listed by
 * `app-not-yet` are the contract surface this screen will call.
 *
 * Navigation is the shell's business, so this page contributes content only.
 */
@Component({
  selector: 'app-resolve-page',
  imports: [OfficerShell, NotYet],
  template: `
    <app-officer-shell>
      <app-not-yet [phase]="'P2'" [operations]="operations" />
    </app-officer-shell>
  `,
})
export class ResolvePage {
  protected readonly operations: ReadonlyArray<string> = ['resolveIssue'];
}
