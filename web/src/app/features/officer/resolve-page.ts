import { Component } from '@angular/core';
import { NotYet } from '../../shared/not-yet';

/**
 * ResolvePage - scaffold placeholder.
 *
 * The route, its title, its guard and its lazy chunk are real; the screen is not
 * built yet. Scheduled for P1 per SPEC 15, which lists "resolution report" among the
 * P1 deliverables. This was labelled P2, which is the more consequential of the two
 * label errors: P1's ship gate is a reporter receiving a proposed fix and disputing
 * it, and that fix is filed through this screen. Labelling it a later phase quietly
 * demoted the centre of the P1 demo to "not this release".
 *
 * The operations listed by `app-not-yet` are the contract surface this screen will
 * call.
 *
 * Navigation is the shell's business, so this page contributes content only.
 */
@Component({
  selector: 'app-resolve-page',
  imports: [NotYet],
  template: `
    <app-not-yet [phase]="'P1'" [operations]="operations" />
  `,
})
export class ResolvePage {
  protected readonly operations: ReadonlyArray<string> = ['resolveIssue'];
}
