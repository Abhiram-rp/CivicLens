import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { routes } from './app.routes';
import { AppShell } from './layouts/app-shell';
import { CitizenShell } from './layouts/citizen-shell';

/**
 * The root component is intentionally almost empty, so the test is mostly about
 * what it must NOT contain.
 *
 * The generated placeholder asserted `Hello, web` in an `h1`. Replacing that
 * assertion is the point: the root has no heading of its own, because SPEC 14
 * gives every role its own shell and the router selects one per route. A root
 * `h1` would be a second one on every page.
 */
describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter(routes)],
    }).compileComponents();
  });

  it('creates', () => {
    expect(TestBed.createComponent(App).componentInstance).toBeTruthy();
  });

  it('renders only the router outlet', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('router-outlet')).toBeTruthy();
    // The shells own the page furniture. A header or h1 here would duplicate the
    // landmarks and heading every routed page already provides.
    expect(root.querySelector('header')).toBeNull();
    expect(root.querySelector('nav')).toBeNull();
    expect(root.querySelector('main')).toBeNull();
    expect(root.querySelector('h1')).toBeNull();
  });
});

/**
 * The shell is where the accessibility furniture lives, so it is tested rather
 * than assumed. A shell that loses its skip link still looks fine to sighted
 * users and is the difference between one keystroke and ten for a keyboard user.
 */
describe('AppShell accessibility furniture', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppShell, CitizenShell],
      // `routerLink` and `routerLinkActive` inject `ActivatedRoute`, so the
      // shell cannot be rendered in a TestBed without a router present. An empty
      // route table is enough: the assertions are about the rendered furniture,
      // not about navigation.
      providers: [provideRouter([])],
    }).compileComponents();
  });

  it('puts a skip link first, targeting a focusable main', async () => {
    const fixture = TestBed.createComponent(CitizenShell);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    const skip = root.querySelector<HTMLAnchorElement>('.skip-link');
    expect(skip, 'the shell must offer a skip link').toBeTruthy();
    expect(skip?.getAttribute('href')).toBe('#main-content');

    const main = root.querySelector('main');
    expect(main?.id).toBe('main-content');
    // The skip link moves focus, not just the scroll position, so the target has
    // to be programmatically focusable. Without `tabindex` some browsers scroll
    // and leave focus on the link, which is the bug this assertion exists for.
    expect(main?.getAttribute('tabindex')).toBe('-1');

    // First focusable thing on the page, or the shortcut is not a shortcut.
    const focusables = root.querySelectorAll('a, button, input, select, textarea');
    expect(focusables[0]).toBe(skip);
  });

  it('labels its landmark regions and gives the page one h1', async () => {
    const fixture = TestBed.createComponent(CitizenShell);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('header')).toBeTruthy();
    expect(root.querySelector('nav')?.getAttribute('aria-label')).toBe('Citizen');
    expect(root.querySelector('main')).toBeTruthy();
    // Exactly one h1, and the root component is not it - see the App tests above.
    expect(root.querySelectorAll('h1').length).toBe(1);
    expect(root.querySelector('h1')?.textContent?.trim()).toBe('CivicLens');
  });

  it('renders the shell-owned nav with no dead ends', async () => {
    const fixture = TestBed.createComponent(CitizenShell);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    const hrefs = [...root.querySelectorAll('nav a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/report', '/tracked', '/public']);

    // SPEC 14: a signed-out visitor must not be offered "my reports", which
    // needs an account. A link that cannot work yet is a dead end.
    expect(hrefs).not.toContain('/my-reports');

    // Every nav target must be a real route, otherwise it is a 404 dressed as a
    // navigation item.
    const paths = routes.flatMap((route) => {
      const prefix = route.path ? `/${route.path}` : '';
      return [
        prefix || '/',
        ...(route.children ?? []).map((child) => `${prefix}/${child.path ?? ''}`),
      ];
    });
    for (const href of hrefs) {
      expect(paths, `nav link ${href} has no route`).toContain(href);
    }
  });
});
