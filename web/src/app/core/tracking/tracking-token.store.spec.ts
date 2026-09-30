import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { TrackingTokenStore } from './tracking-token.store';

/**
 * The tracking token is the only credential CivicLens persists to
 * `localStorage`, so these tests lean on two things: that it behaves correctly,
 * and that its API surface cannot be used to put a token in a URL.
 *
 * The second is checked by reading the class rather than by calling it, because
 * a method that accepts a URL cannot be proven safe by feeding it one.
 */
describe('TrackingTokenStore', () => {
  let store: TrackingTokenStore;
  let saved: Record<string, string>;

  beforeEach(() => {
    saved = {};
    // Minimal localStorage stand-in. jsdom provides one, but replacing it keeps
    // the assertions independent of jsdom's behaviour.
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => saved[k] ?? null,
      setItem: (k: string, v: string) => {
        saved[k] = v;
      },
      removeItem: (k: string) => {
        delete saved[k];
      },
    });

    TestBed.resetTestingModule();
    store = TestBed.inject(TrackingTokenStore);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts with no token', () => {
    expect(store.current()).toBeNull();
  });

  it('persists a saved token under a namespaced, versioned key', () => {
    store.save('tok_abc123');

    expect(store.current()).toBe('tok_abc123');
    // A bare 'token' key could collide with another app on the same origin, and
    // a stable key would be ambiguous after a future token format change.
    expect(Object.keys(saved)).toEqual(['civiclens.trackingToken.v1']);
  });

  it('hydrates an existing token on construction', () => {
    saved['civiclens.trackingToken.v1'] = 'tok_from_previous_session';

    TestBed.resetTestingModule();
    const rehydrated = TestBed.inject(TrackingTokenStore);

    expect(rehydrated.current()).toBe('tok_from_previous_session');
  });

  it('keeps one token however many reports are filed under it', () => {
    // The contract's model, and the reason this is not a bug. `listTrackedIssues`
    // is "every report created with this token... A citizen who reports from a
    // shared kiosk or a family phone accumulates several reports under one token,
    // so this is a list and not a single resource." One token per device, many
    // reports underneath it.
    //
    // So filing a second concealed report re-saves the *same* token, and replacing
    // the stored value loses nothing. A previous version of this test described
    // replacing as the goal in its own right, which is the reasoning that would
    // have quietly capped a citizen at one concealed report had the server ever
    // issued a per-report token instead.
    store.save('trk_same');
    store.save('trk_same');

    expect(store.current()).toBe('trk_same');
    expect(Object.keys(saved)).toHaveLength(1);
  });

  it('forget clears both the in-memory value and the stored copy', () => {
    store.save('tok_abc123');
    store.forget();

    expect(store.current()).toBeNull();
    expect(saved['civiclens.trackingToken.v1']).toBeUndefined();
  });

  it('forgetAll drops access to every report on this device', () => {
    // Not an alias of `forget` by accident. One token grants access to every
    // concealed report filed from this browser, so forgetting it *is* forgetting
    // all of them - the reports themselves are untouched server-side, which is
    // what the "cannot revoke" note on `forget` is about.
    store.save('tok_abc123');
    store.forgetAll();

    expect(store.current()).toBeNull();
    expect(saved['civiclens.trackingToken.v1']).toBeUndefined();
  });

  it('keeps working in memory when storage is unavailable', () => {
    // Private browsing and blocked third-party contexts both produce a
    // localStorage that throws on write. A citizen who has just successfully
    // reported must not be stranded by that, so the session-only fallback is
    // the required behaviour, not a degradation to apologise for.
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('storage disabled');
      },
      setItem: () => {
        throw new Error('storage disabled');
      },
      removeItem: () => {
        throw new Error('storage disabled');
      },
    });

    TestBed.resetTestingModule();
    const sessionOnly = TestBed.inject(TrackingTokenStore);

    expect(() => sessionOnly.save('tok_abc123')).not.toThrow();
    expect(sessionOnly.current()).toBe('tok_abc123');
    expect(() => sessionOnly.forget()).not.toThrow();
    expect(sessionOnly.current()).toBeNull();
  });

  it('exposes no way to accept a token from a URL', () => {
    // SPEC 14: the token is never placed in a route, a query string or a
    // `Referer`, so a shared link to /tracked/... must be impossible to
    // construct by copying the address bar. The guard against that is the
    // absence of an ingestion point, so it is asserted as an absence.
    //
    // Only the public surface is checked. `private` members are a TypeScript
    // convention rather than a runtime boundary, so they are still on the
    // prototype and would make this list longer without changing the API.
    const INTERNAL = ['read', 'write', 'clearStorage', 'storage'];
    const publicMethods = Object.getOwnPropertyNames(TrackingTokenStore.prototype)
      .filter((name) => name !== 'constructor' && !INTERNAL.includes(name))
      .sort();

    expect(publicMethods).toEqual(['forget', 'forgetAll', 'save']);
    // A method that took a URL, a query string or a route parameter would be the
    // bug this rule exists to prevent, so the plausible names are named
    // explicitly - the assertion above already fails on any addition, and this
    // says what the addition would have been for.
    for (const forbidden of ['fromUrl', 'fromQueryParam', 'readFromLocation', 'hydrate']) {
      expect(publicMethods).not.toContain(forbidden);
    }
  });

  it('never puts the token into a string a log could capture', () => {
    // A store that stringifies itself into a log line, or an error message, is a
    // leak. The property is the only state the class holds, so asserting it is
    // opaque keeps the rule visible next to the code that could break it.
    const token = 'tok_abc123';
    store.save(token);

    expect(JSON.stringify({ ...store })).not.toContain(token);
  });
});
