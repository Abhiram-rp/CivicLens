# CivicLens — Canonical Specification

**Status:** canonical. This file supersedes `CivicLens-BUILD.md` and `CivicLens-Architecture-Spec.md` wherever they conflict, and governs all three domain questions they answered differently. `PLAN.md` remains the process/roadmap document (phases, cut order, progress tracker, decision log).

**Authority order, highest first:**
1. This file (`docs/SPEC.md`) — what the system *is*.
2. `docs/PLAN.md` — when it gets built, in what order, and what gets cut.
3. `docs/CivicLens-BUILD.md` — historical; its domain depth is absorbed here, its process content does not apply.
4. `docs/CivicLens-Architecture-Spec.md` — historical; the original design, absorbed here except where noted.

**How to change this file:** edit it first, add a dated row to the Decision Log in `PLAN.md` §11, then code. Never edit an already-applied Flyway migration. Never break `/api/v1` — add `/api/v2`.

---

## 1. Non-negotiables

1. **Backend authorization is the only security boundary.** Angular route guards are UX.
2. **AI never sets final state.** Every AI output passes schema validation → business validation → deterministic rules before touching the database. It is stored as a *suggestion* with its model and prompt version.
3. **The core works with AI switched off.** Provider down = reporting, triage and resolution are unaffected.
4. **API-first.** One versioned REST API at `/api/v1`, consumed identically by the Angular web app and the future mobile app. No web-only auth shortcut.
5. **Every state change is audited.** "The department never actioned my report" must be answerable from data.
6. **Mobile-readiness from day one.** Dual `clientType` auth flow, server-side image normalization, `Idempotency-Key` on create, `device_tokens` table and `Notification.channel` present before the mobile app exists.
7. **Private-by-default media.** Object keys only, signed URLs with short TTL, magic-byte validation, generated keys, no executable content, EXIF GPS stripped from stored copies.
8. **Data minimization.** Retention enforced by a job, PII never in public payloads, soft-disable users rather than deleting them, archive issues rather than deleting them.
9. **Modular monolith.** One deployable, strict module boundaries enforced by ArchUnit tests.
10. **Cut, don't half-ship.** A missing feature beats a broken one. NL analytics is cut first.
11. **Idempotent consumers.** Dedupe by message id; duplicate delivery is a no-op.
12. **Accessible and low-bandwidth.** WCAG 2.1 AA on citizen flows, works on a low-end Android on throttled 3G.

---

## 2. Technology stack (version pins verified 2026-09-28)

| Layer | Choice | Pinned |
|---|---|---|
| Frontend | Angular + Angular Material, standalone components, Signals, RxJS services, **no NgRx** | Angular / Material / CLI **22.2.0**, Node 24 |
| Maps | Leaflet + OpenStreetMap | latest |
| Backend | Java + Spring Boot (Web MVC, Security, Data JPA, Validation, Actuator) | **Java 21** toolchain, **Spring Boot 4.1.x** |
| API docs | springdoc-openapi (Swagger UI) | **3.1.x** (the supported pairing for Boot 4) |
| Auth | Spring Security + JWT access + rotating refresh | — |
| Database | PostgreSQL + `pgvector` + `pgcrypto` | **16** |
| Migrations | Flyway | latest |
| Messaging | RabbitMQ (P2) | 3.13+ |
| Cache | Redis (P2) | 7 |
| Object storage | MinIO in dev, S3-compatible in prod, behind `FileStoragePort` | — |
| AI | Provider behind ports; Anthropic adapter first, deterministic `FakeAiAdapter` always available | `claude-sonnet-5` default; `claude-haiku-4-5` available as a cheap tier |
| Test | JUnit 5, Mockito, Testcontainers (Postgres+pgvector, RabbitMQ, MinIO) | — |
| Build | Maven | 3.9.x |
| Infra | Docker + Docker Compose; single VPS with Caddy in prod. No Kubernetes | — |
| CI | GitHub Actions: build, test, lint, image build, gitleaks | — |

**Version-pin changes vs. the source documents, deliberate:**
- BUILD.md said Spring Boot 3.x. Spring Boot 4 is GA (4.1.1) and springdoc-openapi 3.1.x supports it. Boot 4 uses Jackson 3; the BOM handles the migration. *Fallback if a third-party library misbehaves: drop to Spring Boot 3.5.x + springdoc 2.9.x. That is a one-line version change, not a rewrite.*
- BUILD.md pinned `claude-sonnet-4-6`, now previous-generation. `claude-sonnet-5` ($2/$10 per MTok) is the current balanced model. Model IDs are per-port config, never hard-coded.
- BUILD.md's `AI_MODEL_EMBEDDING=voyage-3` conflicts with its own `VECTOR(1536)` column. Resolved: see §10.4 — the vector column is not created until the P3 migration that picks the provider.

---

## 3. Roles and authorization

Four roles, as in the architecture spec and BUILD.md. `users.role` is a `VARCHAR` + `CHECK`; adding a role is a constraint change, not a data migration.

| Role | Can do | Cannot do |
|---|---|---|
| `CITIZEN` | Create issues; view/edit own while `SUBMITTED`; comment; confirm/reopen own; confirm ("me too") an open issue | See anyone else's issue details; see staff notes; change status beyond confirm/reopen/cancel |
| `FIELD_OFFICER` | View issues assigned to them; accept assignment; move `ASSIGNED → IN_PROGRESS`; resolve with notes + evidence | Assign, reject, mark duplicate, see other departments' issues |
| `DEPARTMENT_MANAGER` | Everything an officer can, plus: view own department's issues, assign officers, set priority, reject, mark duplicate, review duplicates, SLA monitor, department dashboard, regenerate summaries | Administer users, departments, categories, SLA config |
| `ADMIN` | Everything, plus user/role/status, departments, categories, SLA policies, audit log, CSV export | — |

**Rules:**
- Authorization is decided in the **service layer** by ownership and department scope, never by URL pattern alone, never by "hidden in the UI".
- Every controller/service method carries an explicit `@PreAuthorize`. No implicit access.
- **404-not-403 rule:** any resource the caller cannot see returns `404`. `403` is returned only when the caller's role could never use that endpoint at all (e.g. `CITIZEN` → `/api/v1/admin/users`). This applies to every sub-resource (`/comments`, `/attachments`, `/duplicates`, `/duplicates/{id}`), not just the parent.
- Role changes are admin-only, audited, and never settable through self-service profile update.
- Users are **soft-disabled**, never deleted, so audit history stays intact.
- P1 exercises `CITIZEN` + `DEPARTMENT_MANAGER` (a manager with a null `department_id` doing manual triage). The officer split activates in P2 when departments exist.

---

## 4. Issue state machine

Eleven statuses, single `IssueStateMachine` component driven by a `Map<IssueStatus, Set<IssueStatus>>` per role. Controllers never set status directly. Every allowed transition writes exactly one `issue_status_history` row.

| From | To | Role | Precondition | Audit action | Notification |
|---|---|---|---|---|---|
| — | `SUBMITTED` | CITIZEN | valid create payload | `ISSUE_CREATED` | none |
| `SUBMITTED` | `AI_ANALYZING` | SYSTEM | `issue.created` consumed | `AI_ANALYSIS_STARTED` | none |
| `AI_ANALYZING` | `TRIAGED` | SYSTEM | recommendation applied **or** AI failed / low confidence fallback | `AI_ANALYSIS_COMPLETED` | citizen: "under review" |
| `TRIAGED` | `ASSIGNED` | DEPARTMENT_MANAGER | priority set; officer active; officer in same department | `ISSUE_ASSIGNED` | officer + citizen |
| `TRIAGED` | `REJECTED` | DEPARTMENT_MANAGER | reason required | `ISSUE_REJECTED` | citizen |
| `TRIAGED` | `DUPLICATE` | DEPARTMENT_MANAGER | linked `duplicate_matches` row `CONFIRMED` | `ISSUE_MARKED_DUPLICATE` | citizen, linking to the original |
| `ASSIGNED` | `IN_PROGRESS` | FIELD_OFFICER (assignee only) | officer accepted assignment | `ISSUE_IN_PROGRESS` | citizen |
| `ASSIGNED` | `TRIAGED` | DEPARTMENT_MANAGER | reassignment / officer unresponsive | `ISSUE_UNASSIGNED` | previous officer |
| `IN_PROGRESS` | `RESOLVED` | FIELD_OFFICER (assignee only) | resolution notes required; ≥1 evidence attachment recommended | `ISSUE_RESOLVED` | citizen (confirm/reopen prompt) |
| `RESOLVED` | `CLOSED` | CITIZEN (reporter) or SYSTEM (auto-close) | citizen confirms, or auto-close window elapses | `ISSUE_CLOSED` | none |
| `RESOLVED` | `REOPENED` | CITIZEN (reporter) | within reopen window (14 days, configurable), reason required | `ISSUE_REOPENED` | manager + officer |
| `REOPENED` | `ASSIGNED` | DEPARTMENT_MANAGER | same as `TRIAGED → ASSIGNED` | `ISSUE_REASSIGNED` | officer |
| any active state | `CANCELLED` | CITIZEN (reporter, only before `ASSIGNED`) or ADMIN | reason required | `ISSUE_CANCELLED` | none |

**Everything else → `409 INVALID_STATE_TRANSITION`.** Unit-tested exhaustively: every disallowed pair asserts a throw. This is the highest-value test suite in the project; write it before any UI.

**Resolutions to ambiguities found while reconciling:**
- `ACKNOWLEDGED` (PLAN) is dropped. `TRIAGED` covers it; a second state meaning "someone looked at it" adds no audit value.
- `AI_ANALYZING` survives as a real status — it makes a stuck consumer an alertable condition — but the citizen UI labels it **"Under review"** and never shows the raw status name.
- **Auto-close must not destroy the right to reopen.** `REOPENED` is therefore reachable from `CLOSED` as well as `RESOLVED`, within the same 14-day window, reporter only. Otherwise the N-day auto-close silently removes a citizen's right to dispute a fix. The auto-close window is therefore configured **longer** than the reopen window.
- Staff (`DEPARTMENT_MANAGER`, `ADMIN`) may also move `RESOLVED → IN_PROGRESS` for a fix that did not hold, with a required reason; it is audited as a distinct action from a citizen reopen, because the accountability story differs.
- `DUPLICATE` is terminal except via admin correction, which is audited.

---

## 5. Priority engine

Deterministic, pure, stateless: `PriorityEngine.score(IssueScoringInput): PriorityScoreResult`. No DB access, no clock access (time is passed in), no Spring beyond `@Component`. Fully unit-testable from fixture inputs.

```
score = severityWeight         * 35     // AI-suggested or manual override
      + socialSignalFactor     * 20     // distinct corroborating signals, capped
      + categorySensitivity    * 20
      + ageDecay               * 15
      + locationSensitivity    * 10     // 0 in V1 — sensitive_zones is V2
```

| Term | Definition |
|---|---|
| `severityWeight` | CRITICAL 1.0, HIGH 0.75, MEDIUM 0.45, LOW 0.2 |
| `socialSignalFactor` | `min(distinctSignals, 5) / 5` where `distinctSignals` = citizen confirmations + manager-confirmed duplicate links. Contributes 0 in P1 (no confirmations yet) |
| `categorySensitivity` | `WATER_SUPPLY`, `ELECTRICAL`, `PUBLIC_SAFETY` = 1.0 · `ROADS` 0.8 · `DRAINAGE` 0.7 · `GARBAGE` 0.6 · `STREET_LIGHT` 0.4 · `OTHER` 0.5 |
| `ageDecay` | `min(hoursSinceCreated / slaHoursForCurrentBand, 1.0)` |
| `locationSensitivity` | 0.0 until a `sensitive_zones` table exists (V2). No zone geometry matching in the V1 timeline |

**Bands** come from configuration, not code: `≥80 CRITICAL`, `≥55 HIGH`, `≥30 MEDIUM`, else `LOW`. Thresholds live in `application.yml`.

**Persisted:** `priority_score` (int, for sorting and index), `priority` (band, for display), and `score_breakdown` (JSONB, the five component contributions). The breakdown is what lets the UI answer *"why is this CRITICAL?"* to a disputing citizen — it is the reason this is an additive model rather than a product.

**Recomputation:** once at `TRIAGED`, then on every SLA evaluation run. Automatic recomputation may only **raise** priority. A manager may downgrade manually with a required reason, audited.

**Tests:** monotonic in age; category ordering holds; every band boundary exact at 80/55/30; location term provably 0 in V1; downgrades require a reason.

---

## 6. SLA model

`sla_policies(id, category_id NULL, priority, resolve_within_hours)` — category-specific row if one matches, else the per-priority default. The four per-priority defaults (BUILD.md's `sla_rules`) survive verbatim as rows with `category_id IS NULL`, so a new category always has a sane SLA.

`sla_tracking(issue_id PK, deadline, state, last_evaluated_at)` with state ∈ `WITHIN_SLA`, `APPROACHING`, `BREACHED`, `RESOLVED_WITHIN_SLA`, `RESOLVED_AFTER_BREACH`.

`SlaEvaluationJob` (`@Scheduled`, single-instance safe) transitions to `APPROACHING` at 75% of the window and `BREACHED` at the deadline, publishes `sla.breached`, and raises the manager's overdue queue. Evaluation is idempotent and keyed on issue state, never on counters.

---

## 7. API contract

Base path **`/api/v1`**. All authenticated requests: `Authorization: Bearer <accessToken>`. DTOs at the boundary; entities are never serialized. Pagination on every list.

### 7.1 Auth

```
POST /auth/register   { email, password, fullName, phone? }        → 201 { id, email, fullName, role }
POST /auth/login      { email, password, clientType: WEB|MOBILE }  → 200 { accessToken, expiresIn, user }
                      refresh token: HttpOnly SameSite=Strict cookie (WEB)
                      refresh token: response body for secure storage (MOBILE)
POST /auth/refresh    WEB: cookie.  MOBILE: body { refreshToken }   → 200 { accessToken, refreshToken?, expiresIn }
POST /auth/logout     revokes the refresh token used                → 204
```

Access token 15 min, refresh 7 days, **rotated on every use**: the prior row is marked `revoked = true` and `replaced_by` set. Presenting an already-revoked token is treated as theft — the whole family for that user is revoked. Access tokens live in memory in Angular, never `localStorage`.

### 7.2 Issues

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/issues` | CITIZEN | `multipart/form-data`: title, description, categoryId?, latitude, longitude, address?, photos[] (max 3). Header `Idempotency-Key: <uuid>`. Replay returns the **original 201 body**, not an error |
| GET | `/issues` | any, scoped | Filters: status, category, priority, department, page, size. Citizen→own, officer→assigned, manager→department, admin→all |
| GET | `/issues/mine` | CITIZEN | Convenience list; same shape |
| GET | `/issues/{id}` | scoped | 404 if not visible — never 403 |
| PUT | `/issues/{id}` | CITIZEN (reporter) | Only while `SUBMITTED` or `AI_ANALYZING`: title?, description?, categoryId? |
| POST | `/issues/{id}/comments` | scoped participants | 201 |
| POST | `/issues/{id}/assign` | DEPARTMENT_MANAGER (own dept) | 422 `OFFICER_NOT_IN_DEPARTMENT` |
| POST | `/issues/{id}/status` | per transition matrix | 409 on invalid |
| POST | `/issues/{id}/transition` | staff | Thin generic alias over `/status` for bulk queue actions |
| POST | `/issues/{id}/resolve` | FIELD_OFFICER (assignee) | `multipart`: notes, evidence[] |
| POST | `/issues/{id}/confirm` | CITIZEN (reporter) | `RESOLVED → CLOSED` |
| POST | `/issues/{id}/reopen` | CITIZEN (reporter) | 422 `REOPEN_WINDOW_EXPIRED` |
| GET | `/issues/{id}/duplicates` | DEPARTMENT_MANAGER | 200 |
| POST | `/duplicates/{id}/confirm` · `/reject` | DEPARTMENT_MANAGER | 200 |

### 7.3 Public, notifications, dashboard, admin, devices

```
GET  /public/issues/{publicCode}   unauthenticated, redacted DTO, rate-limited
GET  /notifications?unreadOnly=&page=&size=
POST /notifications/{id}/read   ·   POST /notifications/read-all
GET  /dashboard                  role-specific aggregate, Redis-cached 60s
GET  /admin/audit-logs?entityType=&entityId=&from=&to=&page=
GET/POST /admin/users   ·   PUT /admin/users/{id}/role   ·   PUT /admin/users/{id}/status
GET/POST/PUT /admin/departments   ·   /admin/categories   ·   /admin/sla-policies
GET  /admin/export/issues.csv
POST /devices/register    { token, platform: ANDROID|IOS|WEB }   → 204
POST /devices/unregister  { token }                              → 204
```

**Public DTO allowlist** — a dedicated type with these fields and nothing else. Never the internal DTO with fields nulled:

`publicCode`, `title`, `category`, `status`, `priority` (band), `submittedAt`, `resolvedAt`, `closedAt`, `confirmationCount`, `photoCount`, `coordinates` rounded to a ~100 m grid, `areaLabel`.

Never present: reporter name/email/phone, exact coordinates or exact address for issues on private property, free-text comment bodies, internal officer notes, duplicate candidates, AI reasoning, audit data, any other citizen's identity.

A general open-data API stays **out of scope**. This is one shareable page, not a data feed.

### 7.4 Error model

```json
{
  "timestamp": "2026-09-25T10:15:00Z",
  "status": 409,
  "code": "INVALID_STATE_TRANSITION",
  "message": "Cannot move issue CIV-100482 from RESOLVED to ASSIGNED",
  "path": "/api/v1/issues/CIV-100482/status",
  "traceId": "a1b2c3d4",
  "details": [ { "field": "latitude", "issue": "out of range" } ]
}
```

Codes: `VALIDATION_ERROR` (400) · `UNAUTHENTICATED` (401) · `FORBIDDEN` (403, wrong role for the endpoint only) · `NOT_FOUND` (404) · `INVALID_STATE_TRANSITION` (409) · `OFFICER_NOT_IN_DEPARTMENT` (422) · `REOPEN_WINDOW_EXPIRED` (422) · `RATE_LIMITED` (429) · `INTERNAL_ERROR` (500). `AI_UNAVAILABLE` exists internally and **never** surfaces to a citizen-facing response. `DUPLICATE_IDEMPOTENCY_KEY` is not an error — it replays the original success body.

### 7.5 Rate limits (Redis sliding window)

| Endpoint | Limit | Key |
|---|---|---|
| `POST /auth/login` | 5/min per IP **and** 10/hour per account | both |
| `POST /auth/register` | 3/hour per IP | IP |
| `POST /issues` | 10/hour per user | user |
| `POST /issues/{id}/comments` | 20/hour per user | user |
| `GET /public/**` | 60/min per IP | IP |
| AI-triggering paths | global daily budget, hard stop | global |

These are starting values, not policy I invented — revisit after real traffic.

---

## 8. Data model and migrations

Flyway, one file per logical change, never edit an applied migration. Every table has `id UUID PK DEFAULT gen_random_uuid()` and `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`. `pgcrypto` and `vector` extensions enabled in V1.

**No PostGIS.** Geospatial queries use a bounding-box pre-filter in SQL and Haversine distance in Java, which is sufficient at the target scale and removes a native-extension dependency. `issues(latitude, longitude)` is a plain btree index.

### V1 — Report and Track

`departments` · `users` · `refresh_tokens` · `device_tokens` · `categories` · `issues` · `issue_comments` · `issue_attachments` · `issue_status_history` · `resolution_reports`

Highlights and deliberate shape:
- `issues.public_code` = `'CIV-' || nextval('issue_public_code_seq')`, `START 100001`, generated in the service layer. Never `COUNT(*)+1`.
- `issues.idempotency_key` + `CREATE UNIQUE INDEX ... ON issues(reporter_id, idempotency_key) WHERE idempotency_key IS NOT NULL` — cheap now, a production migration later.
- `issues.priority_score INT` + `issues.score_breakdown JSONB` alongside the `priority` band.
- `issue_attachments.kind` ∈ `ISSUE_PHOTO` (max 3 per issue, enforced in service) | `RESOLUTION_EVIDENCE`; stores `file_key`, **never a public URL**.
- `resolution_reports` is created **without** `ai_summary`; that column is added in V3 when summarization exists. A nullable column would be dead weight in V1 and an `ALTER` in V3 is free.
- `issue_status_history` and `audit_logs` are **append-only** — no update or delete code path exists, and there is a test asserting it.
- Full `audit_logs` with an `@Aspect` arrives in V2; V1 records transitions in `issue_status_history` (PLAN's explicit design: the audit log replaces the simple history once it exists).

### V2 — Triage and Workflow

`issue_assignments` · `sla_policies` · `sla_tracking` · `audit_logs` · `issue_confirmations` (`UNIQUE(issue_id, user_id)`) · `notification_outbox` · `notifications` · `processed_messages`

- A user has **one** department via `users.department_id`. PLAN's `staff_departments` join table is dropped — it models multi-department staff, which this product does not need, and a join table in the authorization path is a place for bugs to hide.
- `notifications.channel` ∈ `IN_APP` | `EMAIL` | `PUSH` from day one. Only `IN_APP` is wired in V2.

### V3 — AI Recommendation Layer

`issue_recommendations(id, issue_id, type, payload JSONB, confidence, model, prompt_version, status[PENDING|ACCEPTED|OVERRIDDEN|REJECTED|INVALID], decided_by, decided_at)` · `issue_embeddings` · `ai_usage_daily`

- PLAN's `issue_recommendations` supersedes the architecture spec's `IssueAiAnalysis` — it is a superset (`model` + `prompt_version` for reproducibility, and `OVERRIDDEN`/`INVALID` as first-class states).
- `issue_embeddings` is created **here**, sized to the provider chosen in this migration, with the dimension recorded and a `model` column. See §10.4.

### V4 — Transparency and Analytics

`areas` · `daily_issue_stats` · `area_stats` (rollups/materialized views). Analytics never reads hot transactional tables for heavy aggregates.

### Retention

Closed issues and their photos: **2 years**, then purged by a nightly job. "Purged" means attachments deleted, reporter PII anonymized, exact coordinates dropped — **the issue row itself is archived, not deleted**, so historical aggregates and audit history stay intact. Users are soft-disabled, never deleted.

---

## 9. Module layout and boundaries

```
com.civiclens
├── identity      users, roles, JWT, auth, departments, categories   (P1)
├── issue         issues, media, lifecycle, priority, confirmations   (P1)
├── workflow      assignment, SLA, audit                             (P2)
├── notification  in-app now, email/push later                       (P2, P5)
├── ai            LlmClient ports, validation, recommendations, embeddings (P3)
├── analytics     aggregates, dashboards, export                     (P4)
└── shared        error model, pagination, config, messaging, correlation IDs (P1)
```

Mapping from the sources' flatter package lists: `user`→identity, `media`/`duplicate`/`priority`→issue, `sla`/`audit`/departments→workflow, `common`/`security`/`config`→shared+identity, `messaging`→shared.

**ArchUnit rules (added in P1, cheap and permanent):**
1. No module may import another module's `repository` package.
2. Controllers never return JPA entities.
3. `ai` must not import `issue` internals — it communicates through ports and DTOs.
4. No `@Autowired` field injection; constructor injection only.
5. Domain/state-machine classes have no Spring web imports.

---

## 10. AI layer

### 10.1 Ports and adapters

`AiClassificationPort` · `AiVisionPort` · `AiEmbeddingPort` · `AiSummarizationPort`, in `ai/port/`. Two implementations ship: `AnthropicAiAdapter` and `FakeAiAdapter`.

**`FakeAiAdapter` is always available** and is selected automatically when `AI_PROVIDER_API_KEY` is empty. It is used by every test, by CI, by local dev, and it is the "AI off" demo mode. No test in this project makes a real API call.

### 10.2 Validation gate (the core safety property)

```
citizen text/image
  → prompt with strict JSON schema instruction
  → provider response
  → JSON schema validation            (malformed / extra fields / wrong types → INVALID, discarded, never retried forever)
  → business validation               (category exists? department code resolves? severity in enum?)
  → confidence ≥ AI_CONFIDENCE_THRESHOLD (0.6, configurable)?
  → yes: store recommendation, status ACCEPTED-by-system, feed PriorityEngine as a *severity input only*
  → no:  store as PENDING, route to manual manager triage
```

The recommendation never sets status, never sets category by itself without a business rule, and never sets priority directly — the PriorityEngine consumes it as one input among five and produces the score.

### 10.3 Prompt-injection hardening

Citizen text and comments are always wrapped in an explicit delimited data block with an instruction that the content is untrusted data, never instructions. Output is constrained to the JSON schema, and non-conforming output is discarded. A successful injection can therefore only corrupt its own recommendation, which is still gated by validation. Test cases: injected instructions in title, in description, in comments, in an image; each must produce either a valid recommendation or a clean rejection, never a state change.

### 10.4 Embeddings and duplicate detection

P2 ships **rule-based** duplicate flagging: same category + within 150 m + open status, surfaced to a manager as `SUGGESTED` rows. Never auto-merged.

P3 adds semantic ranking *inside* the candidate set the rule already found, via `pgvector` cosine similarity with a configurable threshold (0.85). The provider and its dimension are chosen in the P3 migration — **not** now, because guessing wrong means altering a live vector column with an ivfflat index. Anthropic has no embeddings API, so this is necessarily a second vendor (Voyage AI `voyage-3`, 1024-dim, is the leading candidate) or a self-hosted model; the port makes both possible.

### 10.5 Failure handling

Client timeouts: 8 s classification/embedding, 15 s vision. On timeout, error or rate limit: 3 retries with backoff (5 s, 30 s, 120 s) via TTL retry queues → DLQ → issue falls back to `TRIAGED` with `ai_unavailable = true` and a manager-facing banner: *"AI triage unavailable — manual classification required."* Landing in a DLQ raises a Micrometer counter `mq.dlq.count` and an ERROR log. The citizen-facing flow never blocks on AI and never sees an AI error.

**Cost control:** classification once per issue (not per edit), embeddings once, summarization only at `RESOLVED` or on manager-triggered regenerate (rate-limited), capped response tokens, per-port model selection (`claude-haiku-4-5` for cheap classification if configured), and a hard daily spend cap that disables AI rather than overspending.

---

## 11. Messaging

```
Exchange: civiclens.events (topic)
  ai-analysis.queue        <- issue.created
  ai-analysis.retry.queue  <- TTL 5000ms, DLX -> civiclens.events / issue.created
  notification.queue       <- issue.*, sla.breached, duplicate.suggested
  notification.retry.queue <- TTL 5000ms
  DLQ: civiclens.dlq.<queue-name>
```

Envelope: `{ messageId, eventType, occurredAt, payload }`. Publishing happens via `@TransactionalEventListener(AFTER_COMMIT)`, so a rolled-back HTTP transaction never emits a phantom event. Consumers check `processed_messages` (unique constraint, insert-or-skip) before acting — duplicate delivery after a consumer crash is a no-op.

**Transactional outbox:** the notification outbox row is written in the same DB transaction as the state change, then a publisher pushes it to RabbitMQ. This is what makes "the citizen's email never arrived" an impossible state rather than a probable one.

---

## 12. Cache (Redis)

| Item | Key | TTL | Invalidation |
|---|---|---|---|
| Dashboard aggregates | `dash:{role}:{deptId}` | 60 s | time-based; short staleness acceptable |
| Reference lists | `ref:categories`, `ref:departments` | 1 h | explicit evict on admin write |
| Rate-limit counters | `rl:{userId}:{endpoint}` | sliding | expires naturally |
| In-flight AI state | `ai:processing:{issueId}` | 5 min | cleared on completion |

Redis is **never** a system of record. A Redis outage degrades performance, not correctness — rate limiting fails open with a logged warning rather than rejecting every request.

---

## 13. Media pipeline

1. Validate: content type, size (≤5 MB per file, ≤15 MB total, 3 photos), **magic bytes** — never the client filename or its extension.
2. Generate the storage key server-side (`issues/{issueId}/{uuid}.jpg`). Path traversal is structurally impossible.
3. Normalize server-side: apply EXIF orientation, HEIC→JPEG transcode, resize to max 1600 px on the long edge, re-encode under 2 MB, **strip EXIF GPS** from the stored copy.
4. Store as private. Persist `file_key` only.
5. Serve via signed URL, short TTL (~5 min), generated on read. Public DTOs expose a photo count, never a URL.
6. No executable content, ever. Content-type allowlist: image/jpeg, image/png, image/webp, image/heic (input only).

Normalization is server-side because the mobile app's images are the largest, EXIF-rotated and HEIC-encoded. Never assume a client normalized anything.

---

## 14. Frontend

Angular 22, standalone components, lazy-loaded routes, Signals for local/UI state, RxJS `BehaviorSubject` services for session state, **no NgRx**. Reactive forms with typed groups and backend-mirrored validation. Angular Material with an **explicitly defined accessible theme** — Material's defaults do not meet WCAG 2.1 AA, and AA on citizen flows is a launch gate. Leaflet + OpenStreetMap for the map picker, with GPS coordinates as the primary input path on every device.

```
src/app/
├── core/        AuthService, TokenStore, AuthInterceptor, ErrorInterceptor, RoleGuard, CorrelationIdInterceptor
├── shared/      StatusBadge, PriorityBadge, SlaCountdown, FileUploader, CommentThread, StatusTimeline, MapPicker, PublicIssueCard
├── layouts/     CitizenShell, OfficerShell, ManagerShell, AdminShell
└── features/
    ├── auth/        login, register
    ├── issues/      report, my-reports, issue-detail, public-issue-detail
    ├── officer/     assigned, resolve
    ├── manager/     queue, assignment, sla-monitor, duplicate-review, analytics
    ├── admin/       users, departments, categories, sla-config, audit-logs
    └── notifications/
```

Two interceptors of note: the auth interceptor attaches the bearer token and transparently refreshes once on 401; the correlation-id interceptor echoes `traceId` from error responses into the UI so a citizen can quote it in a support request. Accessibility: every interactive element reachable by keyboard, visible focus, AA contrast, `aria-live` on async status changes, and a form that survives a flaky connection without losing typed input.

**Vocabulary:** the UI says **"Report"**; the domain, API, and database say `issue`.

---

## 15. Phases and gates

PLAN.md remains the source for effort estimates and cut order. Scope mapped to the merged spec:

| Phase | Ships | Gate |
|---|---|---|
| **P1 — Report and Track** | Auth, roles, issue create (3 photos, map pin), full 11-state machine, priority v1, my-reports + timeline, staff list/detail/transition, public shareable page, resolution report, seed data, deploy | A stranger reports a pothole from a phone browser and watches it change status. CI green, deployed, seeded, README with run steps |
| **P2 — Triage and Workflow** | Departments + routing, assignment, SLA policies + overdue job, audit log, outbox + RabbitMQ + email, Redis cache, confirmations, rule-based duplicate flags, comments | An issue breaches SLA and appears in the overdue queue; the citizen gets an email on every transition; staff see only their department |
| **P3 — AI Recommendation Layer** | Ports + Anthropic adapter + fake, async pipeline, validation gate, recommendation storage + accept/override UI, embeddings + pgvector, resilience (retry/DLQ/breaker/cost cap), injection tests | Kill the provider: citizen reporting is unchanged. With it on: staff see suggestions and can accept/override |
| **P4 — Transparency and Analytics** | Public map + anonymized feed, rollups, ward dashboards, CSV export, public rate limits + PII assertions | A ward officer answers "what's our median resolution time this month?" without asking the developer |
| **P5 — Mobile and Hardening** | Capacitor shell (camera/GPS), offline queue with idempotent sync, push, observability + alerts, backup + **performed** restore drill, privacy/retention pass, load test | Create a report in airplane mode, reconnect, it syncs exactly once. A restore from backup is demonstrated |

**AI tables and port interfaces are created in the P1 migration** so that P3 adds no migration to a table holding production data. No broker dependency in P1 — P1 must deploy and demo with AI infrastructure entirely absent.

**Cut order under time pressure:** NL analytics → heatmap polish → AI image analysis → semantic duplicates (keep rule-based) → email template polish.

---

## 16. Security checklist (permanent, per feature)

- [ ] Every controller/service method has an explicit `@PreAuthorize`; no reliance on URL patterns.
- [ ] 404-not-403 applied to every resource and sub-resource.
- [ ] Uploads: magic-byte validation, size caps, generated key, non-executable, signed URL only, EXIF GPS stripped.
- [ ] Refresh rotation actually revokes the prior token; reuse is detected and revokes the family.
- [ ] CORS allow-list is the actual web origin(s), never `*`.
- [ ] Rate limits live on login, register, issue create, comments, public reads, AI paths.
- [ ] BCrypt cost ≥ 12. Passwords never logged, never returned in any DTO.
- [ ] AI prompts wrap citizen content in a delimited data block; output never executed.
- [ ] Secrets 100% environment-sourced; `.env` gitignored; gitleaks in CI.
- [ ] Audit log captures: status changes, assignments, role changes, SLA policy changes, user enable/disable, priority downgrades.
- [ ] Public DTOs asserted PII-free by serializing them in a test.
- [ ] IDOR tests exist for every endpoint that reads or writes an owned resource.

---

## 17. Production readiness gate (before public launch, not before a phase ships)

- [ ] Full citizen → AI → manager → officer → citizen lifecycle verified end-to-end against production-like data (Testcontainers integration test **plus** one manual smoke test on the live staging URL).
- [ ] Security checklist §16 fully checked.
- [ ] Privacy Policy and Terms of Use published and linked from registration. I draft the text; it needs a real legal review.
- [ ] Retention job configured and its behaviour verified.
- [ ] Backups configured and **one restore drill actually performed** — not merely configured.
- [ ] Monitoring and alerting live and *verified* by deliberately triggering a 5xx and confirming the alert fires.
- [ ] AI-unavailable fallback manually tested: remove the provider key in staging, confirm issues still flow to manual triage.
- [ ] Image moderation flagging in place, with human review and appeal — never fully automated rejection.
- [ ] Abuse handling live: report rejection, repeat-abuse account disabling, and a visible platform-problem contact distinct from civic issue reporting.
- [ ] At least one real or realistic pilot department account — not just seed data.
- [ ] Low-end Android on throttled 3G tested through the report flow.

---

## 18. Environment variables (`.env.example`, values empty unless stated)

```
# Database
DB_URL=jdbc:postgresql://localhost:5432/civiclens
DB_USER=civiclens
DB_PASSWORD=

# JWT
JWT_ACCESS_SECRET=      # >= 32 bytes, generated
JWT_REFRESH_SECRET=     # >= 32 bytes, generated, different from access
JWT_ACCESS_TTL_MIN=15
JWT_REFRESH_TTL_DAYS=7

# Redis
REDIS_URL=redis://localhost:6379

# RabbitMQ
RABBITMQ_URL=amqp://guest:guest@localhost:5672

# Object storage
S3_ENDPOINT=            # http://localhost:9000 in dev (MinIO)
S3_BUCKET=civiclens-media
S3_ACCESS_KEY=
S3_SECRET_KEY=
S3_REGION=
S3_SIGNED_URL_TTL_SECONDS=300

# AI — leave AI_PROVIDER_API_KEY empty to run on FakeAiAdapter
AI_PROVIDER=anthropic
AI_PROVIDER_API_KEY=
AI_MODEL_TEXT=claude-sonnet-5
AI_MODEL_VISION=claude-sonnet-5
AI_MODEL_FAST=claude-haiku-4-5     # optional cheap tier for classification
AI_MODEL_EMBEDDING=                # P3 decision, with its dimension
AI_CONFIDENCE_THRESHOLD=0.6
AI_DAILY_COST_CAP_USD=5.00

# Domain
APP_BASE_URL=http://localhost:4200
CORS_ALLOWED_ORIGINS=http://localhost:4200
REOPEN_WINDOW_DAYS=14
AUTO_CLOSE_AFTER_DAYS=30            # MUST be > REOPEN_WINDOW_DAYS
DUPLICATE_RADIUS_METERS=150
DUPLICATE_SIMILARITY_THRESHOLD=0.85
RETENTION_DAYS=730
```

Priority band thresholds (`80` / `55` / `30`) and all rate limits are configuration, not code.

---

## 19. Decisions taken while reconciling the architecture spec

These four were not in the original 36 and come from reading `docs/CivicLens-Architecture-Spec.md`. All default to my recommendation and are flagged for veto.

| # | Question | Decision | Why |
|---|---|---|---|
| N1 | Auto-close vs. reopen right | `REOPENED` is reachable from `CLOSED` as well as `RESOLVED` within the 14-day window; auto-close window configured **longer** than the reopen window | Otherwise N-day auto-close silently destroys a citizen's right to dispute a fix |
| N2 | PostGIS? | No. Bounding-box pre-filter in SQL + Haversine in Java | Sufficient at target scale; removes a native-extension dependency from backups and CI |
| N3 | Retention semantics | Purging removes attachments, anonymizes reporter PII and drops exact coordinates; the **issue row is archived, not deleted** | Preserves aggregates and audit integrity while still deleting citizen data |
| N4 | One department per user | `users.department_id` only; PLAN's `staff_departments` join table dropped | A join table inside the authorization path is a bug surface for a capability the product does not need |

---

## 20. Open items needing input

1. **AI API key** — leave empty and CivicLens runs fully on `FakeAiAdapter`. Drop a real key into `.env` when you have one. No key is required to build or demo anything.
2. **Server and domain** — the prod stack is built host-agnostic (single VPS, Compose, Caddy for HTTPS). No provisioning happens until you have a host.
3. **Email provider** (P2) — Resend vs SES. Recommend Resend for the low-volume, template-simple case; undecided until P2.
4. **Embedding provider** (P3) — Voyage AI vs a self-hosted model. Decided at the P3 migration, per §10.4.
5. **Target scale** — confirm the launch community's real size so indexes, page sizes and rate limits are sized for it rather than for the 10k/100k assumption.

---

## 21. Considered and rejected

NgRx · microservices · Kubernetes · a dedicated vector database · a generic rules-engine DSL for priority · a generic "vector search framework" · open-ended NL-to-SQL · image-embedding duplicate matching · WebSocket/SSE realtime (poll and refresh are enough) · multi-city tenancy · multi-language i18n · a general public open-data API · autonomous AI actions · open-ended NL analytics (cut first).
