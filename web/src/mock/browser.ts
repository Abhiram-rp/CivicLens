import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';

/**
 * The browser-side mock server.
 *
 * `onUnhandledRequest: 'error'` is the important setting. The default warns and
 * passes the request through to the real server, which during development means
 * a typo in a path silently hits `localhost:8080` - or a route that has no mock
 * yet fails with a connection error instead of a clear "no handler for this".
 * Failing loudly is what makes the mock set a specification rather than a
 * suggestion.
 */
export const worker = setupWorker(...handlers);
