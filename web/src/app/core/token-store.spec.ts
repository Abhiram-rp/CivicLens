import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { TokenStore } from './token-store';

/**
 * SPEC 7.1 requires the access token to live in memory and never in
 * `localStorage`. These tests assert that by checking storage is untouched
 * across a full set/clear cycle, rather than by asserting on the absence of a
 * method - a store could reach for storage without exposing anything obvious.
 */
describe('TokenStore', () => {
  let store: TokenStore;
  let saved: Record<string, string>;

  beforeEach(() => {
    saved = {};
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
    store = TestBed.inject(TokenStore);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('holds a token in memory after set', () => {
    store.set('access_abc', 900);
    expect(store.current()).toBe('access_abc');
  });

  it('never writes the access token to storage', () => {
    store.set('access_abc', 900);
    store.clear();

    // A token in localStorage is readable by any script on the page and outlives
    // the tab, which is the whole reason the refresh token is an HttpOnly cookie
    // and this one is not persisted at all.
    expect(JSON.stringify(saved)).not.toContain('access_abc');
    expect(saved).toEqual({});
  });

  it('clears the token and its expiry', () => {
    store.set('access_abc', 900);
    store.clear();

    expect(store.current()).toBeNull();
    expect(store.expiresAtMs()).toBe(0);
  });

  it('treats an absent token as already expiring', () => {
    // The interceptor relies on this to skip a pointless refresh attempt for a
    // signed-out visitor.
    expect(store.isExpiringWithin()).toBe(true);
  });

  it('does not consider a fresh token expiring', () => {
    store.set('access_abc', 900);
    expect(store.isExpiringWithin()).toBe(false);
  });

  it('reports a token as expiring before the skew window', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-28T12:00:00Z'));
      // 15-minute access token (SPEC 7.1).
      store.set('access_abc', 900);

      // A token that looks valid for 30s will very likely have expired by the
      // time the request and the refresh round trip complete, so refresh early.
      vi.setSystemTime(new Date('2026-09-28T12:14:30Z'));
      expect(store.isExpiringWithin(60_000)).toBe(true);

      vi.setSystemTime(new Date('2026-09-28T12:10:00Z'));
      expect(store.isExpiringWithin(60_000)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('computes expiry from the moment it was set, not from construction', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-28T12:00:00Z'));
      store.set('first', 60);

      vi.setSystemTime(new Date('2026-09-28T12:05:00Z'));
      store.set('second', 900);

      // A second login must reset the clock, not extend the first token's.
      expect(store.current()).toBe('second');
      expect(store.expiresAtMs()).toBe(Date.parse('2026-09-28T12:20:00Z'));
      expect(store.isExpiringWithin(60_000)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
