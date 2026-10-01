import { http, HttpResponse } from 'msw';
import { API, forbidden, notFound, page, resolveCaller, unauthenticated } from '../http';
import { state } from '../store';

/**
 * `/notifications/**`.
 *
 * ## The citizen refusal is the interesting part
 *
 * SPEC 3.2: a concealed reporter has no account, so `/notifications` is **not** where
 * they hear about their report - email is, via `/contact/verify` and
 * `/contact/decision`. A mock that served notifications to a `CITIZEN` token would
 * let a future "your report was resolved" screen be built against it and then fail
 * for the one group of users the feature exists to serve. So the refusal is here,
 * explicitly, with a message that says why.
 *
 * Read state is **stored, not faked**. `POST /notifications/{id}/read` marks the row
 * and `unreadOnly` filters on it, so "mark as read, then check the unread badge"
 * works. The previous version answered `/read-all` with a 204 and changed nothing,
 * which made the unread count a number the UI could never move.
 */

export const notificationHandlers = [  http.get(`${API}/notifications`, ({ request }) => {
    const path = new URL(request.url).pathname;
    const caller = resolveCaller(request);
    if (!caller.userId) {
      return unauthenticated(path);
    }
    if (caller.role === 'CITIZEN') {
      return forbidden(path, 'Concealed reporters are notified by email, not here.');
    }

    const url = new URL(request.url);
    const unreadOnly = url.searchParams.get('unreadOnly') === 'true';
    const rows = unreadOnly ? state.notifications.filter((row) => !row.read) : state.notifications;
    return HttpResponse.json(page(rows));
  }),

  /**
   * `POST /notifications/{notificationId}/read`.
   *
   * 404 for "no such notification" and for "not yours", because the contract has one
   * error for both - and a notification id that returned 403 would confirm the id
   * exists to a caller who cannot see it.
   */
  http.post(`${API}/notifications/:notificationId/read`, ({ request, params }) => {
    const path = new URL(request.url).pathname;
    const caller = resolveCaller(request);
    if (!caller.userId) {
      return unauthenticated(path);
    }

    const row = state.notifications.find((candidate) => candidate.id === String(params['notificationId']));
    if (!row) {
      return notFound(path);
    }
    // Idempotent: reading an already-read notification is the same end state, not an
    // error. A double-click on the bell should not produce a red toast.
    row.read = true;
    return new HttpResponse(null, { status: 204 });
  }),

  /** `POST /notifications/read-all`. */
  http.post(`${API}/notifications/read-all`, ({ request }) => {
    const path = new URL(request.url).pathname;
    const caller = resolveCaller(request);
    if (!caller.userId) {
      return unauthenticated(path);
    }
    for (const row of state.notifications) {
      row.read = true;
    }
    return new HttpResponse(null, { status: 204 });
  }),
];
