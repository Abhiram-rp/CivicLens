import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZoneChangeDetection,
} from '@angular/core';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';
import { routes } from './app.routes';
import { configureApiClient } from './core/api/api-client.config';

// Runs at import time, before any component or route can issue a request, so no
// code path can reach the generated client with an empty interceptor chain.
//
// This is a statement rather than a `providers` entry on purpose: it mutates the
// generated client's module-level singleton, which is not something Angular's
// injector can represent as a `Provider`. It is also idempotent - the function
// returns early once the chain is installed - so a spec that imports this config
// and a second one that calls it directly cannot end up with it twice. A double
// chain is not a harmless duplicate: one 401 would trigger two refreshes, and
// SPEC 7.1 revokes the token family on a replayed refresh.
configureApiClient();

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),

    // Zone change detection is the default, but it is stated rather than
    // inherited: SPEC 14 leans on Signals, and the interaction between
    // signal-based UI state and zone scheduling is worth being explicit about at
    // the one place a reader can see it.
    provideZoneChangeDetection({ eventCoalescing: true }),

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
