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

```
SUBMITTED → ACKNOWLEDGED → IN_PROGRESS → RESOLVED → CLOSED
    ↓            ↓              ↓
 REJECTED     REJECTED      (no reject after work starts)
RESOLVED → IN_PROGRESS   (reopen if fix rejected by citizen/staff)
```

- Transitions live in **one** place (enum + `IssueLifecycleService`). Controllers never set status directly.
- Every transition writes an audit row (from P2; a simple `status_history` row from P1).
- Invalid transition → `409 Conflict` with a clear error code.

### 5.2 Priority engine (deterministic)

`priority_score = category_severity_weight × age_factor × (1 + log(1 + confirmations))`

- P1: category weight + age only. P2 adds confirmations/duplicates. P3 may *suggest* severity; the engine still computes the score.
- Priority bands: `LOW / MEDIUM / HIGH / CRITICAL` from score thresholds in config, not code.

### 5.3 Roles

`CITIZEN` (own reports, confirm others) · `STAFF` (department-scoped) · `ADMIN` (everything, config).
Authorization is checked in the **service layer** by ownership/department, never by "hidden in the UI". IDOR tests are mandatory.

---

## 6. Phases

**Estimates assume solo, focused days. Total P1–P4 ≈ 19 working days + 3 buffer = the 22-day roadmap. P5 is a separate stretch.**

---

### PHASE 1: Report and Track (≈ 6 days)

**Ships:** a live site where citizens report issues and staff manage them.

**Scope**
- Auth: register/login, JWT + refresh, roles
- Report flow: title, description, category, photo upload (≤ 3 images), map pin, address text
- Issue lifecycle via state machine (§5.1)
- Citizen: "My reports" + status timeline
- Staff/Admin: issue list with filters (status, category, priority), detail view, status update
- Priority engine v1
- Public read-only issue detail page (shareable link)
- Deployment: real URL, HTTPS, seed data

**Data model (Flyway V1)**
- `users(id, email UNIQUE, password_hash, role, created_at)`
- `issues(id, reporter_id, title, description, category, status, priority_score, priority_band, lat, lng, address, created_at, updated_at)`
- `issue_media(id, issue_id, storage_key, content_type, size_bytes, created_at)`
- `issue_status_history(id, issue_id, from_status, to_status, changed_by, note, created_at)`
- Index: `issues(status)`, `issues(category)`, `issues(reporter_id)`, `issues(lat, lng)`

**API (P1)**
| Method | Path | Auth |
|---|---|---|
| POST | `/api/auth/register`, `/login`, `/refresh` | public |
| POST | `/api/issues` (multipart) | CITIZEN |
| GET | `/api/issues/mine` | CITIZEN |
| GET | `/api/issues/{id}` | public (redacted) / owner / staff |
| GET | `/api/issues` (filter, page) | STAFF+ |
| POST | `/api/issues/{id}/transition` | STAFF+ |

**Engineering tasks**
1. Repo, Docker Compose (app + Postgres), Flyway, CI (build + test)
2. `identity` module, security config, password hashing (BCrypt), JWT filter
3. `issue` module: entity, repo, lifecycle service, priority service
4. Media upload: validate type + size + magic bytes, store on S3-compatible object storage (R2/S3) or a volume for local; **never** trust client filename
5. Angular: auth pages, report form + Leaflet picker, my-reports, staff list/detail
6. Global error model (`{code, message, details}`), validation, pagination
7. Deploy + smoke test

**Tests that matter**
- State machine: every valid and invalid transition
- Authorization: citizen can't read/modify another's private data; citizen can't call staff endpoints
- Upload validation: wrong type, oversize, spoofed extension
- Priority engine: monotonic with age, category ordering

**Definition of Done / Ship gate**
- A stranger reports a pothole from a phone browser and watches it change status
- CI green, deployed, seed admin/staff accounts, README with run steps

**Out of scope for P1:** departments, SLA, email, AI, analytics, duplicate detection, social login.

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
| 2026-09-28 | N1: `REOPENED` reachable from `CLOSED` within the window; auto-close window > reopen window | Found while reconciling the architecture spec. Auto-close must not silently destroy a citizen's right to dispute a fix |
| 2026-09-28 | N2: no PostGIS — bounding-box pre-filter + Haversine in Java | Sufficient at target scale; removes a native extension from backups and CI |
| 2026-09-28 | N3: retention purges attachments and anonymizes PII but archives the issue row | Deletes citizen data while preserving the aggregates and audit integrity |
| 2026-09-28 | N4: one department per user via `users.department_id`; dropped `staff_departments` | A join table inside the authorization path is a bug surface for a capability the product does not need |
| 2026-09-28 | Version pins updated: Spring Boot 4.1.x + springdoc 3.1.x, Angular 22.2.0, `claude-sonnet-5` | Verified against the registry and vendor docs, not copied from the older specs. Spring Boot 3.5.x + springdoc 2.9.x is the one-line fallback |

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
