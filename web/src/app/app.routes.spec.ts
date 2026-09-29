import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { routes } from './app.routes';

/**
 * The route table and the contract are the two things a citizen cannot recover
 * from getting wrong, so both are asserted here.
 *
 * SPEC 14 requires lazy routes, so a route that eagerly imports its component
 * silently bloats the citizen's first load. Nothing in TypeScript catches that -
 * `loadComponent` and a direct `component` both type-check - which is why it is
 * checked as a rule rather than left to review.
 */

const routesSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'app.routes.ts'), 'utf8');

/**
 * Every route in the table, flattened to a group + child pair.
 *
 * The table is nested one level: a shell group and the screens inside it. These
 * tests were written against a flat table and reached into `route.path` looking
 * for `'contact/verify'` or `'officer/assigned'`. Nesting moved those strings
 * into `child.path`, so every filter here now runs over the flattened view.
 * Restructuring the table is exactly the kind of change that makes assertions
 * quietly vacuous, and a filter matching nothing passes `toBeGreaterThan(0)`
 * only because the line below it would then have nothing to iterate.
 */
function flatRoutes(): Array<{ path: string; canActivate: unknown; title: unknown }> {
  return routes.flatMap((route) => {
    const group = route.path ?? '';
    return [
      { path: group, canActivate: route.canActivate, title: route.title },
      ...(route.children ?? []).map((child) => ({
        path: group ? `${group}/${child.path}` : (child.path ?? ''),
        canActivate: child.canActivate,
        title: child.title,
      })),
    ];
  });
}

describe('route table', () => {
  it('lazily loads every route component', () => {
    const eager = /^\s*component:\s*[^,]+/m.exec(routesSource);
    expect(eager, 'a route uses an eager `component:` import').toBeNull();
    expect(routesSource).toContain('loadComponent');
  });

  it('gives every route a title', () => {
    // A route with no title leaves the browser tab reading "Angular" or the bare
    // path, which for a civic service is indistinguishable from a broken site.
    // Checked against the object, not the source text: counting `title:` lines
    // in the file passes even when the count is wrong for the reason that
    // matters - a title attached to the wrong route.
    const untitled = flatRoutes().filter((route) => !route.title);
    // The four shell groups carry no title of their own; they are frames, and
    // every screen inside them is titled. The citizen group is the empty path,
    // so it is listed as ''.
    expect(untitled.map((r) => r.path).sort()).toEqual(['', 'admin', 'manager', 'officer']);
  });

  it('never puts a tracking token in a path', () => {
    // SPEC 14: the token is a bearer credential and must never appear in a
    // route, query string or `Referer`, so a shared link to /tracked/... must be
    // impossible to construct from the address bar. The tracked routes carry
    // only an issue id.
    const trackedRoutes = flatRoutes().filter((route) => route.path.startsWith('tracked'));
    expect(trackedRoutes.map((r) => r.path)).toEqual(['tracked', 'tracked/:issueId']);

    for (const route of trackedRoutes) {
      expect(route.path, 'a tracked route must not carry a token parameter').not.toMatch(
        /token/i,
      );
    }
    // And nothing anywhere in the table may name a token parameter.
    expect(routesSource).not.toMatch(/:\w*token\w*/i);
  });

  it('keeps the contact routes reachable without a session', () => {
    // SPEC 14's narrow exception: the approval link is usually opened on a
    // different device from the one holding the tracking token, so a guard here
    // would break the flow exactly when it is most needed. The single-use token
    // in the link is the credential, and it grants no report content.
    const contactRoutes = flatRoutes().filter((route) => route.path.startsWith('contact'));
    // Spelled out rather than counted: a filter that matches nothing and a filter
    // that matches two routes both satisfy "greater than zero", and only the first
    // is the bug this is here to prevent.
    expect(contactRoutes.map((r) => r.path)).toEqual([
      'contact/verify',
      'contact/decision',
    ]);

    for (const route of contactRoutes) {
      expect(route.canActivate, `${route.path} must not be guarded`).toBeUndefined();
    }
  });

  it('guards every staff route', () => {
    // The inverse check on the contact exception: a staff surface with no guard
    // renders and then fails every request, which reads to a signed-in officer
    // as CivicLens being broken.
    const staffRoutes = flatRoutes().filter(
      (route) =>
        (/^(officer|manager|admin)\//.test(route.path) &&
          !route.path.endsWith('/**')) ||
        route.path.startsWith('notifications'),
    );
    // The `**` children are filtered out above: they are the not-found page and
    // are deliberately unguarded so a mistyped staff URL says "no such page"
    // rather than sending an officer to sign in. The three bare group paths
    // (`officer`, `manager`, `admin`) are frames with no screen of their own.
    // Declaration order is asserted here because it is load-bearing: the
    // pathless citizen group carries the table catch-all and must be last, so
    // the staff groups precede it. Sorted, because the *set* is the property that
    // matters here and the order is asserted in `shell-wiring.spec.ts`.
    expect([...staffRoutes.map((r) => r.path)].sort()).toEqual([
      'admin/audit-logs',
      'admin/categories',
      'admin/departments',
      'admin/sla',
      'admin/users',
      'manager/analytics',
      'manager/assignment',
      'manager/awaiting-confirmation',
      'manager/categories',
      'manager/duplicates',
      'manager/queue',
      'manager/sla-monitor',
      'notifications',
      'officer/assigned',
      'officer/resolve/:issueId',
    ]);

    for (const route of staffRoutes) {
      expect(route.canActivate, `${route.path} has no guard`).toBeDefined();
    }
  });

  it('gives every shell group a wildcard, so no unknown path is a dead end', () => {
    // Without this an unmatched URL renders a blank outlet, which is the worst
    // possible answer on a site people are told to bookmark. Per group rather
    // than one table-level `**`, so the 404 is rendered inside a shell and keeps
    // its navigation. `shell-wiring.spec.ts` asserts the same property from the
    // other direction - that a wildcard renders a real page - because either one
    // alone can be satisfied by a table that is merely well-formed.
    for (const route of routes) {
      if (!route.children?.length) continue;
      expect(
        route.children.some((child) => child.path === '**'),
        `/${route.path} has no wildcard child`,
      ).toBe(true);
    }
  });
});
