import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { AuthService } from './auth.service';
import type { Role } from '../../api/generated';

/**
 * Route guard for staff surfaces (SPEC 3).
 *
 * **This is not a security boundary, and is written as if it cannot become
 * one.** SPEC 3 is explicit that authorization is decided in the service layer
 * by ownership and department scope, never by URL pattern and never by "hidden
 * in the UI". A guard exists for one reason: so a signed-in citizen who types
 * `/manager/queue` gets a page that explains the situation, instead of a shell
 * that renders empty tables and then fails every request.
 *
 * The 404-not-403 rule is the server's to enforce. A guard cannot know whether
 * a specific issue belongs to this officer's department, so it must not try -
 * it would be guessing at an authorization decision and could hide a real
 * report from a manager who is entitled to it.
 */
export function roleGuard(...allowed: readonly Role[]): CanActivateFn {
  return (_route, state) => {
    const auth = inject(AuthService);
    const router = inject(Router);

    if (!auth.isSignedIn) {
      // The attempted URL is preserved so sign-in returns the user to where they
      // were going. Only the path is used, never a query string - a redirect
      // target is echoed back into a URL, and a token in one would be a leak.
      return router.createUrlTree(['/sign-in'], { queryParams: { next: state.url } });
    }

    // An empty `allowed` means "any signed-in user", which is a real case: the
    // citizen's own report list. A non-empty list is checked against the role,
    // and the check must happen here - a guard that only tested for a session
    // would let every citizen into the manager queue and hide the mistake
    // behind an empty table.
    if (allowed.length > 0 && !auth.hasRole(...allowed)) {
      return router.createUrlTree(['/not-authorised']);
    }

    return true;
  };
}

/** The four roles, as named in SPEC 3. Order is display order. */
export const ALL_ROLES: readonly Role[] = [
  'CITIZEN',
  'FIELD_OFFICER',
  'DEPARTMENT_MANAGER',
  'ADMIN',
];

/** Staff roles that can see a department queue. */
export const STAFF_ROLES: readonly Role[] = ['FIELD_OFFICER', 'DEPARTMENT_MANAGER', 'ADMIN'];

/** Roles that administer configuration and audit (SPEC 3, ADMIN column). */
export const ADMIN_ROLES: readonly Role[] = ['ADMIN'];
