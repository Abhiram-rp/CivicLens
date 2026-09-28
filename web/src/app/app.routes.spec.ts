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

describe('route table', () => {
  it('lazily loads every route component', () => {
    const eager = /^\s*component:\s*[^,]+/m.exec(routesSource);
    expect(eager, 'a route uses an eager `component:` import').toBeNull();
    expect(routesSource).toContain('loadComponent');
  });

  it('gives every route a title', () => {
    // A route with no title leaves the browser tab reading "Angular" or the bare
    // path, which for a civic service is indistinguishable from a broken site.
    const titled = (routesSource.match(/^\s*title:\s*'/gm) ?? []).length;
    // The wildcard route plus one per feature route.
    expect(titled).toBe(routes.length);
  });

  it('never puts a tracking token in a path', () => {
    // SPEC 14: the token is a bearer credential and must never appear in a
    // route, query string or `Referer`, so a shared link to /tracked/... must be
    // impossible to construct from the address bar. The tracked routes carry
    // only an issue id.
    const trackedRoutes = routes.filter((route) => route.path?.startsWith('tracked'));
    expect(trackedRoutes.length).toBeGreaterThan(0);

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
    const contactRoutes = routes.filter((route) => route.path?.startsWith('contact'));
    expect(contactRoutes.length).toBeGreaterThan(0);

    for (const route of contactRoutes) {
      expect(route.canActivate, `${route.path} must not be guarded`).toBeUndefined();
    }
  });

  it('guards every staff route', () => {
    // The inverse check on the contact exception: a staff surface with no guard
    // renders and then fails every request, which reads to a signed-in officer
    // as CivicLens being broken.
    const staffRoutes = routes.filter(
      (route) =>
        /^(officer|manager|admin)\//.test(route.path ?? '') ||
        route.path?.startsWith('notifications'),
    );
    expect(staffRoutes.length).toBeGreaterThan(0);

    for (const route of staffRoutes) {
      expect(route.canActivate, `${route.path} has no guard`).toBeDefined();
    }
  });

  it('ends with a wildcard so an unknown path is a real page', () => {
    // Without this an unmatched URL renders a blank outlet, which is the worst
    // possible answer on a site people are told to bookmark.
    expect(routes.at(-1)?.path).toBe('**');
  });
});
