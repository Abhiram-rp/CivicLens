import { en_US, provideNzI18n } from 'ng-zorro-antd/i18n';
import { provideNzIcons } from 'ng-zorro-antd/icon';
import { provideNzConfig } from 'ng-zorro-antd/core/config';
import { provideNzWave } from 'ng-zorro-antd/core/wave';
import { civiclensIcons } from './icons';

/**
 * The NG-ZORRO providers, in one place, for the app and for the tests.
 *
 * These were inline in `app.config.ts` and the specs that render a shell simply
 * omitted them, which is how nine tests came to time out rather than fail. The
 * mechanism is worth writing down because the symptom points nowhere near the
 * cause:
 *
 * `NzIconDirective` calls `pendingTasks.add()` before subscribing to the icon
 * observable, and releases the handle in `finalize`. An icon name that is not
 * registered never yields a value and never completes, so `finalize` never runs,
 * so the pending task is never removed - and `fixture.whenStable()` waits on
 * pending tasks. A missing provider does not produce a failed assertion. It
 * produces a test that sits there until the runner kills it at 5s, in a file
 * about landmarks and skip links, with no mention of icons anywhere.
 *
 * Exporting the array means a test that renders any component containing an
 * `nz-icon` gets the same configuration the browser does, and there is no second
 * place to forget.
 */
export const civiclensNgZorroProviders = [
  // English. CivicLens serves a single language today and neither SPEC.md nor
  // REQUIREMENTS.md opens a second one, so this is the only locale registered.
  // Stated explicitly because NG-ZORRO's default is `zh_CN` when no provider is
  // given - an unconfigured app renders Chinese pagination and date strings to
  // an English-speaking citizen, and nothing fails when that happens.
  provideNzI18n(en_US),

  // Icon set.
  //
  // Registered per-icon rather than by importing the library's full `ICONS` map,
  // which is 703 kB of SVG source. Only the icons the shell and the implemented
  // screens actually reference are here; adding one to a screen means adding it
  // here too. `ui-icon-registration.spec.ts` fails the build when a template
  // names an icon that is not on this list, because the library's own behaviour
  // in that case is to render an empty box and keep a pending task alive
  // forever.
  provideNzIcons(civiclensIcons),

  // Component-level defaults, via the library's own config service.
  //
  // This is the place for defaults that are *app-wide preferences* rather than
  // corrections. The two AA-critical corrections live in `_civiclens-theme.scss`
  // as CSS, not here, because a token the measurement gate reads has to be
  // measurable - and a value injected through `provideNzConfig` is invisible to
  // `theme.spec.ts`.
  provideNzConfig({}),

  // Turns off the press ripple on every NG-ZORRO button.
  //
  // Note this is a separate provider from the one above: `wave` is not part of
  // the `NzConfig` shape, it has its own `NZ_WAVE_GLOBAL_CONFIG` token, and
  // passing it to `provideNzConfig` is a compile error rather than a silently
  // ignored key. Worth stating because the natural first guess is that every
  // global option lives in the same object.
  //
  // The ripple is a purely decorative animation, and SPEC.md 14 treats an
  // unobtrusive, keyboard-reachable interface as an accessibility requirement
  // rather than a preference. Its absence is not detectable by a screen reader,
  // but its presence is a WCAG 2.3.3-adjacent risk for a user with a vestibular
  // disorder, on a button that gains nothing from it. Motion that carries
  // meaning - a spinner during a submit - is left enabled.
  provideNzWave({ disabled: true }),
];
