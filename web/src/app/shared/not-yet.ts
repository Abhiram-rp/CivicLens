import { Component, input } from '@angular/core';

/**
 * A SPEC 15 phase.
 *
 * The five phases in `docs/SPEC.md` §15, as a union rather than a free string. See
 * the note on `NotYet.phase` below for why this is worth a type.
 */
export type Phase = 'P1' | 'P2' | 'P3' | 'P4' | 'P5';

/**
 * The "this screen is not built yet" panel.
 *
 * Every route in the scaffold resolves to one of these, so the route table is
 * real and buildable from the first commit - lazy chunks, guards and titles can
 * all be verified before the feature work exists.
 *
 * It is a component rather than markup copied into 30 pages because the state
 * has to be *consistent and honest*. It names the contract operations the
 * screen will call, so "not implemented" is a specific claim someone can check
 * rather than a shrug, and it does not pretend to work: no fake submit button,
 * no placeholder data, no disabled-looking control that looks broken.
 *
 * SPEC 15's phase gates are why this state exists at all. The API contract is
 * settled, so the client is generated and the boundaries are drawn; the screens
 * arrive with their phases. Checked by check-screen-phases.mjs.
 */
@Component({
  selector: 'app-not-yet',
  template: `
    <section class="panel" aria-labelledby="not-yet-heading">
      <h2 id="not-yet-heading">Not built yet</h2>

      <p>
        This screen is part of the CivicLens scaffold. The route, its guard and
        its lazy chunk are real; the screen itself arrives with the phase named
        below.
      </p>

      @if (phase()) {
        <p class="phase">Scheduled: <strong>{{ phase() }}</strong></p>
      }

      @if (operations().length) {
        <p>It will call:</p>
        <ul class="operations">
          @for (operation of operations(); track operation) {
            <li><code>{{ operation }}</code></li>
          }
        </ul>
      }
    </section>
  `,
  styles: `
    .panel {
      padding: 1.25rem;
      border: 1px solid var(--cl-outline-variant);
      border-radius: 0.5rem;
      background: var(--cl-surface-container);
    }

    h2 {
      margin-block: 0 0.5rem;
      font-size: 1.125rem;
    }

    p {
      margin-block: 0 0.75rem;
      max-inline-size: 60ch;
    }

    .phase {
      color: var(--cl-on-surface-variant);
    }

    .operations {
      margin: 0;
      padding-inline-start: 1.25rem;
      max-inline-size: 60ch;
    }

    .operations li {
      margin-block: 0.25rem;
    }

    code {
      font-family: ui-monospace, 'Cascadia Code', 'Consolas', monospace;
      font-size: 0.875rem;
      color: var(--cl-on-surface);
    }
  `,
})
export class NotYet {
  /**
   * The SPEC 15 phase this screen belongs to.
   *
   * Typed as the union rather than `string` on purpose. These labels are the only
   * prioritisation signal a reader has for 27 unbuilt screens, and nine of them
   * disagreed with the SPEC 15 phase table while the component accepted any string
   * at all - a label like `P1` on a P4 screen, or `P1` on a screen whose subject
   * matter is explicitly out of scope for P1, type-checked silently. A union means
   * `P5` is a typo someone can see, and `check-screen-phases.mjs` means the value
   * itself is checked against SPEC.md.
   */
  readonly phase = input<Phase>();

  /** Contract operationIds the finished screen will call. */
  readonly operations = input<ReadonlyArray<string>>([]);
}
