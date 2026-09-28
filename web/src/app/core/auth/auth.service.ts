import { Injectable, inject } from '@angular/core';
import { BehaviorSubject, EMPTY, Observable, catchError, finalize, from, map, tap } from 'rxjs';
import { Auth } from '../../api/generated';
import type {
  CurrentUser,
  LoginRequest,
  LoginResponse,
  RegisteredUser,
  RegisterRequest,
  TokenRefreshResponse,
} from '../../api/generated';
import { TokenStore } from '../token-store';
import { call } from '../api/api-call';
import { isErrorEnvelope } from '../api/api-error';

/**
 * Session state, and the only thing that should mutate `TokenStore`.
 *
 * SPEC 14 asks for an RxJS `BehaviorSubject` for session state, against Signals
 * for local and UI state. The split is not ceremony:
 *
 * - Session state is an *event* stream. It is written by network responses, it
 *   is read by an interceptor and a guard, and it must survive a component being
 *   destroyed. A `BehaviorSubject` replays the current value to a late
 *   subscriber, which is what stops a guard from briefly seeing "logged out"
 *   during a refresh and redirecting a signed-in user away.
 * - UI state (is this menu open, is this form dirty) is *not* an event stream.
 *   Signals are the better tool and are used for that.
 *
 * `BehaviorSubject` rather than plain `Subject` for the same reason: every
 * subscriber here may arrive after login has already happened.
 *
 * ## Why `from()` wraps every SDK call
 *
 * The generated SDK is promise-based, not Observable-based. Rather than fight
 * that, this service keeps an Observable *interface* - so callers get
 * `retry`/`takeUntil`/unsubscription - and converts at the boundary. The
 * conversion is one line per call and worth it: an Observable returned from a
 * service is something a component can cancel, and a raw promise is not.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly tokens = inject(TokenStore);

  /**
   * Null means "no session". Never a stale user retained after sign-out - a
   * retained object here would keep a signed-out citizen's shell rendering
   * their name and report list.
   */
  private readonly userSubject = new BehaviorSubject<CurrentUser | null>(null);

  /** The current user, replayed to every new subscriber. */
  readonly user$: Observable<CurrentUser | null> = this.userSubject.asObservable();

  /** Emits only when a user is signed in, for guards and conditional templates. */
  readonly signedIn$: Observable<boolean> = this.user$.pipe(map((user) => user !== null));

  readonly role$ = this.user$.pipe(map((user) => user?.role ?? null));

  /**
   * The synchronous view of the session, for the interceptor and route guard.
   *
   * An interceptor cannot await a subscription before attaching a header, and a
   * guard needs a value during the navigation, so this is the one place the
   * `BehaviorSubject` is read synchronously. It is a peek at the value the
   * stream already holds, not a second source of truth.
   */
  get snapshot(): CurrentUser | null {
    return this.userSubject.value;
  }

  get accessToken(): string | null {
    return this.tokens.current();
  }

  get isSignedIn(): boolean {
    return this.snapshot !== null;
  }

  /** True when the current role is any of `roles` (SPEC 3). */
  hasRole(...roles: NonNullable<CurrentUser['role']>[]): boolean {
    const role = this.snapshot?.role;
    return role !== undefined && roles.includes(role);
  }

  /**
   * Sign in and adopt the session.
   *
   * `clientType: WEB` is not optional: it is what makes the server deliver the
   * refresh token as an HttpOnly SameSite=Strict cookie instead of a body the
   * SPA would have to hold in JavaScript, where SPEC 7.1 says it must not live.
   */
  login(request: Omit<LoginRequest, 'clientType'>): Observable<CurrentUser> {
    return from(call<LoginResponse>(Auth.login({ body: { ...request, clientType: 'WEB' } }))).pipe(
      tap((response) =>
        this.adoptSession(response.accessToken, response.expiresIn, response.user),
      ),
      map((response) => response.user),
    );
  }

  register(request: RegisterRequest): Observable<CurrentUser> {
    return from(call<RegisteredUser>(Auth.register({ body: request })));
  }

  /**
   * Exchange the refresh cookie for a new access token.
   *
   * The rotated token is set server-side and the old one is marked revoked, so
   * this is the only way to extend a session and it must be called exactly once
   * per expiry - which is why `RefreshInterceptor` collapses concurrent 401s
   * onto one in-flight request instead of letting each retry start its own.
   * Presenting an already-revoked token is treated as theft and revokes the
   * whole family, so a refresh storm is an account-level cost, not just wasted
   * requests.
   */
  refresh(): Observable<string> {
    return from(call<TokenRefreshResponse>(Auth.refreshToken())).pipe(
      tap((response) => this.tokens.set(response.accessToken, response.expiresIn)),
      map((response) => response.accessToken),
    );
  }

  /**
   * Sign out.
   *
   * `finalize` clears the local session whether or not the server call
   * succeeded. A 401 here is expected and benign - the access token may already
   * have expired, which is exactly when clearing matters most - and a network
   * failure must not leave a usable token in memory after a citizen has asked
   * to be signed out. The alternative, surfacing the failure, means telling
   * someone who clicked "sign out" that sign-out failed.
   */
  logout(): Observable<void> {
    return from(call<void>(Auth.logout())).pipe(
      catchError((error: unknown) => {
        if (!isErrorEnvelope(error)) {
          // An envelope means CivicLens answered and declined; that is already
          // recorded in the server's audit trail. Anything else is a transport
          // fault, worth a console breadcrumb but not a dialog.
          console.warn('logout request failed; clearing the local session anyway', error);
        }
        return EMPTY;
      }),
      finalize(() => this.clearSession()),
      map(() => undefined),
    );
  }

  /**
   * Drop the local session without calling the server.
   *
   * Used by the 401 handler once a refresh has already failed: there is nothing
   * left to revoke, and retrying would loop.
   */
  clearSession(): void {
    this.tokens.clear();
    this.userSubject.next(null);
  }

  /** Adopt a session from a login or refresh response. Internal. */
  private adoptSession(accessToken: string, expiresIn: number, user: CurrentUser): void {
    this.tokens.set(accessToken, expiresIn);
    this.userSubject.next(user);
  }
}
