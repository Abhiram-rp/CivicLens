import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/**
 * The application root.
 *
 * Deliberately almost empty. SPEC 14 gives each role its own shell
 * (`layouts/CitizenShell`, `OfficerShell`, `ManagerShell`, `AdminShell`) and
 * the router picks one per route, so the root contributes the outlet and
 * nothing else.
 *
 * There is no header, nav or landmark markup here on purpose. Four shells
 * already own that furniture, and duplicating it in the root would mean a
 * change to the skip link or the `h1` had to be made five times - which is how
 * one copy quietly loses its `aria-label`.
 */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
})
export class App {}
