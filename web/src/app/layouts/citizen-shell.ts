import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
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
    imports: [AppShell, RouterOutlet],
    template: `
      <app-shell
        navLabel="Citizen"
        heading="CivicLens"
        [links]="links"
      >
        <router-outlet />
      </app-shell>
    `,
  })
export class CitizenShell {
  /**
   * Nav items. Icons come from the `ui/icons.ts` allowlist; an unregistered name
   * renders as an empty box rather than an error, which is what
   * `ui-icon-registration.spec.ts` exists to catch.
   */
  readonly links = [
    { path: '/report', label: 'Report an issue', icon: 'plus', exact: true },
    { path: '/tracked', label: 'Track a report', icon: 'file-search' },
    { path: '/public', label: 'Public reports', icon: 'search' },
  ];
}
