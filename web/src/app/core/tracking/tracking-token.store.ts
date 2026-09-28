import { Injectable, signal } from '@angular/core';

/**
 * The concealed-report tracking token.
 *
 * This is the one CivicLens credential that is deliberately persisted to
 * `localStorage`, and it is worth being clear about why that is defensible
 * while the access token is not (see TokenStore): a concealed report is
 * reachable only by this token, there is no account to re-authenticate against
 * and no second factor, and the alternative - holding it in memory - means
 * every accidental reload silently strands a citizen's own report with no way
 * back in. The trade is deliberate and the blast radius is one report.
 *
 * Invariants this class exists to hold:
 *
 *  1. The token is never placed in a route, query string, fragment or
 *     `Referer`. Copying the address bar must not produce a working link, so
 *     there is no code path here that accepts a token from a URL. Reading one
 *     out of the address bar would be the bug this whole design avoids.
 *  2. It is never logged, never echoed into a message, never included in
 *     error reporting. It is a bearer credential.
 *  3. It is cleared on an explicit "forget this report", and only then.
 *  4. There is no recovery. SPEC is explicit that a lost tracking token cannot
 *     be recovered - recovery of a concealed report runs through the verified
 *     contact channel instead, which is a deliberate privacy trade and not an
 *     oversight. So nothing in this class may grow a "recover my token" path.
 */
@Injectable({ providedIn: 'root' })
export class TrackingTokenStore {
  /**
   * Namespaced so it cannot collide with another app on the same origin, and
   * versioned in the key so a future token format change can be detected rather
   * than misread.
   */
  private static readonly KEY = 'civiclens.trackingToken.v1';

  private readonly token = signal<string | null>(null);
  readonly current = this.token.asReadonly();

  constructor() {
    this.token.set(this.read());
  }

  /** Persist a token, replacing any previous one. */
  save(token: string): void {
    this.token.set(token);
    this.write(token);
  }

  /**
   * "Forget this report": the citizen's explicit request to drop local access.
   *
   * This removes the copy on this device. It cannot and does not revoke the
   * token server-side - a caller may well be on a shared or borrowed machine
   * where the person forgetting is not the original reporter. Revocation is
   * the contact flow's job.
   */
  forget(): void {
    this.token.set(null);
    this.clearStorage();
  }

  /**
   * Forget every concealed report held on this device.
   *
   * Note this leaves `/tracked/**` reachable-but-empty: the surface can no
   * longer read any report, because the token is gone. Concealment does not
   * fail open.
   */
  forgetAll(): void {
    this.forget();
  }

  private read(): string | null {
    try {
      return this.storage()?.getItem(TrackingTokenStore.KEY) ?? null;
    } catch {
      // A browser with storage disabled (private mode, blocked third-party
      // context) is not an error here: the token still works for this session
      // from memory, and the citizen can still reach their report now.
      return null;
    }
  }

  private write(token: string): void {
    try {
      this.storage()?.setItem(TrackingTokenStore.KEY, token);
    } catch {
      // Same reasoning as `read`. Session-only tracking is degraded but working;
      // throwing would strand a citizen who has just successfully reported.
    }
  }

  private clearStorage(): void {
    try {
      this.storage()?.removeItem(TrackingTokenStore.KEY);
    } catch {
      // Nothing useful to do; the in-memory copy is already gone.
    }
  }

  private storage(): Storage | null {
    return typeof localStorage === 'undefined' ? null : localStorage;
  }
}
