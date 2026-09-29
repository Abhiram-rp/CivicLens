import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { routes } from './app.routes';
import { AppShell } from './layouts/app-shell';
import { CitizenShell } from './layouts/citizen-shell';
import { civiclensNgZorroProviders } from './ui/ng-zorro.providers';

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
      providers: [provideRouter(routes), ...civiclensNgZorroProviders],
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
      //
      // The NG-ZORRO providers are not optional here either. The shell nav renders
      // `nz-icon`, and an `nz-icon` whose name is not registered never completes
      // its internal observable, which leaves a `PendingTasks` handle outstanding
      // and hangs every `await fixture.whenStable()` below. The failure mode is a
      // 5-second timeout in a file that never mentions icons; the fix is to render
      // with the same providers the browser gets.
      providers: [provideRouter([]), ...civiclensNgZorroProviders],
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

  it('keeps the nav as a list of links, not an ARIA menu', async () => {
    // The nav is built from NG-ZORRO's `nz-menu`, and `nz-menu` is usually the
    // wrong component for site navigation for one specific reason: if it stamped
    // `role="menu"` onto the list, a screen reader would stop treating these as
    // page links and start treating them as application commands, with arrow-key
    // navigation and menu-item announcements, inside a `<nav>` landmark. That is
    // a semantic downgrade, and no DOM-structure assertion above would notice -
    // the element tree would be identical.
    //
    // As of `ng-zorro-antd@22.1.1` the component emits no roles at all, which was
    // verified against the compiled bundle before it was adopted. This test is
    // what keeps that true across an upgrade, which is the only way it can change:
    // a dependency bump is not a code review, and a regression here would ship
    // silently.
    const fixture = TestBed.createComponent(CitizenShell);
    await fixture.whenStable();
    const nav = (fixture.nativeElement as HTMLElement).querySelector('nav')!;

    for (const role of ['menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'tab', 'tablist']) {
      expect(
        nav.querySelectorAll(`[role="${role}"]`).length,
        `the site nav must not expose role="${role}"`,
      ).toBe(0);
    }

    // What it should be instead: a real list of real links, each still an
    // `<a href>`, so middle-click, ctrl-click and "copy link address" all work.
    // A `nz-menu` configured for button-like items would use `<div>` and take all
    // three away.
    expect(nav.querySelectorAll('ul > li').length).toBe(3);
    const anchors = [...nav.querySelectorAll('a')];
    expect(anchors.length).toBe(3);
    for (const anchor of anchors) {
      expect(anchor.tagName, 'nav items must stay real links').toBe('A');
      expect(anchor.getAttribute('href')).toBeTruthy();
    }

    // And the icon must not become part of the link's accessible name.
    // `nz-icon` sets `role="img"` and binds `attr.aria-label` to the icon *name*
    // - a link with `nzType="plus"` in it announces as "plus, Report an issue"
    // unless the icon is hidden. `aria-hidden="true"` on the element wins, since
    // it removes the subtree from the accessibility tree entirely.
    for (const anchor of anchors) {
      expect(
        anchor.textContent?.trim(),
        `link ${anchor.getAttribute('href')} has no text`,
      ).toBeTruthy();
      const icon = anchor.querySelector('[nz-icon]');
      expect(icon, `link ${anchor.getAttribute('href')} has no icon to hide`).toBeTruthy();
      expect(
        icon?.getAttribute('aria-hidden'),
        `the icon on ${anchor.getAttribute('href')} is announced; nz-icon labels it with the icon name`,
      ).toBe('true');
    }
  });

  it('renders a real SVG for every nav icon, not an empty box', async () => {
    // `nz-icon` with an unregistered name renders nothing and logs a warning, so
    // the nav still looks like a nav - it is just missing three glyphs, and the
    // ones it is missing are the ones a low-vision user relies on. Asserting on
    // the element's presence would pass either way; asserting on the SVG child
    // cannot.
    const fixture = TestBed.createComponent(CitizenShell);
    await fixture.whenStable();
    const nav = (fixture.nativeElement as HTMLElement).querySelector('nav')!;

    // `[nz-icon]`, not `nz-icon`. The directive's selector is `nz-icon,[nz-icon]`,
    // so it is written as an attribute on an ordinary `<span>` and there is no
    // element named `nz-icon` to select. A tag-name query here returns nothing
    // and the assertion "expected 0 to be 3" reads like the icons are missing,
    // when in fact they were never looked for.
    const icons = [...nav.querySelectorAll('[nz-icon]')];
    expect(icons.length, 'every nav link carries an icon').toBe(3);
    for (const icon of icons) {
      expect(
        icon.querySelector('svg'),
        `the "${icon.getAttribute('nztype')}" icon rendered no svg; add it to ui/icons.ts`,
      ).toBeTruthy();
    }
  });
});
