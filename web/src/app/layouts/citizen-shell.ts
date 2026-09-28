import { Component } from '@angular/core';
import { AppShell } from './app-shell';

/**
 * The citizen-facing shell.
 *
 * Signed out, this is the entry point to the whole product, so the nav is the
 * public surface: report an issue, and track a report you filed. Deliberately
 * absent is "my reports", which needs an account and is therefore behind the
 * shell's signed-in variant - a link a signed-out visitor cannot use is a dead
 * end, and dead ends on a civic service cost trust.
 */
@Component({
  selector: 'app-citizen-shell',
  imports: [AppShell],
  template: `
    <app-shell
      navLabel="Citizen"
      heading="CivicLens"
      [links]="links"
    >
      <ng-content />
    </app-shell>
  `,
})
export class CitizenShell {
  readonly links = [
    { path: '/report', label: 'Report an issue', exact: true },
    { path: '/tracked', label: 'Track a report' },
    { path: '/public', label: 'Public reports' },
  ];
}
