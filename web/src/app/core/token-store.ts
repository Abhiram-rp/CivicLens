import { Injectable, signal } from '@angular/core';

/**
 * The access token, held in memory and nowhere else.
 *
 * SPEC 7.1: "Access tokens live in memory in Angular, never `localStorage`."
 * A token in localStorage is readable by any script on the page, survives the
 * tab closing, and is attached to a request after the user has walked away.
 * The cost of that choice is real - a reload logs the user out and a silent
 * refresh must re-establish the session - and it is the cost the spec accepts.
 *
 * The refresh token is not here at all: for WEB it is an HttpOnly
 * SameSite=Strict cookie, which JavaScript cannot read in the first place.
 *
 * A signal rather than a BehaviorSubject: this is read during request
 * construction, never composed into an observable stream.
 */
@Injectable({ providedIn: 'root' })
export class TokenStore {
  /** Null means "no session". Never a cached copy of a previous session. */
  private readonly accessToken = signal<string | null>(null);

  /** Epoch milliseconds; used to decide when a proactive refresh is due. */
  private readonly expiresAt = signal<number>(0);

  readonly current = this.accessToken.asReadonly();
  readonly expiresAtMs = this.expiresAt.asReadonly();

  set(accessToken: string, expiresInSeconds: number): void {
    this.accessToken.set(accessToken);
    this.expiresAt.set(Date.now() + expiresInSeconds * 1000);
  }

  clear(): void {
    this.accessToken.set(null);
    this.expiresAt.set(0);
  }

  /**
   * Whether a refresh is worth attempting before the server would reject us.
   *
   * The skew is deliberate: refresh itself takes a round trip, so a token that
   * looks valid for another two seconds may well have expired by the time the
   * request lands. Refreshing slightly early costs nothing; a 401 costs the
   * user a visible failure.
   */
  isExpiringWithin(skewMs = 60_000): boolean {
    const token = this.accessToken();
    return token === null || this.expiresAt() - Date.now() <= skewMs;
  }
}
