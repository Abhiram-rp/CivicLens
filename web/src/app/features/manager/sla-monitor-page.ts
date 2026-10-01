import { Component } from '@angular/core';
import { NotYet } from '../../shared/not-yet';

/**
 * SlaMonitorPage - scaffold placeholder.
 *
 * The route, its title, its guard and its lazy chunk are real; the screen is not
 * built yet. Scheduled for P2 per SPEC 15 - the "SLA overdue job" this screen exists
 * to watch is a P2 deliverable, and PLAN.md 174 puts SLA out of scope for P1.
 *
 * The operations listed by `app-not-yet` are the contract surface this screen will
 * call.
 *
 * Navigation is the shell's business, so this page contributes content only.
 */
@Component({
  selector: 'app-sla-monitor-page',
  imports: [NotYet],
  template: `
    <app-not-yet [phase]="'P2'" [operations]="operations" />
  `,
})
export class SlaMonitorPage {
  protected readonly operations: ReadonlyArray<string> = ['listIssues', 'upsertSlaPolicy'];
}
