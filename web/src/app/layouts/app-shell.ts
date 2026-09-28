import { Component, input } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

/**
 * The frame every screen renders inside.
 *
 * Four shells differ in navigation and the links they expose, not in page
 * furniture, so the furniture lives here once. Duplicating the skip link and
 * landmark structure four times is how one of the copies quietly loses its
 * `aria-label` and nobody notices until a screen-reader audit.
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
 */
@Component({
  selector: 'app-shell',
  imports: [RouterLink, RouterLinkActive],
  template: `
    <a class="skip-link" href="#main-content">Skip to main content</a>

    <header class="app-header">
      <a class="brand" routerLink="/">
        <span class="brand-mark" aria-hidden="true">CL</span>
        <span class="brand-name">CivicLens</span>
      </a>

      <nav class="app-nav" [attr.aria-label]="navLabel()">
        <ul>
          @for (link of links(); track link.path) {
            <li>
              <a
                [routerLink]="link.path"
                routerLinkActive="active"
                [routerLinkActiveOptions]="{ exact: link.exact ?? false }"
                #rla="routerLinkActive"
                [attr.aria-current]="rla.isActive ? 'page' : null"
              >
                {{ link.label }}
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

    .app-nav ul {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem 1rem;
      list-style: none;
      margin: 0;
      padding: 0;
    }

    .app-nav a {
      display: inline-block;
      padding: 0.5rem 0.25rem;
      color: var(--cl-on-surface);
      text-decoration: none;
      border-bottom: 2px solid transparent;
    }

    /* Material's own focus-visible rule is global (see styles.scss); this is the
       nav-specific "you are here" treatment on top. */
    .app-nav a.active {
      border-bottom-color: var(--cl-primary);
      font-weight: 600;
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

  readonly links = input.required<
    ReadonlyArray<{ path: string; label: string; exact?: boolean }>
  >();
}
