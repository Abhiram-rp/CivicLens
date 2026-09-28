import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AppShell } from './app-shell';
import { AuthService } from '../core/auth/auth.service';

/**
 * The field officer's shell.
 *
 * Narrower than the manager's by design: an officer sees the issues assigned to
 * them and nothing else. SPEC 3 is explicit that an officer cannot assign,
 * reject, mark duplicates, or see another department's issues, so surfacing
 * those links would be offering a control the server will refuse.
 *
 * The officer split activates in P2 (SPEC 3); in P1 the same shell serves the
 * manager doing manual triage, which is why the signed-out state renders a
 * sign-in link rather than assuming a session.
 */
@Component({
  selector: 'app-officer-shell',
  imports: [AppShell, RouterLink],
  template: `
    <app-shell navLabel="Field officer" heading="Field work" [links]="links">
      @if (auth.isSignedIn) {
        <p class="identity">
          Signed in as {{ auth.snapshot?.fullName }}
        </p>
      } @else {
        <p><a routerLink="/sign-in">Sign in</a> to see issues assigned to you.</p>
      }
      <ng-content />
    </app-shell>
  `,
  styles: `
    .identity {
      color: var(--cl-on-surface-variant);
      margin-block: 0 1rem;
    }
  `,
})
export class OfficerShell {
  protected readonly auth = inject(AuthService);

  readonly links = [
    { path: '/officer/assigned', label: 'Assigned to me', exact: true },
    { path: '/notifications', label: 'Notifications' },
  ];
}
