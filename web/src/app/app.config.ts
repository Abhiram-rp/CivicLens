import {
  ApplicationConfig,
  Injector,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZoneChangeDetection,
} from '@angular/core';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';
import { routes } from './app.routes';
import { configureApiClient } from './core/api/api-client.config';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),

    // Zone change detection is the default, but it is stated rather than
    // inherited: SPEC 14 leans on Signals, and the interaction between
    // signal-based UI state and zone scheduling is worth being explicit about at
    // the one place a reader can see it.
    provideZoneChangeDetection({ eventCoalescing: true }),

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
  ],
};
