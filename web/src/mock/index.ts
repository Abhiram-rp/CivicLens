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
 * emitted but never fetched outside development.
 */
export async function enableMocking(): Promise<void> {
  if (!isDevelopmentBuild()) {
    return;
  }

  const { worker } = await import('./browser');

  await worker.start({
    // An unhandled request fails loudly rather than passing through to the real
    // server. MSW's default warns and lets it through, which during development
    // means a typo in a path silently hits `localhost:8080`, or a route with no
    // mock yet fails with a connection error instead of a clear "no handler for
    // this". Failing loudly makes the mock set a specification rather than a
    // suggestion.
    onUnhandledRequest: 'error',
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
