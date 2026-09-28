# CivicLens: Phase-wise Build Plan

> Single point of reference for building CivicLens. If something here conflicts with a chat, a memory, or an old spec, **this file wins**. Change it deliberately (see §9), never silently.

> **Superseded in part (2026-09-28).** This file governs *process*: phases, scope, cut order, progress tracker, decision log. `docs/SPEC.md` governs *what the system is* and wins on every domain question this file answered differently (roles, state machine, API base path, priority formula, module layout, mobile framework, photos per issue, SLA model). See the Decision Log in §11 for the full reconciliation.

---

## 1. Product in one paragraph

CivicLens is an AI-assisted civic issue reporting and resolution platform. Citizens report infrastructure problems (potholes, broken streetlights, drainage) with text, photos, and location. Authorities triage, assign, and resolve them against SLAs. AI *recommends* (category, severity, duplicates); deterministic rules *decide*. The goal is to **ship live and help society**, with the engineering quality to double as portfolio and interview material.

## 2. Non-negotiable principles

1. **Every phase is independently shippable.** At the end of a phase the system is deployed, usable, and demoable. No phase depends on a later one to be useful.
2. **AI is advisory, never authoritative.** LLM output is schema-validated, then business-rule-checked, then stored as a *suggestion*. The state machine and priority engine keep final authority over issue state.
3. **The core works with AI switched off.** LLM provider down → reporting, triage, and resolution are unaffected.
4. **Modular monolith.** One deployable, strict module boundaries. No microservices.
5. **Cut, don't half-ship.** An unfinished feature is worse than a missing one. Analytics (NL query) is the first thing cut.
6. **Deploy from Phase 1.** Production problems surface early, not at the end.

## 3. Locked-in decisions (ADR summary)

| Area | Decision | Rejected |
|---|---|---|
| Frontend | Angular + TypeScript + Angular Material | n/a |
| State mgmt | RxJS services + Angular Signals | NgRx (overkill for timeline) |
| Backend | Java + Spring Boot | n/a |
| Architecture | Modular monolith | Microservices (timeline) |
| Database | PostgreSQL | n/a |
| Vector store | pgvector inside PostgreSQL | Dedicated vector DB (scale doesn't justify) |
| Messaging | RabbitMQ (introduced in P2, heavy use in P3) | Sync LLM calls in request path |
| Cache | Redis (introduced in P2) | n/a |
| Local infra | Docker Compose | n/a |
| CI | GitHub Actions | n/a |
| AI integration | Provider-agnostic `LlmClient` interface | Hard-coding one provider |
| Maps | Leaflet + OpenStreetMap | Paid map APIs |
| Mobile (P5) | Ionic + Capacitor (reuse Angular) | React Native (UI rewrite) |

## 4. Module layout (backend)

Package by module from day one. **No cross-module repository access**: modules talk through service interfaces or events only.

```
com.civiclens
├── identity        users, roles, JWT, auth          (P1)
├── issue           issues, media, lifecycle, priority (P1)
├── workflow        departments, assignment, SLA, audit (P2)
├── notification    email now, push later            (P2, P5)
├── ai              LlmClient, pipeline, embeddings  (P3)
├── analytics       aggregates, dashboards, export   (P4)
└── shared          error model, pagination, config  (P1)
```

Each module owns its tables. Enforce boundaries with ArchUnit tests (add in P1, it's cheap).

## 5. Core domain rules (used across phases)

### 5.1 Issue state machine

`docs/SPEC.md` §4 holds the authoritative 11-state matrix. The shape:

```
SUBMITTED → AI_ANALYZING → TRIAGED → ASSIGNED → IN_PROGRESS → RESOLVED → CLOSED
                ↓             ↓          ↓           ↓            ↑         ↑
             (AI off)     REJECTED   ASSIGNED→TRIAGED   (assignee)  └─ REOPENED ─┘
                             DUPLICATE (unassign)                     (reporter, 14d)
                                          ↓
                                      CANCELLED
```

- Transitions live in **one** place (enum + `IssueLifecycleService`). Controllers never set status directly.
- Every transition writes an audit row (from P2; a simple `status_history` row from P1).
- Invalid transition → `409 Conflict` with a clear error code.
- **No timer closes an issue.** `RESOLVED → CLOSED` is the reporter's confirmation and nothing else; `REOPENED` stays reachable from `CLOSED`; the "fixed but never confirmed" case is a manager queue (`staleResolvedOnly`), not a job. See SPEC.md §4.

### 5.2 Priority engine (deterministic)

`priority_score = category_severity_weight × age_factor × (1 + log(1 + confirmations))`

- P1: category weight + age only. P2 adds confirmations/duplicates. P3 may *suggest* severity; the engine still computes the score.
- Priority bands: `LOW / MEDIUM / HIGH / CRITICAL` from score thresholds in config, not code.

### 5.3 Roles

`CITIZEN` · `FIELD_OFFICER` · `DEPARTMENT_MANAGER` · `ADMIN` — the full matrix is in `docs/SPEC.md` §3. (PLAN originally said three with a single `STAFF`; that was superseded: `IN_PROGRESS`/`RESOLVED` are restricted to the assignee, which is meaningless without a distinct officer role.)

Authorization is checked in the **service layer** by ownership/department, never by "hidden in the UI". IDOR tests are mandatory. A report is additionally reachable by the **concealed reporter's tracking token**, which is a bearer credential scoped to that reporter's own issues — see SPEC.md §3.1.

---

## 6. Phases

**Estimates assume solo, focused days. Total P1–P4 ≈ 19 working days + 3 buffer = the 22-day roadmap. P5 is a separate stretch.**

---

### PHASE 1: Report and Track (≈ 6 days)

**Ships:** a live site where citizens report issues and staff manage them.

**Scope**
- Auth: register/login, JWT + refresh, roles
- **Concealed reporting**: an explicit `disclosure` choice with **no default** on the report form, a verified contact channel in a **separate store**, an unguessable `trk_` tracking token issued once and stored hashed, the `/tracked/**` tree (list, detail, edit, comments, confirm, reopen, **reveal**) that token authenticates, and the `/contact/**` tree (verify, decision) that the emailed approval link uses
- Report flow: title, description, category (incl. `OTHER` + `proposedCategoryText`), photo upload (≤ 3 images), map pin, address text
- Issue lifecycle via state machine (§5.1), **no auto-close**, with a **reporter approval gate on every close** — identical for concealed and signed-in reporters
- Citizen: "My reports" + status timeline; tracked reports view
- Staff/Admin: issue list with filters (status, category, priority), detail view, status update, category-proposal resolution at triage
- Comments with a bounded edit/delete window backed by append-only revisions
- Priority engine v1
- Public read-only issue detail page (shareable link), with the title of a concealed report redacted
- `active` flags on categories and departments, enforced on the reference endpoints and refused while open issues exist
- Rate-limit budget headers on every rate-limited response
- **Contract-first**: `api/openapi/civiclens-v1.yaml` is written and linted before any UI code; Angular and Spring Boot are both built against it
- Deployment: real URL, HTTPS, seed data

**Data model (Flyway V1)**
- `users(id, email UNIQUE, password_hash, role, created_at)`
- `issues(id, reporter_id NULL, disclosure, contact_state, approval_deadline, title, description, category, proposed_category_text, status, priority_score, priority_band, lat, lng, address, ip_hash, idempotency_key, created_at, updated_at)` — `reporter_id` null means concealed; `contact_state` is a **routing fact with no PII**
- `tracking_tokens(id, issue_id, token_hash, created_at, last_used_at)` — hash only, never the plaintext
- **`contact_channels`** — in a **separate database with separate credentials**, the only table holding a reporter address: `(id, issue_id, channel_type, encrypted_value BYTEA, state, verified_at, last_delivery_at, last_error)`. The reporting service's datasource has no grant on it
- `contact_tokens(id, issue_id, purpose[VERIFY|DECIDE], token_hash, expires_at, used_at)` — single-use, hashed, one table for both purposes
- `notification_outbox(...)` in V1 — carries `issue_id` + channel, **never an address**; the publisher reads the contact store at dispatch
- `issue_media(id, issue_id, storage_key, content_type, size_bytes, created_at)`
- `issue_comments(id, issue_id, author_id NULL, author_concealed, body, visibility, edited_at, revision_count, deleted_at, created_at)`
- `comment_revisions(id, comment_id, body, edited_by, created_at)` — append-only
- `issue_status_history(id, issue_id, from_status, to_status, changed_by, note, created_at)`
- `departments(..., active)` · `categories(..., active)`
- Index: `issues(status)`, `issues(category)`, `issues(reporter_id)`, `issues(lat, lng)`

**API (P1)** — the full contract is `api/openapi/civiclens-v1.yaml`; this is the headline surface
| Method | Path | Auth |
|---|---|---|
| POST | `/api/v1/auth/register`, `/login`, `/refresh` | public |
| POST | `/api/v1/issues` (multipart) | **optional** — session *or* concealed; concealed also requires `reporterContact` + `contactDisclosureNote` |
| GET | `/api/v1/tracked/**` (8 operations) | `X-Tracking-Token` |
| POST | `/api/v1/contact/verify`, `/api/v1/contact/decision` | single-use token — **the approval gate, no account** |
| GET | `/api/v1/issues/mine` | CITIZEN |
| GET | `/api/v1/issues/{id}` | owner / staff (404 if not visible) |
| GET | `/api/v1/public/issues/{publicCode}` | public (redacted DTO) |
| GET | `/api/v1/issues` (filter, page, `staleResolvedOnly`) | scoped per role |
| POST | `/api/v1/issues/{id}/transition` | staff |
| PUT/DELETE | `/api/v1/issues/{id}/comments/{id}` | author, within window |

**Engineering tasks**
0. **Write `api/openapi/civiclens-v1.yaml` first and lint it in CI.** Generate the Angular client from it. Nothing else in this list starts until the contract is green.
1. Repo, Docker Compose (app + Postgres), Flyway, CI (build + test)
2. `identity` module, security config, password hashing (BCrypt), JWT filter
3. `issue` module: entity, repo, lifecycle service, priority service
4. Media upload: validate type + size + magic bytes, store on S3-compatible object storage (R2/S3) or a volume for local; **never** trust client filename
5. **Concealment**: tracking-token minting + hashing, `X-Tracking-Token` filter, `/tracked/**` with reporter-less response allowlists, IP-hash helper with a rotating pepper
6. **Contact store**: separate database + datasource, envelope-encrypted `contact_channels`, `contact_tokens` (single-use, hashed, TTL'd), double opt-in holding a report out of every queue until verified, transactional outbox + email publisher that reads the address at dispatch, `/contact/**`, and the approval gate in the lifecycle
7. Angular: auth pages, report form + Leaflet picker + **no-default disclosure choice**, my-reports, **tracked reports**, **the `/contact` verify and decision pages**, staff list/detail
8. Global error model (`{code, message, details}`), validation, pagination, rate-limit budget headers
9. Deploy + smoke test

**Tests that matter**
- State machine: every valid and invalid transition
- Authorization: citizen can't read/modify another's private data; citizen can't call staff endpoints
- **Concealment: a tracking token reaches only its own issues; a `public_code` is rejected as a credential; `TrackedIssueDetail` and `PublicIssue` contain no reporter field; `audit_logs.ip_address` is null on a concealed issue**
- **Contact isolation: a reporter address never appears in any operational-DB query result, DTO, CSV export, audit row or log line; the reporting service's datasource has no grant on the contact store**
- **Verification gate: an unverified concealed report is absent from every triage, assignment and SLA query**
- **Reveal: a leaked tracking token cannot deconceal; the reveal is one-way; the new address is verified before it takes effect**
- **Contact tokens: a replayed verification or decision token is 410; no plaintext is stored**
- **Closure: no job, timer or SYSTEM actor can move an issue to `CLOSED`, and no delivery failure can either** (exhaustive tests: no scheduled path writes that status, and a forced permanent bounce leaves the report `RESOLVED` with `contact_state = UNDELIVERABLE` and visible in the manager queue)
- Comments: edit outside the window is 422; a revision row is written; the body is never overwritten
- Upload validation: wrong type, oversize, spoofed extension
- Priority engine: monotonic with age, category ordering

**Definition of Done / Ship gate**
- A stranger reports a pothole from a phone browser **without an account**, verifies their email, gets a tracking link, receives the officer's proposed fix by email, **disputes it**, and watches it reopen
- CI green, deployed, seed admin/staff accounts, README with run steps

**Out of scope for P1:** departments, SLA, **general transition emails to signed-in citizens** (P2 — the concealed-reporter email path is *not* out of scope, it is what makes the approval gate work), AI, analytics, duplicate detection, social login, free-text `?q=` search, `category_proposals` promotion (P2), SMS/push channels.

---

### PHASE 2: Triage and Workflow (≈ 4 days)

**Ships:** authorities can run their daily operations in it.

**Scope**
- Departments; category → department routing rules
- Assignment (auto-route on submit, manual reassign)
- SLA timers per category/priority; overdue flag + queue
- Audit log (replaces simple history; who/what/when/before/after)
- Email notifications on status change (first RabbitMQ use)
- Redis cache for hot public reads
- Geo-proximity duplicate *flagging* (radius + same category + open status). Rule-based, no AI
- Citizen "confirm this issue too" (feeds priority)
- Staff comments (internal) and public updates

**Data model (Flyway V2)**
- `departments`, `department_categories`, `staff_departments`
- `issue_assignments(issue_id, department_id, assignee_id, assigned_at)`
- `sla_policies(category, priority_band, resolve_within_hours)`
- `audit_log(id, entity_type, entity_id, action, actor_id, before_json, after_json, created_at)`
- `issue_confirmations(issue_id, user_id, UNIQUE(issue_id, user_id))`
- `issue_comments(id, issue_id, author_id, visibility, body, created_at)`
- `notification_outbox(id, event_type, payload_json, status, attempts, created_at)`

**Key design points**
- **Transactional outbox** for notifications: write the outbox row in the same DB transaction as the state change, then a publisher pushes to RabbitMQ. Avoids "status changed but email never sent".
- Consumers are **idempotent** (dedupe by event id).
- SLA overdue detection via scheduled job (`@Scheduled`), single-instance safe (ShedLock or DB flag).

**Tests that matter**
- Outbox: event exists iff transition committed; duplicate delivery doesn't double-send
- Department scoping: staff in Dept A can't touch Dept B issues
- SLA calculation and overdue boundary
- Duplicate flagging radius edge cases

**Ship gate**
- An issue breaches SLA and appears in the overdue queue; the citizen gets an email on each transition; staff see only their department's issues.

**Out of scope for P2:** SMS/push, complex escalation chains, multi-tenant cities.

---

### PHASE 3: AI Recommendation Layer (≈ 5 days)

**Ships:** smarter intake with humans and rules still in control.

**Scope**
- Async pipeline: issue submitted → event → AI worker → recommendation stored
- `LlmClient` interface + one concrete provider adapter (swap-able)
- Outputs: suggested category, suggested severity, short summary (text + image)
- **Validation gate:** JSON schema validation → business-rule check (category must exist, severity in enum, confidence threshold) → store as `PENDING` suggestion
- Embeddings → pgvector → **semantic duplicate detection** (top-K similar open issues, similarity threshold from config)
- Staff UI: accept / override / dismiss suggestion; record the decision
- Resilience: timeouts, bounded retries with backoff, DLQ, circuit breaker, daily cost cap
- Prompt-injection hardening: citizen text is *data*, delimited and never treated as instructions; output is never executed

**Data model (Flyway V3)**
- `issue_recommendations(id, issue_id, type, payload_json, confidence, model, prompt_version, status[PENDING|ACCEPTED|OVERRIDDEN|REJECTED|INVALID], decided_by, decided_at, created_at)`
- `issue_embeddings(issue_id, embedding vector(N), model, created_at)` + ivfflat/hnsw index
- `ai_usage(id, day, calls, tokens_in, tokens_out, cost_estimate)`

**Key design points**
- Store `prompt_version` and `model` on every recommendation → reproducibility and eval.
- Override rate = free evaluation metric. Track it.
- Failure modes are first-class: `INVALID` output is logged and discarded, never retried forever.

**Tests that matter**
- Malformed/hostile LLM output (extra fields, wrong enum, prompt-injected text) → rejected safely
- Provider timeout/outage → issue creation still succeeds, no AI suggestion, no crash
- Retry/DLQ behavior; cost cap stops calls
- Duplicate detection ranking on a small labeled set
- Use a **fake `LlmClient`** in tests. No real API calls in CI.

**Ship gate**
- Kill the LLM provider: citizen reporting is unchanged. With it on: staff see suggestions and can accept/override.

**Out of scope for P3:** fine-tuning, autonomous state changes, multi-model ensembles, chat assistant.

---

### PHASE 4: Transparency and Analytics (≈ 4 days)

**Ships:** public accountability and management insight.

**Scope**
- Public map + anonymized issue feed (no reporter PII)
- Area/ward dashboards: volume, median resolution time, SLA compliance, category mix, trends
- Hotspot heatmap
- Admin CSV export
- Caching/aggregation strategy (materialized views or nightly rollups + Redis)
- **Stretch (cut first): natural-language analytics.** Build only if P4 core is done with time left. Safe design if built: LLM → *parameterized predefined query templates*, never raw SQL

**Data model (Flyway V4)**
- Materialized views / rollup tables: `daily_issue_stats`, `area_stats`
- `areas` (ward/zone boundaries or grid)

**Key design points**
- Public endpoints get **rate limiting** and strict response DTOs (no leaking of reporter identity, exact private addresses if sensitive).
- Analytics reads never hit hot transactional tables directly for heavy aggregates.

**Tests that matter**
- Public DTOs contain no PII (assert on serialized JSON)
- Aggregate correctness against a fixed dataset
- Rate limit behavior

**Ship gate**
- A ward officer answers "what's our median resolution time this month?" from the dashboard without asking you.

**Out of scope for P4:** predictive models, cross-city comparison, BI tool integration.

---

### PHASE 5: Mobile App and Production Hardening (≈ 8–10 days, separate stretch)

**Ships:** a native-feeling app and a system that can run unattended.

**Scope: Mobile (Ionic + Capacitor)**
- Reuse Angular components/services where possible
- Camera capture, GPS, compression before upload
- Offline draft queue with sync on reconnect (idempotency key on create to prevent duplicates)
- Push notifications (FCM) via the `notification` module
- Store-ready builds (Android first)

**Scope: Hardening**
- Rate limiting + abuse protection on all public/write endpoints
- Image moderation (basic) and upload scanning
- Observability: Actuator metrics, structured logs with correlation IDs, dashboards, alerts
- Backups + **tested restore**
- Privacy pass: retention policy, PII minimization, EXIF GPS stripping/handling
- Load test on the report + list endpoints; fix the worst finding

**Ship gate**
- Create a report in airplane mode, reconnect, and it syncs exactly once. A restore from backup is demonstrated.

---

## 7. Cross-cutting standards (apply to every phase)

**Security checklist per feature:** authN · authZ (ownership/department) · IDOR · input validation · injection · file upload · secrets in env (never in Git) · CORS allowlist · data exposure in DTOs · rate limiting · prompt-injection (AI features)

**Testing priorities:** 1) business rules 2) security 3) failure cases 4) integration (Testcontainers for Postgres/RabbitMQ) 5) happy path. No filler tests for coverage numbers.

**API conventions:** versionable `/api/...`, consistent error body, pagination on all lists, DTOs at the boundary (never expose entities).

**Definition of Done (every feature):** tests pass · build passes · no secrets in diff · authZ verified · error handling present · docs/README updated · PLAN.md checklist ticked.

## 8. Scope control

| Class | Meaning | Rule |
|---|---|---|
| P0 | Must have for the phase gate | Build |
| P1 | Valuable, low cost | Build if phase is on schedule |
| P2 | Optional | Only with spare time; first to cut |
| OUT | Doesn't serve the goal | Don't build |

**Standing OUT list:** microservices, NgRx, dedicated vector DB, autonomous AI actions, fine-tuning, multi-city tenancy, real-time websockets (poll or refresh is fine until proven otherwise), social login.

**Cut order under time pressure:** NL analytics → heatmap polish → AI image summary → semantic duplicates (keep rule-based) → email templates polish.

## 9. Change control

- Scope or architecture change → edit this file first, add a dated line in the Decision Log, then code.
- Never expand a phase mid-flight. New ideas go to the Parking Lot.

## 10. Progress tracker

### Phase 1: Report and Track
- [ ] Repo + Compose + Flyway + CI
- [ ] Identity module + JWT
- [ ] Issue module + state machine + priority v1
- [ ] Media upload with validation
- [ ] Angular: auth, report form + map, my reports
- [ ] Staff list/detail/transition
- [ ] Deployed + seed data + README
- [ ] **P1 gate passed**

### Phase 2: Triage and Workflow
- [ ] Departments + routing + assignment
- [ ] SLA policies + overdue job/queue
- [ ] Audit log
- [ ] Outbox + RabbitMQ + email notifications
- [ ] Redis caching
- [ ] Confirmations + rule-based duplicate flags
- [ ] Comments
- [ ] **P2 gate passed**

### Phase 3: AI Recommendation Layer
- [ ] `LlmClient` + provider adapter + fake for tests
- [ ] Async pipeline + validation gate
- [ ] Recommendations storage + staff accept/override UI
- [ ] Embeddings + pgvector duplicate detection
- [ ] Resilience (retry, DLQ, breaker, cost cap)
- [ ] Prompt-injection tests
- [ ] **P3 gate passed**

### Phase 4: Transparency and Analytics
- [ ] Public map + anonymized feed
- [ ] Aggregates/rollups
- [ ] Ward dashboards
- [ ] CSV export
- [ ] Public rate limiting + PII assertions
- [ ] (Stretch) NL analytics
- [ ] **P4 gate passed**

### Phase 5: Mobile and Hardening
- [ ] Capacitor shell + camera/GPS
- [ ] Offline queue + idempotent sync
- [ ] Push notifications
- [ ] Observability + alerts
- [ ] Backup + restore test
- [ ] Privacy/retention pass
- [ ] Load test
- [ ] **P5 gate passed**

## 11. Decision Log

| Date | Decision | Reason |
|---|---|---|
| 2026-09-28 | Split into 5 independently shippable phases | Reduce risk, ship early, keep scope honest |
| 2026-09-28 | Reconciled the three source docs into `docs/SPEC.md`; this file keeps process authority, SPEC.md takes domain authority | The three docs answered ~20 domain questions differently. Splitting authority by process-vs-domain keeps every decision and discards nothing |
| 2026-09-28 | Four roles (CITIZEN, FIELD_OFFICER, DEPARTMENT_MANAGER, ADMIN), not three | The state machine restricts IN_PROGRESS/RESOLVED to the assignee, which is meaningless without an officer role. Retrofitting it later is a role migration plus an authorization rewrite |
| 2026-09-28 | 11-state issue machine from BUILD.md; PLAN's `ACKNOWLEDGED` dropped | Assignment needs a home state and REOPENED must be distinguishable from "never finished" in the audit trail |
| 2026-09-28 | API base path `/api/v1` (not `/api`) | A mobile client in the field cannot be force-updated; a version prefix is the only way the never-break-a-live-version rule is enforceable |
| 2026-09-28 | Granular endpoints (`/assign`, `/resolve`, `/reopen`, …) with `/transition` as a staff alias | `resolve` is multipart with evidence and `reopen` needs a reason; one endpoint carrying all of that becomes a request-shape switch statement |
| 2026-09-28 | Additive 0–100 priority score with a persisted component breakdown, bands in config | A sum yields an auditable "why is this CRITICAL?" explanation and a plain sortable integer; a product compresses toward zero and gives no breakdown |
| 2026-09-28 | AI ships in P3, but AI tables and ports are created in the P1 migration | Keeps P1 deployable and demoable with zero AI infrastructure, while P3 then adds no migration to a table holding production data |
| 2026-09-28 | Three photos per issue (not one) | One photo forces citizens to open duplicate issues, manufacturing the spam P2/P3 duplicate detection then has to clean up |
| 2026-09-28 | Public shareable issue page added, as a separate redacted DTO with an allowlist | Transparency is a real civic feature and the best demo; it must never be the internal DTO with fields nulled |
| 2026-09-28 | `Idempotency-Key` on POST /issues from P1 | ~20 lines now; a schema change and test matrix later, on a table with production data |
| 2026-09-28 | SLA policy = category-specific row with per-priority default | "All electrical = 4h, potholes = 14 days" is a real operational need; a category with no rule still needs a sane default |
| 2026-09-28 | Citizen confirmations become a first-class table in P2 | "40 others reported this too" is the cheapest strong civic signal available |
| 2026-09-28 | `resolution_reports` table from P1, `ai_summary` column added in P3 | Gives the P3 summarization feature somewhere to land and keeps the officer's notes out of the audit log |
| 2026-09-28 | `device_tokens` + `/devices/*` + `notifications.channel` built now, unwired | Avoids a breaking migration at mobile launch; two 204 endpoints cost nothing |
| 2026-09-28 | 7-module layout (identity, issue, workflow, notification, ai, analytics, shared) | Seven named modules give enforceable ArchUnit rules; thirteen flat packages blur together |
| 2026-09-28 | Redis and RabbitMQ introduced in P2 | Nothing in P1 needs a cache or a broker; P1's `docker compose up` should stay short enough to debug in one step |
| 2026-09-28 | Rule-based duplicate flagging in P2, semantic pgvector ranking in P3 | Most of the value at a fraction of the cost, and testable without an embedding provider |
| 2026-09-28 | Embedding column not created until the P3 migration picks a provider | BUILD.md contradicts itself (1536-dim column vs. a 1024-dim model). Guessing wrong means altering a live vector column with an ivfflat index |
| 2026-09-28 | Mobile = Ionic + Capacitor reusing the Angular app (P5), not Flutter | The Angular app is already ~70% of the mobile UI; a second codebase costs more than native feel is worth here. Backend contract is identical either way |
| 2026-09-28 | Error envelope = union of both docs, with `traceId` and optional `details` | Strict superset; `traceId` is what lets a citizen's screenshot of an error be matched to logs |
| 2026-09-28 | 404 for anything invisible, 403 only when the role could never use the endpoint | Consistent IDOR defense; mixing the two re-introduces the existence leak |
| 2026-09-28 | Reopen window 14 days, reporter only, configurable; staff may also reopen with a reason | Unlimited reopen means a 2027 report about a 2024 pothole re-entering an active queue |
| 2026-09-28 | Both definitions of done apply: per-phase gates, plus a separate pre-launch readiness gate | Phase gates say when a phase is done; the launch gate says when citizens can be trusted with real data |
| 2026-09-28 | N1 **superseded** — see the concealed-reporting block below; auto-close is now removed outright | The original fix kept the reopen-from-`CLOSED` path but left the timer in place |
| 2026-09-28 | N2: no PostGIS — bounding-box pre-filter + Haversine in Java | Sufficient at target scale; removes a native extension from backups and CI |
| 2026-09-28 | N3: retention purges attachments and anonymizes PII but archives the issue row | Deletes citizen data while preserving the aggregates and audit integrity |
| 2026-09-28 | N4: one department per user via `users.department_id`; dropped `staff_departments` | A join table inside the authorization path is a bug surface for a capability the product does not need |
| 2026-09-28 | Version pins updated: Spring Boot 4.1.x + springdoc 3.1.x, Angular 22.2.0, `claude-sonnet-5` | Verified against the registry and vendor docs, not copied from the older specs. Spring Boot 3.5.x + springdoc 2.9.x is the one-line fallback |
| 2026-09-28 | **Concealed reporting, disclosure control and the tracking token.** `POST /issues` accepts a session *or* a concealed submitter; `disclosure` ∈ `SHARE_DETAILS`\|`CONCEALED`; a concealed report is identified by an unguessable `trk_` token stored only as a hash and presented in the `X-Tracking-Token` header; new `/tracked/**` tree (7 operations at the time, **now 8** — `reveal` was added later the same day) serves that reporter | The reporter chose concealment but still needs to follow their report. `public_code` is a dense `nextval` range from 100001, so it is enumerable and can never be the private key — a sequential id in front of an unauthenticated read endpoint is an enumeration primitive. The token is a separate tree rather than an extra credential on `/issues` so the `x-required-roles` drift assertion stays meaningful and the reporter-less response allowlist is structural. *The mechanism for producing that hash was later changed to derivation — see the token-derivation row below*
| 2026-09-28 | Concealment extends to the reporter's IP: `audit_logs.ip_address` null on concealed issues, salted rotating IP hash in the abuse store only; the public page redacts a concealed report's title to the category name with `titleRedacted` | The IP is an identifier a reader of an audit table can act on, so storing it in an admin-readable table leaves the concealment one records request away. Citizen-authored text is frequently the identifying detail, so the public title deanonymizes as effectively as a name would. *(The "concealed reports get no notifications" clause of this row was **reversed** later the same day — see the concealed-approval-gate rows below.)* |
| 2026-09-28 | **Concealment is not anonymity: a concealed report is pseudonymous to staff, and the platform holds a contact channel for it.** `POST /issues` requires `reporterContact{type,value}` + `contactDisclosureNote` when `disclosure` is `CONCEALED`, and rejects both when it is `SHARE_DETAILS`. **No account is required.** `contact_channels` lives in a **separate database with separate credentials**, envelope-encrypted, read only by the notification service and `/contact/**`; `issues.contact_state` mirrors its state as a routing fact carrying no PII. The contract describes this as concealment, not anonymity, and the SPEC says plainly what it does not promise: it does not stop a reporter from writing their own address in the description, and it does not make a report unidentifiable to one neighbour in a small ward | This is the trade the rest of the design rests on. "Anonymity" would be a promise the platform cannot keep while also telling a citizen their report was fixed; concealment is the promise it *can* keep — no identity for staff to read. Contact is required rather than optional because the approval gate in the next row is undeliverable without it. A separate database rather than a separate schema, because same-database isolation is one grant away from being wrong and the whole guarantee is the absence of a join path from a report read to an address. Cross-field conditional on `disclosure` is prose-only, as with `proposedCategoryText` — OpenAPI 3.1 cannot express it, which is why the validation gate in `REQUIREMENTS.md` exists |
| 2026-09-28 | **The contact channel is verified by double opt-in before triage.** `POST /contact/verify?verificationToken=` → 204 with an **empty body**. Until it succeeds the report is `PENDING_VERIFICATION` and is held out of *every* triage, assignment and SLA queue | Without it, the contact field is a way to make a stranger receive mail about a pothole they never reported, which turns concealment into a harassment vector aimed at whoever the reporter names. The 204 has to be bodyless because a response that echoes the address back is a response that ends up in a log. The token is single-use, hashed, TTL'd, rate limited, and lives in a query parameter rather than a path so it cannot be captured by an intermediary that logs paths verbatim |
| 2026-09-28 | **Nothing closes on a timer, and nothing closes on a failed notification — an officer's resolve is a *proposal*.** `POST /issues/{id}/resolve` moves to `RESOLVED`, sets `approval_deadline = resolved_at + REOPEN_WINDOW_DAYS`, and asks the reporter to approve or dispute. The gate is **identical for concealed and signed-in reporters**: `/contact/decision` for the former, `/issues/{id}/confirm` and `/reopen` for the latter, both writing the same `issue_status_history` row. A permanent email bounce sets `contact_state = UNDELIVERABLE` and surfaces the report in a manager queue; it does **not** close or advance anything | A report cannot wait for a decision the reporter was never told about — that is not approval-gated, it is just stuck. And a delivery failure must not silently become the department's decision: a reporter's right to dispute cannot be extinguished by the platform failing to reach them, so deadline expiry is an escalation, never a transition. One gate for every reporter is easier to explain to a citizen, exhaustively testable, and stops the close path growing two subtly different branches keyed on a disclosure flag |
| 2026-09-28 | **A concealed reporter's email moves from P5 into P1**, scoped to the approval request, the dispute, and transitions they cannot otherwise see. `EMAIL` is the only channel wired in P1; `PUSH` stays P5 and in-app stays V2. The transactional outbox moves into the V1 migration carrying `issue_id` + channel and **never an address** | The approval gate is undeliverable without it, so deferring email to P5 would have deferred the feature the gate exists for. The outbox row must not carry the address or PII lands in the operational database and defeats the separate store; the publisher reads the contact store at dispatch instead, which is also what makes a bounce recordable precisely rather than guessable. General transition emails to signed-in citizens stay P2 — P2 widens an existing path rather than introducing one |
| 2026-09-28 | **`disclosure` has no default**, and disclosure is **one-way**. `POST /tracked/issues/{id}/reveal` is added as the eighth `/tracked/**` operation; a new address is verified *before* the reveal takes effect; there is no inverse operation | A preselected "share my details" is a consent the reporter never gave, so the form refuses to submit until one is chosen. One-way because an officer who has seen a name cannot unsee it, and the UI states that before the reporter confirms rather than after. The new address must be verified because a leaked tracking token must not be enough to deconceal a report — otherwise the guarantee rests on the secrecy of a bearer credential rather than on anything |
| 2026-09-28 | **Auto-close removed outright.** `RESOLVED → CLOSED` is CITIZEN-only; no SYSTEM actor on any transition; `AUTO_CLOSE_AFTER_DAYS` deleted; `REOPENED` still reachable from `CLOSED`; replaced by `GET /issues?staleResolvedOnly=true` + `STALE_RESOLVED_DAYS` | A timer that closes reports destroys the citizen's right to dispute a fix and teaches departments that reports vanish on their own. The underlying problem — an authority that fixes a report and hears nothing back — is real, so it is met with a non-destructive manager queue that keeps a human in the loop |
| 2026-09-28 | **Comments are editable and deletable within a window** (`COMMENT_EDIT_WINDOW_MINUTES=30`, author only). Edits append `comment_revisions`; deletes are soft tombstones; both are audited; an ADMIN moderation delete skips the window and requires a reason. Editing a PUBLIC comment invalidates a cached `ai_summary` | A comment in an official record should be correctable, but overwriting it in place destroys the evidence that a correction happened. `issue_status_history` and `audit_logs` are append-only by rule; extending that to a separate revision table is strictly better than punching a hole in the trail |
| 2026-09-28 | **Custom categories are proposals, not creations.** `OTHER` category always present; `proposedCategoryText` required when it is picked and rejected otherwise; a manager resolves it at triage into an existing category or a new one. P2 adds `category_proposals` to aggregate repeats | `defaultDepartmentId` drives routing and `SlaPolicy.categoryId` drives deadlines, so a category minted from raw citizen text would arrive with neither, and the taxonomy would fill with near-duplicates that the AI then has to classify around |
| 2026-09-28 | `active` flags on `categories` and `departments`; `/reference/*` returns active rows only; deactivating either is refused with a 409 while it holds open issues | Retiring is not deleting — history has to stay readable — but retiring a department that is sitting on a backlog silently strands those reports, which is exactly the failure the escalation path exists to prevent |
| 2026-09-28 | **Instagram-style rate limiting: mechanism yes, numbers no.** Rolling Redis window per bucket; budget headers `X-RateLimit-Limit`/`-Remaining`/`-Reset`/`-Bucket` emitted on successes as well as 429s; `Retry-After` on 429; dual IP+account buckets on login; bucket identity is a user id or a salted IP hash; fails open | Instagram's consumer limits are proprietary and unpublished, so "the same thing" is only possible as a shape. What Meta's Graph API documents is the mechanism worth copying: separate app/user rolling windows that are *observable before rejection*, which is what lets a client disable a button and an operator see pressure building. IP-keyed buckets are also a requirement of concealed reporting, not a nice-to-have |
| 2026-09-28 | `emailVerified` removed from `CurrentUser` and `User` — no verification flow ships, so the field asserted a guarantee the product does not make | A boolean that is always `true` is worse than an absent field: it invites a client to render a verified badge that no process ever backs |
| 2026-09-28 | `areaLabel` stays nullable and is simply `null` in P1; populated in P4 when `areas` exists | The column has no source before the areas table does |
| 2026-09-28 | The citizen sees `assignedOfficerName`; no notification per confirmation, the reporter sees a live `confirmationCount` instead | A citizen is entitled to know which officer is handling their report, and it is the most trust-building field on the screen. A notification per confirmation trains people to ignore the channel that matters |
| 2026-09-28 | Free-text `?q=` search is **not** in P1. P2, on `GET /issues` only, never on the public feed, and hard-scoped to a citizen's own reports | Every P1 queue need is a filter, and `q` needs `pg_trgm` plus a relevance decision. Unscoped it becomes an enumeration primitive over other people's reports |
| 2026-09-28 | OpenAPI contract authored at `api/openapi/civiclens-v1.yaml` with `redocly.yaml`; **56 operations**, every one carrying `x-required-roles`; 0 lint errors, 0 warnings. Angular and Spring Boot are both built against this file, and CI must diff springdoc's generated document against it | Contract-first with the client generated from the same document is the only way "the API is the source of truth" is checkable rather than aspirational. The `@PreAuthorize` drift assertion applies to operations with a non-empty `x-required-roles`; `POST /issues`, `/tracked/**` and `/contact/**` are service-layer authorized because `@PreAuthorize` cannot express "concealed OR CITIZEN" |
| 2026-09-28 | **Tracking tokens are derived, not retained.** `HMAC-SHA256(TRACKING_TOKEN_PEPPER, "trk" \|\| creation_nonce \|\| issue_id)` with a 32-byte `creation_nonce` stored beside `token_hash`; a replayed `Idempotency-Key` re-derives the original token rather than reading back a stored copy | The draft contract had the idempotency record hold the plaintext token for the idempotency TTL, so a replay could return the same one. That satisfied the retry case by leaving a usable bearer credential at rest for a day, and it flatly contradicted this file's own "stored only as a hash" claim. Derivation costs one HMAC, keeps the at-rest position identical to a hash-only design, and unlike the retained copy does not expire with the TTL — a late retry still gets its token instead of orphaning the report |
| 2026-09-28 | `SPEC.md` §7.5 is the single source of truth for which operations are rate-limited, paired in both directions with the contract's budget headers, and enforced by `scripts/check-rate-limit-pairing.mjs` in CI | The two drifted once: `GET /issues` advertised a budget with no limit behind it, three `/tracked/**` operations declared no 429 at all, and the hand-inlined `login` 429 was the only one in the API missing `Retry-After`. OpenAPI lint cannot catch any of it, because none of it is a schema error — a prose rule with nothing reading it is exactly what SPEC.md §8 says not to leave in place |
| 2026-09-28 | `POST /issues` rejects a valid non-CITIZEN token with 403 as an explicit service-layer rule | `x-required-roles` is empty there, so `@PreAuthorize` cannot express the check. Without a written rule an implementer could reasonably let a `FIELD_OFFICER` file a "citizen" report, which would be attributed to a staff account and then surface inside that user's citizen-scope queries |
| 2026-09-28 | `X-RateLimit-Bucket` returns the **coarse bucket name only**; the user id / IP-hash identity segment is metered and logged, never returned | SPEC.md §7.5 already said the bucket goes to metrics and never to the client, and the contract contradicted it by returning `tracked-comment:iphash:41ab…`. The hash is not reversible, so the old justification ("never a raw address") was true but missed the actual harm: a truncated salted hash is a stable correlation handle, and under a shared-address bucket it tells a log reader that two strangers were limited by the same identity. The client needs the limit, the remainder and the reset time to grey out a button - never to know which identity it was counted against |

## 12. Parking Lot (ideas not in any phase)

- (empty; add here instead of expanding a phase)

## 13. Known risks

| Risk | Mitigation |
|---|---|
| Analytics scope creep | NL analytics is stretch; cut rather than half-ship |
| LLM provider instability/cost | Async + breaker + daily cap + core works without AI |
| Image storage/abuse | Type/size/magic-byte validation, moderation in P5 |
| Solo-dev timeline slip | Phase gates, cut order in §8, buffer days |
| PII exposure via public endpoints | Response DTOs + serialization assertions in tests |
| Mobile scope underestimated | P5 is a separate stretch, not part of the 22 days |
