import { Component, input } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzMenuModule } from 'ng-zorro-antd/menu';

/**
 * The frame every screen renders inside.
 *
 * Four shells differ in navigation and the links they expose, not in page
 * furniture, so the furniture lives here once. Duplicating the skip link and
 * landmark structure four times is how one of the copies quietly loses its
 * `aria-label` and nobody notices until a screen-reader audit.
 *
 * The navigation is NG-ZORRO's `nz-menu` rather than a hand-rolled `<ul>`. That
 * choice was checked rather than assumed: `nz-menu` renders a plain
 * `<ul class="ant-menu">` of `<li class="ant-menu-item">` with the link inside a
 * `span.ant-menu-title-content`, and it adds no `role="menu"`, no
 * `role="menuitem"` and no `aria-current` of its own. So the list semantics and
 * the link roles are exactly what they were, and the accessible name still comes
 * from the surrounding `<nav>`.
 *
 * Worth naming because it is the usual reason to avoid `nz-menu` on a public
 * site. A library menu that stamped `role="menu"` onto a group of site links
 * would be actively wrong - that role tells a screen reader the links are
 * application commands with arrow-key navigation, not a navigation landmark -
 * and the shell-wiring tests below would not have caught it, because a role
 * change is not a DOM structure change. Measured first, then adopted.
 *
 * Accessibility notes that apply to all four shells:
 *
 * - The skip link is the first focusable element and moves focus past the
 *   navigation. On a phone with a large nav it is the difference between one
 *   tab and ten.
 * - `<header>`, `<nav>` and `<main>` are real landmarks, so a screen-reader user
 *   can jump between regions instead of reading linearly.
 * - `<main>` carries the page title as its own heading, so every page has
 *   exactly one `h1` and the document outline is never empty.
 * - `aria-current="page"` is set on the active link by hand. `nz-menu` tracks its
 *   own `ant-menu-item-selected` class for styling but does not expose
 *   `aria-current`, so a screen reader would otherwise have no way to tell a
 *   citizen which of three links they are on.
 */
@Component({
  selector: 'app-shell',
  imports: [RouterLink, RouterLinkActive, NzIconModule, NzMenuModule],
  template: `
    <a class="skip-link" href="#main-content">Skip to main content</a>

    <header class="app-header">
      <a class="brand" routerLink="/">
        <span class="brand-mark" aria-hidden="true">CL</span>
        <span class="brand-name">CivicLens</span>
      </a>

      <nav class="app-nav" [attr.aria-label]="navLabel()">
        <ul nz-menu nzMode="horizontal">
          @for (link of links(); track link.path) {
            <li nz-menu-item>
              <a
                [routerLink]="link.path"
                routerLinkActive="ant-menu-item-selected"
                [routerLinkActiveOptions]="{ exact: link.exact ?? false }"
                #rla="routerLinkActive"
                [attr.aria-current]="rla.isActive ? 'page' : null"
              >
                <span
                  nz-icon
                  [nzType]="link.icon"
                  nzTheme="outline"
                  aria-hidden="true"
                ></span>
                <span class="nav-label">{{ link.label }}</span>
              </a>
            </li>
          }
        </ul>
      </nav>
    </header>

    <main id="main-content" tabindex="-1">
      <h1>{{ heading() }}</h1>
      <ng-content />
    </main>

    <footer class="app-footer">
      <p>
        CivicLens reports are handled by your local civic department. Nothing on
        this page is an official notice.
      </p>
    </footer>
  `,
  styles: `
    :host {
      display: flex;
      min-height: 100dvh;
      flex-direction: column;
    }

    .skip-link {
      position: absolute;
      left: -9999px;
      background: var(--cl-surface-container);
      color: var(--cl-on-surface);
      padding: 0.75rem 1rem;
      z-index: 100;
    }

    /* Not :hover - a keyboard user needs the link to appear on focus, which
       is the only way they will ever see it. */
    .skip-link:focus {
      left: 0;
      top: 0;
    }

    .app-header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 1rem;
      padding: 0.75rem 1rem;
      border-bottom: 1px solid var(--cl-outline-variant);
    }

    .brand {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      color: var(--cl-on-surface);
      text-decoration: none;
      font-weight: 600;
    }

    .brand-mark {
      display: grid;
      place-items: center;
      inline-size: 2rem;
      block-size: 2rem;
      border-radius: 0.375rem;
      background: var(--cl-primary);
      color: var(--cl-on-primary);
      font-size: 0.8125rem;
      letter-spacing: 0.02em;
    }

    /* The library's own list reset, kept. nz-menu styles the list but the
       header is a flex row, so the menu has to be allowed to grow. */
    .app-nav ul {
      flex-wrap: wrap;
      row-gap: 0;
    }

    .app-nav li {
      display: flex;
    }

    .app-nav a {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      color: var(--cl-on-surface);
      text-decoration: none;
    }

    /* Horizontal nz-menu underlines the selected item; the focus-visible rule
       in styles.scss is global, and this is the nav-specific "you are here"
       treatment on top of it. The colour is set here because the library's
       selected state inherits from the theme override in _civiclens-theme.scss,
       and the nav sits on the surface token rather than the ant body token. */
    .app-nav a.ant-menu-item-selected {
      color: var(--cl-primary);
      font-weight: 600;
    }

    /* Pointer-only suppression of the icon's own baseline gap. A 0-width icon
       span inside a flex link otherwise reserves a phantom 14px. */
    .app-nav a:hover [nz-icon] {
      opacity: 0.85;
    }

    /* The label is the link's accessible name, so it is never hidden from a
       screen reader. Only the visual redundancy of a short label is removed,
       and only on the narrow screens where the three links stop fitting. */
    @media (max-width: 30rem) {
      .nav-label {
        position: absolute;
        inline-size: 1px;
        block-size: 1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
      }

      /* With the text visually hidden the icon is the only thing that can carry
         the item, so the link needs a real target and a visible state. */
      .app-nav a {
        padding: 0.5rem;
      }
    }

    main {
      flex: 1;
      inline-size: min(72rem, 100% - 2rem);
      margin-inline: auto;
      padding-block: 1.5rem 3rem;
    }

    /* focus-visible rather than focus, so a mouse click does not leave a ring on
       the whole page after navigation. */
    main:focus {
      outline: none;
    }

    main:focus-visible {
      outline: 3px solid var(--cl-primary);
      outline-offset: 2px;
    }

    h1 {
      margin: 0 0 1rem;
      font-size: clamp(1.5rem, 1.2rem + 1.5vw, 2rem);
    }

    .app-footer {
      padding: 1rem;
      border-top: 1px solid var(--cl-outline-variant);
      color: var(--cl-on-surface-variant);
      font-size: 0.875rem;
    }
  `,
})
export class AppShell {
  /** Nav landmark label, so four shells do not all announce "navigation". */
  readonly navLabel = input.required<string>();

  /** The single `h1` for the page. */
  readonly heading = input.required<string>();

  /**
   * The nav items.
   *
   * `icon` is required rather than optional because `nz-icon` renders an empty
   * inline-block for an unregistered name instead of throwing, so a link with no
   * icon would look like a layout bug with no error anywhere. `ui-icon-registration.spec.ts`
   * fails on any `nzType` that is not in the allowlist, which is what catches a
   * typo here; the type is what stops it being optional in the first place.
   */
  readonly links = input.required<
    ReadonlyArray<{ path: string; label: string; icon: string; exact?: boolean }>
  >();
}
