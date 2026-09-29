/**
 * Start the mock server, if this build should have one.
 *
 * ## The gate
 *
 * Mocks run in an Angular development build and nowhere else. The signal is
 * `ngDevMode`, which Angular sets to `true` under `ng serve` and `false` in a
 * production build.
 *
 * An earlier version checked `location.port === '4200'`, which read well and was
 * wrong in a way that only shows up on someone else's machine: `ng serve --port
 * 4300` to get past a busy port, or a colleague whose default moved, and the
 * mocks silently switch off with no warning. Every request then fails against a
 * backend that is not running, and the obvious conclusion - "the mock server is
 * broken" - is the wrong one. `ngDevMode` follows the build, not the port, so
 * there is no configuration that turns fixtures on in production either.
 *
  * The mock module is imported *dynamically*, and that is deliberate. A static
 * import puts `msw/browser` and its 34 dependencies in the initial chunk of
 * every build, which measurably doubled the bundle - 265 kB to 559 kB - to ship
 * a tool that then refuses to start. Because the gate runs first, the chunk is
 * emitted but never fetched outside development. `check-bundle-budget.mjs`
 * asserts that, and is measured rather than assumed: the gzipped size of that
 * regression is 177.5 kB, still inside the 250 kB budget, so the size gate alone
 * would not have caught it.
 */
import { API_BASE_URL } from '../app/core/api/api-base-url';


/**
 * Origin of the CivicLens API, for deciding which requests MSW has an opinion
 * about.
 *
 * Derived from the shared base URL rather than repeated, because a literal here
 * would be a fourth copy of `http://localhost:8080` and the two would drift: the
 * base URL would change for the app and the mock would keep failing requests
 * that are, in fact, unhandled - or worse, pass them through to a real server.
 */
const API_ORIGIN = new URL(API_BASE_URL).origin;

export async function enableMocking(): Promise<void> {
  if (!isDevelopmentBuild()) {
    return;
  }

  const { worker } = await import('./browser');

  await worker.start({
    // An unhandled request to the API fails loudly rather than passing through to
    // the real server. MSW's default warns and lets it through, which during
    // development means a typo in a path silently hits `localhost:8080`, or a
    // route with no mock yet fails with a connection error instead of a clear "no
    // handler for this". Failing loudly makes the mock set a specification rather
    // than a suggestion.
    //
    // Strict on the API, silent everywhere else - and the second half is not a
    // softening. A service worker sees *every* request the page makes, including
    // the dev server's own: `/@ng/component?c=...` is how the Angular dev server
    // streams a lazily loaded component. A blanket `'error'` turned that into a
    // 500, so `Failed to fetch dynamically imported module` and no route could
    // ever load. The strictness that is worth having is "a CivicLens endpoint has
    // no mock", and that is a statement about the API origin, not about every
    // request on the page.
    onUnhandledRequest: (request) => {
      let origin: string;
      try {
        origin = new URL(request.url).origin;
      } catch {
        return 'bypass';
      }
      return origin === API_ORIGIN ? 'error' : 'bypass';
    },
    // Named, so it is obvious in the network panel which responses are
    // synthetic. An unattributable response during a bug hunt is worse than no
    // mock at all.
    quiet: false,
    serviceWorker: { url: '/mockServiceWorker.js' },
  });

  console.info(
    '%cCivicLens%c mock server active. Fixtures only - nothing here is real data.',
    'font-weight:bold',
    'color:#666',
  );
}

/**
 * Whether this is an Angular development build.
 *
 * Angular sets `ngDevMode` to a truthy object of performance counters under
 * `ng serve`, and to `false` in a production build. The flag is read through
 * `globalThis` rather than referenced directly, because `@angular/core` already
 * declares it globally and redeclaring it here is a `TS2451`. Truthiness is the
 * test, and it is the right one: the build optimiser rewrites `ngDevMode` checks
 * in a production build, so "defined and not false" is what actually separates
 * the two cases. An absent flag is not evidence of a development build, so the
 * mocks stay off.
 */
function isDevelopmentBuild(): boolean {
  const flag = (globalThis as { ngDevMode?: unknown }).ngDevMode;
  return typeof flag !== 'undefined' && flag !== null && flag !== false;
}
