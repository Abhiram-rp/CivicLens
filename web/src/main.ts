import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { enableMocking } from './mock';

// Mocking starts before `bootstrapApplication` and the result is awaited, so no
// component can issue a request in the window between the first paint and the
// worker taking control of the network. `enableMocking` is a no-op outside the dev
// server, so this call site stays unconditional and there is no environment
// branch here that can drift out of sync with the one in `mock/index.ts`.
await enableMocking();

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
