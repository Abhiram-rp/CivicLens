import {
  ApplicationConfig,
  Injector,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';
import { routes } from './app.routes';
import { configureApiClient } from './core/api/api-client.config';
import { civiclensNgZorroProviders } from './ui/ng-zorro.providers';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),

    // Zoneless change detection, stated explicitly.
    //
    // This used to be `provideZoneChangeDetection({ eventCoalescing: true })`,
    // which is the setting the CLI writes when Zone.js is present. It is not
    // present: zone.js is not a dependency and there are no polyfills, so Angular
    // threw `NG0908: In this configuration Angular requires Zone.js` during
    // bootstrap and the application rendered an empty `<app-root>`.
    //
    // Nothing caught that, because `app.spec.ts` builds the `App` component in
    // isolation and never goes through `bootstrapApplication` with this config.
    // The whole application had never been loaded in a browser.
    //
    // Zoneless is also the better answer on the merits rather than the only one.
    // Angular 22 is zoneless by default, SPEC 14 leans on Signals for local and UI
    // state, and a citizen is not served by a `patchEvent`-and-hope scheduler. A
    // component that needs a change-detection tick has to say so, by reading a
    // signal - which is the behaviour the spec asks for anyway.
    provideZonelessChangeDetection(),

    // Installs the interceptor chain on the generated client, before any
    // component or route can issue a request, so no code path can reach it with
    // an empty chain.
    //
    // This has to be a provider rather than a statement at module scope, because
    // the interceptors need `AuthService` and `TrackingTokenStore` and so the
    // call needs an injection context. A module-scope call can only `inject()`
    // if it is passed an `Injector`, and no injector exists at import time - which
    // is exactly why the interceptors were originally calling `inject()`
    // themselves, and failing at runtime.
    //
    // `configureApiClient` mutates a module-level singleton, which is not
    // something the injector can represent as a `Provider`; that is the one
    // thing an initializer is for. It is idempotent, so a spec that imports this
    // config and a second one that calls it directly cannot end up with the chain
    // twice - and a doubled chain is not harmless, because one 401 would then
    // trigger two refreshes and SPEC 7.1 revokes the token family on a replay.
    provideAppInitializer(() => configureApiClient(inject(Injector))),

    provideRouter(
      routes,
      // Route params and query params become component inputs, so a page reads
      // `issueId` as an input rather than reaching into the ActivatedRoute. This
      // is what keeps the tracked pages from ever needing a token in the URL.
      withComponentInputBinding(),
      // Restores the scroll position on back/forward, which a citizen
      // navigating away from a long report and returning expects.
      withInMemoryScrolling({ scrollPositionRestoration: 'enabled' }),
    ),

    // --- NG-ZORRO (Ant Design for Angular), per REQUIREMENTS.md 34 ----------
    //
    // Locale, icon allowlist, component defaults and the disabled press ripple,
    // each with its reasoning. Exported rather than inlined so the specs that
    // render a shell can supply the identical configuration - a test that
    // renders an `nz-icon` without `provideNzIcons` does not fail, it hangs.
    ...civiclensNgZorroProviders,
  ],
};
