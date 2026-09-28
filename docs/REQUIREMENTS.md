# CivicLens — Technical Requirements

**What this document is:** the concrete, checkable prerequisites and constraints for building CivicLens — toolchain, runtime, libraries, environments, and the non-negotiable behaviours each layer must satisfy. `docs/SPEC.md` defines *what the system is*; this file defines *what has to be true for it to build and run correctly*.

**Status of the toolchain on this machine is verified as of 2026-09-28.** Anything marked ✅ is present and checked. Anything marked ⬜ must be provided or installed.

---

## 1. Runtime prerequisites

| Requirement | Version | Status |
|---|---|---|
| JDK | 21 toolchain (builds fine on your JDK 25 via Maven compiler release) | ✅ 25.0.1 installed |
| Maven | 3.9+ | ✅ 3.9.12 |
| Node.js | `^22.22.3 \|\| ^24.15.0 \|\| >=26.0.0` — required by Angular 22 | ✅ 24.16.0 |
| TypeScript | `>=6.0 <6.1` — required by Angular 22's compiler | ⬜ installed by Angular CLI, do not downgrade |
| Docker Engine + Compose v2 | Engine 29.x, Compose v2 | ✅ 29.8.0, engine running |
| Git | 2.4x+ | ✅ 2.52.0 |
| Browser | Evergreen desktop + Android Chrome for the low-end test | ⬜ |
| `psql` client | **not required** — use `docker compose exec postgres psql` | n/a |
| AI provider API key | Optional. Empty = `FakeAiAdapter` runs everything | ⬜ not required |

**Ports required to be free:** `4200` Angular dev server · `8080` API · `5432` PostgreSQL · `9000`/`9001` MinIO API/console · `6379` Redis (P2) · `5672`/`15672` RabbitMQ (P2).

**Minimum free disk:** 20 GB (Postgres + MinIO volumes + Maven cache + `node_modules`).

---

## 2. Frontend requirements

| Requirement | Detail |
|---|---|
| Framework | Angular **22.2.0**, standalone components, lazy-loaded routes |
| UI kit | Angular Material **22.2.0** + CDK 22.2.0 (RxJS `^7.4.0`) |
| State | Signals for local/UI state; RxJS `BehaviorSubject` services for session state. **No NgRx** |
| Language | TypeScript `>=6.0 <6.1`, strict mode |
| Forms | Typed reactive forms, validation messages mirroring the backend's error `details[]` |
| Maps | Leaflet + OpenStreetMap. GPS coordinates are the primary location input on every device; map-drag is an optional refinement, never the only path |
| Styling | Material with an **explicitly defined accessible theme** — Material's stock theme does not meet WCAG 2.1 AA, and AA is a launch gate |
| HTTP | Two interceptors: auth (attach bearer, transparent single refresh on 401, no retry storm) and correlation-id (surface `traceId` from error envelopes) |
| Token storage | Access token in **memory only**, never `localStorage`/`sessionStorage` |
| Routing | Role guards for UX only — the backend is the security boundary and re-checks everything |
| Vocabulary | UI says "Report"; domain/API/DB say `issue` |

**Unit test runner:** whatever `ng new` wires up in v22 (Vitest replaced Karma; Karma removed in v21). Confirm with `ng test --help` at scaffold time and record it here.

---

## 3. Backend requirements

| Requirement | Detail |
|---|---|
| Framework | Spring Boot **4.1.x** (Web MVC, Security, Data JPA, Validation, Actuator) |
| Language | Java 21 |
| Auth | Spring Security + JWT access (15 min) + rotating refresh (7 days) |
| API docs | springdoc-openapi **3.1.x** — the supported pairing for Boot 4. Swagger UI is the contract the future mobile team consumes |
| Persistence | Spring Data JPA + Hibernate, HikariCP. Flyway migrations, never edit an applied one |
| Error model | `@RestControllerAdvice` mapping domain exceptions to the standard envelope with `traceId` |
| Scheduling | `@Scheduled` SLA evaluator, single-instance safe (ShedLock or DB flag) |
| Messaging | Spring AMQP / RabbitMQ from P2 |
| Resilience | Bounded retries with backoff, DLQ, circuit breaker, daily AI cost cap |
| Observability | Actuator + Micrometer, structured JSON logs, correlation ID filter, `/actuator/health` for uptime monitoring |
| Fallback | `Spring Boot 4.1.x + springdoc 3.1.x` → `Spring Boot 3.5.x + springdoc 2.9.x` is a one-line version change, not a rewrite |

---

## 4. Data and infrastructure requirements

| Component | Version | Phase | Local (Compose) | Production |
|---|---|---|---|---|
| PostgreSQL | 16 with `vector` + `pgcrypto` | P1 | `postgres:16` | managed Postgres with pgvector enabled |
| Redis | 7 | P2 | `redis:7` | managed Redis or same host |
| RabbitMQ | 3.13+ | P2 | `rabbitmq:3-management` | managed or CloudAMQP |
| MinIO / S3 | latest | P1 | `minio` | S3, R2, or AWS S3 |
| Mail catcher | — | P2 | Mailpit (SMTP + web UI) | transactional provider (Resend or SES) |

- **No Kubernetes.** Single VPS with Docker Compose + Caddy for automatic HTTPS.
- **No PostGIS.** Bounding-box pre-filter in SQL, Haversine in Java.
- Postgres backups: daily automated, **with a performed restore drill**, not merely a configured job.

---

## 5. AI requirements

| Requirement | Detail |
|---|---|
| Integration | Ports only: `AiClassificationPort`, `AiVisionPort`, `AiEmbeddingPort`, `AiSummarizationPort` |
| First adapter | Anthropic (`claude-sonnet-5` default, `claude-haiku-4-5` optional cheap tier), model IDs per-port config, never hard-coded |
| Test adapter | `FakeAiAdapter`, deterministic. **Selected automatically when the API key is empty.** No test and no CI job may make a real API call |
| Structured output | Every call returns JSON validated against an explicit schema; non-conforming output is discarded, never retried indefinitely |
| Injection hardening | Citizen text/images wrapped in a delimited, explicitly-untrusted data block; output is never executed |
| Confidence gate | `< 0.6` → stored as a suggestion, **never auto-applied**, routed to manual triage. Configurable |
| Timeouts | 8 s classification/embedding, 15 s vision |
| Retries | 3 attempts, 5 s / 30 s / 120 s, then DLQ → issue falls back to `TRIAGED` with `ai_unavailable = true` |
| Cost control | Classify once per issue, embed once, summarize only at `RESOLVED` or on rate-limited manual regenerate, hard daily USD cap |
| Degradation | AI infrastructure absent → reporting, triage and resolution unaffected |
| Embeddings | Provider and vector dimension decided in the **P3 migration**. Anthropic has no embeddings API, so this is a second vendor (Voyage AI 1024-dim is the leading candidate) or a self-hosted model |

---

## 6. API contract requirements

- **The contract is authored, not derived.** `api/openapi/civiclens-v1.yaml` is written first and linted in CI; the Angular client is generated from it and the Spring Boot controllers are written to match it exactly.
- CI must diff springdoc's generated `/v3/api-docs` against the hand-authored file and **fail on any difference**. Until the backend exists the hand-authored file is the only contract, and nothing can drift from it.
- Base path `/api/v1`; never break it, add `/api/v2`.
- DTOs at the boundary; entities are never serialized.
- Pagination on every list; default page size 20, max 100.
- `Idempotency-Key` header on `POST /issues`; replay returns the original 201 body — including the original tracking token, re-derived rather than read back — not an error.
- Tracking tokens are `HMAC-SHA256(TRACKING_TOKEN_PEPPER, "trk" || creation_nonce || issue_id)`. No column in any table, including the idempotency store, holds a token in plaintext.
- `x-required-roles` is empty on `POST /issues`, so the CITIZEN check is a service-layer rule: a valid `FIELD_OFFICER`, `DEPARTMENT_MANAGER` or `ADMIN` token is 403, never a citizen report attributed to a staff account.
- `multipart/form-data` for issue create and resolve.
- Standard error envelope with `code`, `message`, `path`, `traceId`, optional `details[]`.
- **404-not-403** for anything the caller cannot see; 403 only when the role could never use the endpoint.
- Public endpoints return a dedicated redacted DTO with an explicit field allowlist.
- `x-required-roles` on every operation is the authoritative authorization rule; a test asserts each one matches a `@PreAuthorize` in the backend. Operations that accept a session **or** a tracking token carry an empty list and are authorized in the service layer — that exception is enumerated in the contract header, not left implicit.
- Free-text `q` is P2, on `GET /issues` only, never on a public surface, and never unscoped for a citizen.
- OpenAPI published at `/v3/api-docs` with Swagger UI, plus Redoc from the authored file.

---

## 7. Security requirements (mandatory, per feature)

- [ ] Explicit `@PreAuthorize` on every controller/service method; no reliance on URL patterns
- [ ] 404-not-403 applied to every resource **and sub-resource**
- [ ] BCrypt cost ≥ 12; passwords never logged, never in any DTO
- [ ] Refresh rotation genuinely revokes the prior token; reuse detection revokes the family
- [ ] CORS allow-list is the actual origin(s), never `*`
- [ ] Uploads: magic-byte validation, ≤5 MB/file, ≤15 MB total, 3 photos, server-generated key, signed URL TTL ~5 min, EXIF GPS stripped
- [ ] Rate limits on login, register, issue create, comments, public reads, `/tracked/**`, AI paths; rolling window per bucket; **fails open** on a Redis outage with a logged warning
- [ ] Rate-limited responses carry `X-RateLimit-Limit` / `-Remaining` / `-Reset` / `-Bucket` on **success** as well as 429, and `Retry-After` on 429; `node scripts/check-rate-limit-pairing.mjs` exits 0
- [ ] Rate-limit bucket identity is a user id or a **salted, rotating IP hash** - never a raw IP in a Redis key, and never in a response header: `X-RateLimit-Bucket` carries the coarse name only, asserted by a test that fails if a hash or user id appears in it
- [ ] The full Redis key (name + identity) is present in logs and metrics, so support can still diagnose a limit the client is not told about
- [ ] Secrets 100% environment-sourced; `.env` gitignored; gitleaks in CI
- [ ] Audit log captures status changes, assignments, role changes, SLA policy changes, user enable/disable, priority downgrades, comment edits/deletes
- [ ] IDOR test per endpoint that reads or writes an owned resource
- [ ] Public DTOs asserted PII-free by serializing them in a test
- [ ] `public_code` is never accepted as a credential anywhere
- [ ] Tracking tokens are derived from a nonce and persisted hashed only; **no table holds a token in plaintext**, idempotency store included — asserted by scanning every column, not by reading the create path
- [ ] A replayed `Idempotency-Key` on an anonymous submit returns the original `trackingToken`, re-derived from `creation_nonce`, and does so *after* the idempotency TTL has elapsed — the case a retained-token design silently fails
- [ ] `audit_logs.ip_address` is null for every action on an anonymous issue; the reporter's IP appears in no admin-readable table
- [ ] `TrackedIssueDetail` and `PublicIssue` are asserted field-for-field; the public title of an anonymous report is redacted with `titleRedacted`
- [ ] `/tracked/**` comment listing returns no `INTERNAL` row (asserted in a test)
- [ ] `POST /issues` with a valid non-CITIZEN token is 403; a staff account cannot file a report attributed to itself as a citizen
- [ ] `proposedCategoryText` is required exactly when `categoryId` is `OTHER` and rejected otherwise — a cross-field rule OpenAPI cannot express, so it is asserted directly in a validation test
- [ ] Nothing but the reporter's own confirmation moves an issue to `CLOSED` — asserted exhaustively over every scheduled/job path
- [ ] Comment edit and delete append revisions and audit rows; neither overwrites in place; editing invalidates a cached `ai_summary`
- [ ] `@PreAuthorize` on every operation with a non-empty `x-required-roles`, asserted against the contract; the service-layer exception for `POST /issues` and `/tracked/**` is documented, not accidental

---

## 8. Accessibility and performance requirements

**Accessibility (citizen flows, WCAG 2.1 AA):**
- Every interactive element keyboard-reachable with visible focus
- Text contrast ≥ 4.5:1, UI component contrast ≥ 3:1
- Form errors programmatically tied to their fields; `aria-live` for async status changes
- Usable at 200% zoom and at 320 px viewport width
- Never colour-only encoding of status or priority

**Performance:**
- Angular initial bundle ≤ 250 KB gzipped for the citizen shell; lazy-load staff and admin features
- First contentful paint < 2 s on throttled 3G
- API p95 < 300 ms excluding AI calls; list endpoints < 200 ms
- Normalized photo ≤ 2 MB, max dimension 1600 px
- Typed form input survives a dropped connection without loss

---

## 9. Testing requirements

**Tier 1 — mandatory, written before the UI:**
- State machine: every valid transition, and every disallowed pair asserting a throw
- **Closure invariant: an exhaustive test asserting no job, timer or SYSTEM path can write `CLOSED` — only the reporter's own confirmation can**
- Authorization/IDOR: citizen cannot read or modify another citizen's data; citizen cannot call staff endpoints; department scoping
- **Tracking-token scoping: a valid token reaches only the issues created with it; a `public_code` presented as a credential is rejected; an unknown token is 404, not 401**
- **Token derivation: create anonymous → replay the same `Idempotency-Key` after the TTL window has passed → the same `trackingToken` comes back, and no column in the database holds it in plaintext at any point**
- **Anonymity: `audit_logs.ip_address` null on anonymous issues; reporter fields structurally absent from `TrackedIssueDetail` and `PublicIssue`; no `INTERNAL` comment on `/tracked/**`**
- Comment window: edit after the window is 422; an edit writes a revision row; the body is never overwritten in place
- Upload validation: wrong type, oversize, spoofed extension, path traversal attempt
- Priority engine: band boundaries exact at 80/55/30, monotonic in age, category ordering
- Auth: refresh rotation, reuse detection, revocation
- **Rate limiting: budget headers present on a success; 429 carries `Retry-After`; a Redis outage serves the request rather than rejecting it**

**Tier 2 — integration:** Testcontainers (Postgres+pgvector, RabbitMQ, MinIO) for the full create → AI → triage flow, outbox idempotency, SLA boundaries, and the anonymous create → track → confirm path.

**Tier 3 — E2E (minimum one):** citizen creates → AI analysis completes → manager assigns → officer resolves → citizen confirms → closed. Plus a second E2E: **a visitor with no account reports anonymously, receives a tracking token, follows the status, comments, confirms, and cannot reach any other issue with that token.**

**Frontend:** interceptor refresh logic, report form validation, one critical workflow test.

**Rules:** Testcontainers needs Docker running — it is a hard test dependency by choice, so CI and your machine behave identically. No filler tests for coverage numbers. `FakeAiAdapter` in every test. Kill-the-provider is a required test.

---

## 10. CI/CD requirements

GitHub Actions, on every push and PR:
1. **Contract: `npx @redocly/cli lint api/openapi/civiclens-v1.yaml` — 0 errors, 0 warnings.** This runs first; nothing else is worth building against a contract that will not parse.
2. Backend: `mvn verify` (unit + integration), including the springdoc-vs-authored diff
3. Frontend: install, lint, `ng test`, production build
4. **gitleaks** secret scan
5. On merge to `main`: build Docker images, push to registry

Split fast unit tests from slower Testcontainers jobs to keep feedback tight.

---

## 11. Deployment and operations requirements

| Requirement | Detail |
|---|---|
| Environments | Local (Compose) · staging (public URL, smoke-tested) · production |
| Hosting | Single VPS, Docker Compose, Caddy for automatic HTTPS. **No Kubernetes** |
| Domain + TLS | Custom domain, Let's Encrypt via Caddy |
| Monitoring | Uptime check on `/actuator/health`, alert on 5xx spike, DLQ counter alert |
| Alert verification | Deliberately trigger a test 5xx and confirm the alert fires — an unverified alert is not a monitor |
| Backups | Daily Postgres backup + **one performed restore drill** |
| Secrets in prod | Injected at deploy time, never in the image or the repo |
| Rollback | Previous image tag redeployable in one command |

---

## 12. Legal and compliance requirements (launch gate)

- [ ] Plain-language **Privacy Policy** and **Terms of Use**, published and linked from registration (I draft; they need real legal review)
- [ ] Retention enforced: attachments purged, reporter PII anonymized, exact coordinates dropped, issue row archived — 2 years
- [ ] Abuse handling: report rejection, repeat-abuse account disabling, visible platform-problem contact distinct from civic issue reporting
- [ ] Image moderation: AI-assisted flagging plus human review and appeal; never fully automated rejection
- [ ] Consent and notice for location and photo capture

---

## 13. Deliverable artifacts

| Artifact | Where |
|---|---|
| Canonical spec | `docs/SPEC.md` |
| Technical requirements | `docs/REQUIREMENTS.md` (this file) |
| Phase plan + decision log | `docs/PLAN.md` |
| README with run steps | repo root — P1 ship gate |
| OpenAPI contract | `/v3/api-docs` + Swagger UI |
| Legal drafts | `docs/legal/` — drafts, not legal advice |

---

## 14. Still undecided

1. **AI API key** — not required to build or demo; drop one into `.env` when available
2. **Production host and domain** — not required until a deploy target exists
3. **Email provider** (P2) — Resend vs SES
4. **Embedding provider** (P3) — Voyage AI vs self-hosted, decided at the P3 migration
5. **Target scale** — confirm the real launch community size so indexes, page sizes and rate limits are sized for it
6. **Unit test runner** — confirm what Angular 22 scaffolds with, then pin it here
