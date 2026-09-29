import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Routes } from '@angular/router';
import { globSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from './app';
import { routes } from './app.routes';
import { civiclensNgZorroProviders } from './ui/ng-zorro.providers';

const SRC = dirname(fileURLToPath(import.meta.url));
const SCREENS = join(SRC, 'features');

/**
 * The shells were correct and unused.
 *
 * Every one of the five layout components asserted its own skip link, landmark
 * labels and single-`h1` invariants in `app.spec.ts`, all of which passed, and
 * not one of them was named by a route. All 27 screens rendered with no
 * navigation, no `<main>` landmark and no skip link - pages that look finished
 * in a screenshot and cannot be navigated by keyboard.
 *
 * The gap was a claim nobody had made. "The shell renders correctly" is true and
 * was tested. "Every screen is inside a shell" is the claim that matters, it is
 * a property of the route table rather than of any component, and nothing
 * asserted it. So these tests are deliberately about the route table and about
 * what the router actually renders, not about a component in isolation.
 */

/** Flattens the table into the URLs a real navigation can reach. */
function allRouteUrls(table: Routes, prefix = ''): string[] {
  return table.flatMap((route) => {
    const segment = route.path ? `${prefix}/${route.path}` : prefix;
    return [
      segment || '/',
      ...allRouteUrls(route.children ?? [], segment),
    ];
  });
}

describe('shell wiring', () => {
  it('puts every routable screen inside a shell', () => {
    // The strongest form of the claim, and the one that would have failed. Any
    // route that renders a feature without a shell parent is a bare page.
    const offenders: string[] = [];
    for (const route of routes) {
      const loadsSomething = Boolean(route.loadComponent || route.loadChildren);
      const children = route.children ?? [];

      if (children.length === 0 && loadsSomething) {
        offenders.push(`/${route.path}`);
      }
    }

    expect(
      offenders,
      'these routes load a component with no shell parent, so they render bare',
    ).toEqual([]);

    // Four shell groups, and every screen a child of one of them.
    const groups = routes.filter((r) => (r.children ?? []).length > 0);
    expect(groups.map((g) => g.path).sort()).toEqual(['', 'admin', 'manager', 'officer']);
  });

  it('keeps a screen from rendering its own frame', () => {
    // Each of the 27 placeholder screens used to wrap itself in a shell. That is
    // invisible in a component test - one correct shell looks the same as one
    // correct shell - and produced two skip links, two `main` landmarks, two
    // `h1`s and two navs in the browser the moment the route table supplied its
    // own. Asserted as a rule so a future placeholder cannot reintroduce it.
    // Absolute pattern, and the results are used as-is: globSync returns paths
    // that already include the pattern's own directories, so re-joining the
    // source directory onto them would prepend it twice.
    const screens = globSync(join(SCREENS, '**/*.ts'));
    const offenders: string[] = [];

    for (const file of screens) {
      if (file.endsWith('.spec.ts')) continue;
      const source = readFileSync(file, 'utf8');
      const name = file.slice(file.indexOf('features') + 'features'.length + 1);

      if (/app-(citizen|officer|manager|admin)-shell/.test(source)) {
        offenders.push(name);
      }
      // And the import, which would otherwise survive an unused-element edit.
      if (/import \{ \w*Shell \} from/.test(source)) {
        offenders.push(`${name} (imports a shell)`);
      }
    }

    expect(
      offenders,
      'a screen must contribute content only; the shell supplies the frame',
    ).toEqual([]);
  });

  it('keeps every guard on a child, so a typo is a 404 and not a 403', () => {
    for (const route of routes) {
      expect(
        route.canActivate,
        `/${route.path} guards the whole group; a mistyped child URL would report not-authorised`,
      ).toBeUndefined();
    }
  });

  it('gives every group a catch-all, so no URL is a dead end', () => {
    for (const route of routes) {
      const children = route.children ?? [];
      if (children.length === 0) continue;
      expect(
        children.some((c) => c.path === '**'),
        `/${route.path} has no '**' child, so an unknown URL under it renders bare`,
      ).toBe(true);
    }
  });

  it('declares the pathless group last, so its wildcard cannot shadow a real route', () => {
    // The one that cost a real bug. A `**` child matches every path its parent
    // group does not, and the parent here is path-less, so a wildcard owned by it
    // competes with every *sibling* of the group. Declared first - which is where
    // it naturally goes, being the entry point - its `**` swallowed
    // `/manager/queue` and rendered "page not found" inside the citizen frame. A
    // department manager following a link from an email got a 404.
    //
    // Asserted on the table rather than by navigation, because the failure is
    // about matching order and a test that navigates to one URL proves nothing
    // about the next one added.
    const pathlessIndex = routes.findIndex((r) => r.path === '');
    expect(pathlessIndex, 'the pathless citizen group must exist').toBeGreaterThanOrEqual(0);
    expect(
      pathlessIndex,
      'the pathless group owns the table catch-all, so it must be declared last',
    ).toBe(routes.length - 1);

    // And no prefixed group may come after it for the same reason.
    for (const [index, route] of routes.entries()) {
      if (route.path === '') continue;
      expect(
        index,
        `/${route.path} is declared after the catch-all owner and can never match`,
      ).toBeLessThan(pathlessIndex);
    }
  });

  it('preserves the public URLs the contract and emails already use', () => {
    // The restructure moved screens under shell groups without changing a single
    // path. These are the URLs that appear in emails and in the API contract, so
    // a path change here is a breaking change for links already in the wild.
    const urls = allRouteUrls(routes);
    for (const expected of [
      '/',
      '/report',
      '/tracked',
      '/tracked/:issueId',
      '/public',
      '/public/:publicCode',
      '/contact/verify',
      '/contact/decision',
      '/sign-in',
      '/my-reports',
      '/notifications',
      '/not-authorised',
      '/officer/assigned',
      '/officer/resolve/:issueId',
      '/manager/queue',
      '/manager/duplicates',
      '/admin/users',
      '/admin/audit-logs',
    ]) {
      expect(urls, `missing public URL ${expected}`).toContain(expected);
    }
  });
});

describe('what the router actually renders', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      // The NG-ZORRO providers are required, not decorative. Every screen here
      // renders inside a shell whose nav contains `nz-icon`, and an unregistered
      // icon name leaves a `PendingTasks` handle outstanding, so `whenStable()`
      // never resolves and the whole file times out instead of failing.
      providers: [provideRouter(routes), ...civiclensNgZorroProviders],
    }).compileComponents();
  });

  /**
   * Navigates and returns the document the user would see.
   *
   * Deliberately a real `Router` over the real table rather than a rendered
   * component. Rendering `CitizenShell` in isolation is what let the original
   * bug through: the component was fine and the table never mentioned it.
   */
  async function render(url: string): Promise<HTMLElement> {
    return (await renderWithUrl(url)).host;
  }

  /**
   * Navigates and returns both the document and where the router actually ended
   * up.
   *
   * The URL is the point. A screen that renders the right thing for the wrong
   * reason - a wildcard catching a real route - is indistinguishable from correct
   * behaviour by looking at the DOM alone, and that is exactly the bug this file
   * exists for.
   */
  async function renderWithUrl(
    url: string,
  ): Promise<{ host: HTMLElement; url: string }> {
    const router = TestBed.inject(Router);
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();

    await router.navigateByUrl(url);
    await fixture.whenStable();
    fixture.detectChanges();

    return {
      host: fixture.nativeElement as HTMLElement,
      url: router.url,
    };
  }

  it('renders a citizen screen inside the citizen shell', async () => {
    const host = await render('/report');

    expect(host.querySelector('app-citizen-shell')).toBeTruthy();
    expect(host.querySelector('main#main-content')).toBeTruthy();
    expect(host.querySelector('.skip-link')).toBeTruthy();
    expect(host.querySelector('nav[aria-label="Citizen"]')).toBeTruthy();
    // The screen itself, inside the frame.
    expect(host.querySelector('app-report-issue-page')).toBeTruthy();
  });

  it('renders exactly one frame, with one h1 and one nav', async () => {
    // The regression test for the doubled shell. Each assertion below was false
    // in a real browser while every component test in the suite passed, because
    // mounting a single screen in a fixture cannot produce a duplicate frame -
    // only the router supplying a shell that the screen also supplies will.
    const host = await render('/report');

    expect(host.querySelectorAll('app-citizen-shell').length).toBe(1);
    expect(host.querySelectorAll('header').length).toBe(1);
    expect(host.querySelectorAll('main#main-content').length).toBe(1);
    expect(host.querySelectorAll('h1').length).toBe(1);
    // Three nav links, not six.
    expect(host.querySelectorAll('nav a').length).toBe(3);
    // The screen contributes content only, so nothing is projected past the frame.
    expect(host.querySelectorAll('app-citizen-shell app-citizen-shell').length).toBe(0);
  });

  it('gives the frame one h1 and the skip link first focus', async () => {
    const host = await render('/report');

    expect(host.querySelector('h1')?.textContent?.trim()).toBe('CivicLens');
    const focusables = host.querySelectorAll('a, button, input, select, textarea');
    expect(focusables[0]?.className).toBe('skip-link');
  });

  it('matches a staff URL to its real route, not to the table wildcard', async () => {
    // Signed out here, so the guard sends the visitor to sign-in and the manager
    // shell itself never renders - that part is correct and is what the guard is
    // for. The claim worth testing is the *match*: `/manager/queue` is a real
    // route, so it must reach its own guard and be redirected for the right
    // reason.
    //
    // With the pathless group declared first, its `**` won the match instead, no
    // guard ever ran, and a department manager following a link from an email got
    // "page not found" in the citizen frame. Distinguishable from the correct
    // behaviour only by the destination, which is why both are asserted.
    const { host, url } = await renderWithUrl('/manager/queue');

    expect(url).toContain('/sign-in');
    expect(host.querySelector('app-not-found-page')).toBeNull();
    expect(host.querySelector('app-sign-in-page')).toBeTruthy();
  });

  it('answers an unknown URL with the 404, not a redirect', async () => {
    // The contrast case. If this ever starts redirecting to sign-in the way
    // `/manager/queue` does, the wildcard is shadowing real routes again.
    const { host, url } = await renderWithUrl('/no-such-page');

    expect(url).toBe('/no-such-page');
    expect(host.querySelector('app-not-found-page')).toBeTruthy();
  });

  it('reaches each staff screen through its own group, not the citizen one', async () => {
    // Asserted on the table rather than by navigation. A signed-out fixture cannot
    // render a staff shell - the guard correctly refuses - so proving the group
    // owns the screen means proving the screen is the group's *child*, which is
    // the structural fact that determines who sees it once a session exists.
    const groups = new Map(
      routes.filter((r) => r.path).map((r) => [r.path, (r.children ?? []).map((c) => c.path)]),
    );

    expect(groups.get('manager')).toEqual(
      expect.arrayContaining(['queue', 'duplicates', 'sla-monitor']),
    );
    expect(groups.get('admin')).toEqual(expect.arrayContaining(['users', 'audit-logs']));
    expect(groups.get('officer')).toEqual(expect.arrayContaining(['assigned']));

    // And no staff *group* leaked into the citizen group, which is what would let
    // the pathless wildcard compete with them. The citizen group does own a `**`
    // of its own - it has to, or an unknown URL is a dead end - so what matters
    // is that the catch-all is the *last* child, so it cannot match a path an
    // earlier sibling group legitimately owns.
    const citizen = routes.find((r) => r.path === '');
    const citizenChildren = citizen?.children ?? [];
    const citizenPaths = citizenChildren.map((c) => c.path);

    for (const leaked of ['manager', 'officer', 'admin']) {
      expect(citizenPaths, `${leaked} leaked into the citizen group`).not.toContain(leaked);
    }
    expect(
      citizenPaths.at(-1),
      'the citizen catch-all must be its last child, or it shadows a real route',
    ).toBe('**');
  });

  it('renders an unknown URL as a 404 inside the shell, not a bare page', async () => {
    const host = await render('/no-such-page');

    expect(host.querySelectorAll('app-citizen-shell').length).toBe(1);
    expect(host.querySelector('main#main-content')).toBeTruthy();
    expect(host.querySelector('app-not-found-page')).toBeTruthy();
  });
});
