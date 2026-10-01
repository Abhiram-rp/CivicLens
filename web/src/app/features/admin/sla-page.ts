import { Component } from '@angular/core';
import { NotYet } from '../../shared/not-yet';

/**
 * SlaPage - scaffold placeholder.
 *
 * The route, its title, its guard and its lazy chunk are real; the screen is not
 * built yet. Scheduled for P2 per SPEC 15 - "SLA policies + overdue job" is a P2
 * deliverable, and PLAN.md 174 lists SLA as explicitly out of scope for P1. It was
 * labelled P1, so a screen whose subject matter cannot exist in the first release
 * was presented as part of it.
 *
 * The operations listed by `app-not-yet` are the contract surface this screen will
 * call.
 *
 * Navigation is the shell's business, so this page contributes content only.
 */
@Component({
  selector: 'app-sla-page',
  imports: [NotYet],
  template: `
    <app-not-yet [phase]="'P2'" [operations]="operations" />
  `,
})
export class SlaPage {
  protected readonly operations: ReadonlyArray<string> = ['listSlaPolicies', 'upsertSlaPolicy'];
}
