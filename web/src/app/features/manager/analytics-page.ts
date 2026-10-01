import { Component } from '@angular/core';
import { NotYet } from '../../shared/not-yet';

/**
 * AnalyticsPage - scaffold placeholder.
 *
 * The route, its title, its guard and its lazy chunk are real; the screen is not
 * built yet. Scheduled for P4 per SPEC 15 - "Transparency and Analytics: public map
 * + anonymized feed, rollups, ward dashboards, CSV export". This screen was labelled
 * P1, which made a phase-4 screen look like the current one to whoever picks it up.
 *
 * `exportIssues` is deliberately absent even though CSV export is a P4 deliverable:
 * the contract restricts it to `x-required-roles: [ADMIN]`, and this route is under
 * `/manager/**`. Listing it here described a screen that would 403 on its own data.
 * The export belongs to the admin area; `getDashboard` is role-appropriate and is
 * open to all four roles.
 *
 * Navigation is the shell's business, so this page contributes content only.
 */
@Component({
  selector: 'app-analytics-page',
  imports: [NotYet],
  template: `
    <app-not-yet [phase]="'P4'" [operations]="operations" />
  `,
})
export class AnalyticsPage {
  protected readonly operations: ReadonlyArray<string> = ['getDashboard'];
}
