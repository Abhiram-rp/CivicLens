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
13. **Concealment is structural, not a flag.** A report is identified by *either* a user id *or* an unguessable tracking token — never both, and never by a sequential public code. Where a reporter asked for concealment, the response shapes are built from an explicit field allowlist that has no reporter field to null out, and the reporter's IP is never written to an admin-readable table. Concealment hides the reporter from **staff**, never from the platform: a contact channel exists so the platform can reach them, and it lives in a separate store the operational database cannot join to. See §3.1.
14. **Corrections are additive, never destructive.** A comment is edited by appending a revision and deleting by tombstoning, not by overwriting. An official record that can be silently rewritten cannot answer the question the audit trail exists to answer.

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
- **The `@PreAuthorize` rule has one documented exception.** `POST /issues` and the whole `/tracked/**` tree carry an empty `x-required-roles` and are authorized in the service layer, because `@PreAuthorize` cannot express "concealed **or** CITIZEN". Every other operation's annotation is still asserted by a test against the contract.

### 3.1 Reporter identity, disclosure and concealed reporting

A report has exactly one identity, and which one it is, is the reporter's explicit choice at submission time. **There is no default.** The form presents both options at equal weight and refuses to submit until one is chosen, because a preselected "share my details" is a consent the reporter never gave.

| Disclosure | Identity stored | Reachable by | Staff see |
|---|---|---|---|
| `SHARE_DETAILS` | `reporter_id` | the citizen's session, and staff in scope | reporter name and contact |
| `CONCEALED` | **no reporter id in the operational database** — plus a contact channel in a separate store | the tracking token; the contact channel, for delivery only | "concealed citizen" |

**Concealment is not anonymity, and the difference is the whole design.** An anonymous report is one where the platform holds no identifier at all. A concealed report is one where **staff** hold no identifier, and the platform holds a contact channel it needs in order to *tell the reporter* things. The reporter is pseudonymous to the department, not to CivicLens.

That is the honest trade, and it is the only one that supports the approval gate in §4: a report cannot wait for a decision the reporter was never told about.

Rules, each of which exists because the obvious alternative leaks:

- **`public_code` is never a credential.** It is `'CIV-' || nextval(...)` from `100001`, a dense walkable range, and it is handed out in share links and printed on screens. A sequential public identifier in front of an unauthenticated read endpoint is an enumeration primitive, so the public endpoint stays IP-rate-limited and the private one is keyed on something unguessable.
- **The tracking token is derived, not stored.** `base64url(HMAC-SHA256(TRACKING_TOKEN_PEPPER, "trk" || creation_nonce || issue_id))`, prefixed `trk_`, where `creation_nonce` is 32 random bytes held beside the token hash. Returned exactly once, in the 201 body. Only the hash is ever persisted. Scoped to the issues created with it, so possession of one token grants nothing else. Presented in the `X-Tracking-Token` **header** — never a query parameter, which would land it in access logs and `Referer` headers.
  - Deriving rather than storing is what makes "returned exactly once" compatible with idempotent retries. A replay of the same `Idempotency-Key` must hand back the *same* token, because the citizen who never received the first response is precisely the citizen the feature exists for. Retaining the plaintext until the idempotency TTL would achieve that too, but it leaves a usable bearer credential sitting in a database for a day, and `SPEC.md` §8's own rule against editing an applied migration makes that far more expensive to undo later than to design correctly now. Derivation costs one HMAC and no recovery window at all.
- **A lost token is a lost report** — but the contact channel is the way back. There is no tracking-token recovery: re-issuing one would mean holding the identifier concealment exists to avoid. A verified contact channel *is* a recovery path, and that is a feature, not a contradiction. Losing the token means losing `/tracked/**`, not losing the report.
- **Concealment extends to the IP.** Writing a reporter's IP to `audit_logs` would leave the concealment one records request away, and an IP is often enough to identify a person. Concealed traffic is keyed on a **salted, rotating** IP hash kept in the abuse store for the abuse window and nowhere else; `audit_logs.ip_address` is null for any action on a concealed issue.
- **The contact channel lives in a separate database with separate credentials.** `contact_channel(issue_id, channel_type, encrypted_value, state, verified_at, …)` is the only table holding the address. It is reached by the notification service and the contact endpoints, and by nothing that serves a report read — so there is no join path from an operational query to an address, and a compromised reporting API cannot be turned into an address book. `issues.contact_state` is a routing fact (`PENDING_VERIFICATION` / `VERIFIED` / `UNDELIVERABLE`) and carries no PII.
  - Separate store rather than a column on `issues` because a column puts the address in every `SELECT *`, every admin export, every `pg_dump`, and every replica. The column is where a "we'll keep it on the issue row for now" becomes permanent: the migration that moves it out later is a PII migration, on applied data, under the §8 rule against editing applied migrations.
- **The channel is verified by double opt-in before triage.** A submitted report is `PENDING_VERIFICATION` and is held out of *every* queue — triage, assignment, SLA — until `POST /contact/verify` succeeds. Otherwise the channel is a way to make strangers receive mail about a pothole they never reported, and concealment would be a harassment vector. Single-use token, TTL `CONTACT_VERIFICATION_TTL_MINUTES`, query parameter rather than path so it cannot be captured by an intermediary that logs paths.
- **A concealed reporter is notified, by email.** They gave an address so it could reach them, and the approval gate is meaningless unless they are told a fix is waiting. `EMAIL` is therefore wired in **P1**, not deferred to P5 as the general push channel is — P1's email worker exists for the concealed reporter, and the queue in §9 becomes an outbox with an `EMAIL` publisher.
- **Concealed status history is coarse**: status, timestamp, actor — never a reason, never an internal note. They can follow their own report without reading the department's private deliberation.
- **The public page redacts the title of a concealed report** to the category name, and says so via `titleRedacted`. A citizen's own words are frequently the identifying detail ("my gate is broken, I am at house number 12"), so publishing the title can deanonymize the report as effectively as publishing a name would.
- **Disclosure is one-way.** `POST /tracked/issues/{id}/reveal` lets a reporter decide later, and has no inverse, because an officer who has seen a name cannot unsee it. The new address is verified before the reveal takes effect — a leaked tracking token must not be enough to deconceal a report, or the guarantee would rest on the secrecy of a bearer credential. The UI states the irreversibility *before* the reporter confirms.
- **What concealment does not promise.** Free text stays in free text, so a reporter who writes their own address in the description has defeated the feature; and in a small ward, "a concealed report about the pothole on Meadow Lane at 4pm" may be obvious to one person. The guarantee is that CivicLens **records no identity for staff to read** — not that the report is unidentifiable by a neighbour. The UI says so plainly rather than implying a protection it cannot deliver.

---

## 4. Issue state machine

Eleven statuses, single `IssueStateMachine` component driven by a `Map<IssueStatus, Set<IssueStatus>>` per role. Controllers never set status directly. Every allowed transition writes exactly one `issue_status_history` row.

**Resolving proposes; the reporter disposes.** `FIELD_OFFICER` resolving a report does *not* close it. It creates a resolution, sets `approval_deadline = resolved_at + REOPEN_WINDOW_DAYS`, and asks the reporter to approve or dispute. This gate is **identical for every reporter** — concealment changes who can *see* the reporter, never the lifecycle. One rule is easier to explain to a citizen, exhaustively testable, and stops the close path from growing two subtly different branches keyed on a disclosure flag.

| From | To | Role | Precondition | Audit action | Notification |
|---|---|---|---|---|---|
| — | `SUBMITTED` | CITIZEN | valid create payload; **concealed: contact verified** (§3.1) | `ISSUE_CREATED` | none |
| `SUBMITTED` | `AI_ANALYZING` | SYSTEM | `issue.created` consumed | `AI_ANALYSIS_STARTED` | none |
| `AI_ANALYZING` | `TRIAGED` | SYSTEM | recommendation applied **or** AI failed / low confidence fallback | `AI_ANALYSIS_COMPLETED` | citizen: "under review" |
| `TRIAGED` | `ASSIGNED` | DEPARTMENT_MANAGER | priority set; officer active; officer in same department | `ISSUE_ASSIGNED` | officer + citizen |
| `TRIAGED` | `REJECTED` | DEPARTMENT_MANAGER | reason required | `ISSUE_REJECTED` | citizen |
| `TRIAGED` | `DUPLICATE` | DEPARTMENT_MANAGER | linked `duplicate_matches` row `CONFIRMED` | `ISSUE_MARKED_DUPLICATE` | citizen, linking to the original |
| `ASSIGNED` | `IN_PROGRESS` | FIELD_OFFICER (assignee only) | officer accepted assignment | `ISSUE_IN_PROGRESS` | citizen |
| `ASSIGNED` | `TRIAGED` | DEPARTMENT_MANAGER | reassignment / officer unresponsive | `ISSUE_UNASSIGNED` | previous officer |
| `IN_PROGRESS` | `RESOLVED` | FIELD_OFFICER (assignee only) | resolution notes required; ≥1 evidence attachment recommended; **approval request delivered or recorded undeliverable** | `ISSUE_RESOLVED` | reporter (confirm/dispute prompt) |
| `RESOLVED` | `CLOSED` | CITIZEN (reporter) | reporter **approves**. **The only path to `CLOSED`** | `ISSUE_CLOSED` | officer + manager |
| `RESOLVED` | `REOPENED` | CITIZEN (reporter) | reporter **disputes**, within `approval_deadline`, reason required | `ISSUE_REOPENED` | manager + officer |
| `CLOSED` | `REOPENED` | CITIZEN (reporter) | same window. With auto-close gone this is now the **only** thing protecting a disputed fix | `ISSUE_REOPENED` | manager + officer |
| `REOPENED` | `ASSIGNED` | DEPARTMENT_MANAGER | same as `TRIAGED → ASSIGNED` | `ISSUE_REASSIGNED` | officer |
| any active state | `CANCELLED` | CITIZEN (reporter, only before `ASSIGNED`) or ADMIN | reason required | `ISSUE_CANCELLED` | none |

**Everything else → `409 INVALID_STATE_TRANSITION`.** Unit-tested exhaustively: every disallowed pair asserts a throw. This is the highest-value test suite in the project; write it before any UI.

**How the reporter answers, for every disclosure:**

- **Concealed, no account** — the emailed link, `POST /contact/decision?decisionToken=…`, carrying `APPROVE` or `DISPUTE`. Works from any device, and survives the reporter having lost the tracking token.
- **Signed in** — `POST /tracked/issues/{id}/confirm` and `/reopen` through the session, or the same `/contact/decision` link. Both write the same `issue_status_history` row and the same audit action, so the lifecycle does not branch on disclosure; only the *transport* differs.

**Resolutions to ambiguities found while reconciling:**
- `ACKNOWLEDGED` (PLAN) is dropped. `TRIAGED` covers it; a second state meaning "someone looked at it" adds no audit value.
- `AI_ANALYZING` survives as a real status — it makes a stuck consumer an alertable condition — but the citizen UI labels it **"Under review"** and never shows the raw status name.
- **No auto-close. Nothing closes on a timer, and nothing closes on a failed notification.** An authority that fixes a report and then never hears back from the citizen is a real operational problem, and auto-close "solved" it by silently destroying the citizen's right to dispute a fix — and, in practice, by teaching departments that reports disappear on their own. The problem is real, so it is addressed with a **stale-resolution queue** instead: `GET /issues?staleResolvedOnly=true` lists issues `RESOLVED` for more than `STALE_RESOLVED_DAYS` with no confirmation, and a manager chases the citizen. Non-destructive, and it puts a human back in the loop, which is the whole point.
- **A dead contact channel does not close a report.** When email to a concealed reporter bounces permanently, `contact_state` becomes `UNDELIVERABLE` and the report appears in the manager's undeliverable-approval queue. The reporter still holds a right to dispute that the department cannot extinguish by failing to reach them — so the deadline expiry is itself an escalation, never a transition. The distinction matters: the alternative is a delivery failure quietly becoming the department's decision.
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
| POST | `/issues` | **optional** — session *or* concealed | `multipart/form-data`: title, description, disclosure, categoryId?, proposedCategoryText?, latitude, longitude, address?, photos[] (max 3). **Concealed also requires** `reporterContact{type,value}` + `contactDisclosureNote=1`, and is rejected with either if `disclosure` is `SHARE_DETAILS`. Header `Idempotency-Key: <uuid>`. Replay returns the **original 201 body** (including the original tracking token), not an error. A present-but-invalid `Authorization` header is 401; a missing one is the concealed path |
| GET | `/issues` | any, scoped | Filters: status, category, priority, department, createdFrom/To, `staleResolvedOnly`, page, size. Citizen→own, officer→assigned, manager→department, admin→all. Free-text `q` is **not** here in P1 — it arrives in P2 and only ever inherits this scoping |
| GET | `/issues/mine` | CITIZEN | Convenience list; same shape |
| GET | `/issues/{id}` | scoped | 404 if not visible — never 403. A citizen's own concealed reports are **not** reachable here; they use `/tracked/**` |
| PUT | `/issues/{id}` | CITIZEN (reporter) | Only while `SUBMITTED` or `AI_ANALYZING`: title?, description?, categoryId?, proposedCategoryText? |
| GET/POST | `/issues/{id}/comments` | scoped participants | 201. Visibility is server-decided; `INTERNAL` never reaches a citizen |
| PUT | `/issues/{id}/comments/{id}` | author only, ≤ `COMMENT_EDIT_WINDOW_MINUTES` | Appends a `comment_revisions` row, never overwrites. 422 `COMMENT_EDIT_WINDOW_EXPIRED`. Invalidates a cached `ai_summary` |
| DELETE | `/issues/{id}/comments/{id}` | author (≤ window) or ADMIN moderation | Soft delete + tombstone. ADMIN path requires a reason, is audited, and skips the window |
| GET | `/issues/{id}/comments/{id}/revisions` | anyone who can see the comment | Prior versions. Staff-only in practice |
| POST | `/issues/{id}/assign` | DEPARTMENT_MANAGER (own dept) | 422 `OFFICER_NOT_IN_DEPARTMENT` |
| POST | `/issues/{id}/status` | per transition matrix | 409 on invalid. No SYSTEM actor exists on any transition |
| POST | `/issues/{id}/transition` | staff | Thin generic alias over `/status` for bulk queue actions |
| POST | `/issues/{id}/resolve` | FIELD_OFFICER (assignee) | `multipart`: notes, evidence[] |
| POST | `/issues/{id}/confirm` | CITIZEN (reporter) | `RESOLVED → CLOSED`. The only transition into `CLOSED` |
| POST | `/issues/{id}/reopen` | CITIZEN (reporter) | From `RESOLVED` **or** `CLOSED`. 422 `REOPEN_WINDOW_EXPIRED` |
| GET | `/issues/{id}/duplicates` | DEPARTMENT_MANAGER | 200 |
| POST | `/duplicates/{id}/confirm` · `/reject` | DEPARTMENT_MANAGER | 200 |

### 7.2a Tracked — the concealed reporter's own surface

A **separate tree**, not extra credentials on the `/issues` paths. Two reasons: the `x-required-roles` drift assertion stays meaningful (every operation here is unauthenticated and checked in the service layer, rather than five role-scoped endpoints quietly becoming bearer-token ones), and it is obvious at a glance that reporter identity is structurally absent rather than merely omitted.

All eight operations require the `X-Tracking-Token` header and carry `x-required-roles: []`, `security: []`.

| Method | Path | Notes |
|---|---|---|
| GET | `/tracked/issues` | Every report created with this token, `?status=` narrows to one status or to `AWAITING_APPROVAL` (a fix proposed, no answer yet). A shared kiosk accumulates several, so it is a list. **401** if the header is absent, **404** if unrecognised — one "link not valid" state instead of two |
| GET | `/tracked/issues/{id}` | `TrackedIssueDetail`: an explicit allowlist. No `reporterId`, no `reporterDisplayName`, no `address`, coordinates rounded to ~100 m, no `aiSuggestions`, no internal notes. `assignedOfficerName` **is** included |
| PUT | `/tracked/issues/{id}` | Edit while `SUBMITTED`/`AI_ANALYZING`, same rules as the signed-in path |
| GET | `/tracked/issues/{id}/comments` | `INTERNAL` filtered out server-side; a test asserts no `INTERNAL` row is ever returned |
| POST | `/tracked/issues/{id}/comments` | Always `PUBLIC` — there is no role here for an internal note to contrast with. Author recorded as the concealed reporter |
| POST | `/tracked/issues/{id}/confirm` | Reporter approves: `RESOLVED → CLOSED`. Nobody closes it for them |
| POST | `/tracked/issues/{id}/reopen` | Reporter disputes: `RESOLVED` **or** `CLOSED` → `REOPENED`. 422 `REOPEN_WINDOW_EXPIRED` |
| POST | `/tracked/issues/{id}/reveal` | **One-way.** New address is verified *before* it takes effect, so a leaked token cannot deconceal a report. 409 if already `SHARE_DETAILS` or a reveal is in flight |

All eight are rate limited and IP-keyed, because they are the most abusable surface in the product and have no user id to key on.

### 7.2b Contact — the only surface that can read the contact store

Two operations, both unauthenticated, both authorised *solely* by a single-use token minted in the separate contact store. Neither accepts a session, a tracking token, or a password: they prove ownership of a channel and nothing more, which is why a compromised one is not a report compromise.

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/contact/verify?verificationToken=` | single-use token | Completes double opt-in. `204` with an **empty body** — it must not echo the address back, because a response that returns the address is a response that ends up in a log. `410` if already used or expired |
| POST | `/contact/decision?decisionToken=` | single-use token | `{decision: APPROVE\|DISPUTE, reason?}`; reason required on `DISPUTE`. `APPROVE` → `CLOSED`, `DISPUTE` → `REOPENED`. `410` if expired or past `approval_deadline` |

Both tokens are **query parameters, not path parameters** — deliberately, to keep them out of the path that intermediaries log verbatim. The `X-Tracking-Token`, which *does* grant content access, stays in a header. Tokens are TTL'd (`CONTACT_VERIFICATION_TTL_MINUTES`, `DECISION_TTL_DAYS`), single-use, and stored hashed; delivery state is explicit, so a `PENDING_VERIFICATION` report is held out of every queue rather than assumed reachable.

### 7.3 Public, notifications, dashboard, admin, devices

```
GET  /public/issues/{publicCode}   unauthenticated, redacted DTO, rate-limited
GET  /tracked/**                   see §7.2a — concealed reporter, X-Tracking-Token header
POST /contact/verify               see §7.2b — single-use token, no account
POST /contact/decision             see §7.2b — the approval gate, no account
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

`publicCode`, `title`, `titleRedacted`, `category`, `status`, `priority` (band), `submittedAt`, `resolvedAt`, `closedAt`, `confirmationCount`, `photoCount`, `coordinates` rounded to a ~100 m grid, `areaLabel`.

Never present: reporter name/email/phone, exact coordinates or exact address for issues on private property, free-text comment bodies, internal officer notes, duplicate candidates, AI reasoning, audit data, any other citizen's identity.

`titleRedacted` is true when the reporter chose concealment, and the page renders the substituted category name *as* a redaction rather than passing it off as what the citizen wrote.

A general open-data API stays **out of scope**. This is one shareable page, not a data feed.

**What is deliberately absent from notifications**:
- **No event per confirmation.** A citizen sees a live `confirmationCount` on their own report instead. A notification per confirmation trains people to ignore the one channel that matters.
- **No address, ever.** The notification row records *that* a message exists and *which channel* it goes to. The address is read at dispatch time from the contact store by the notification service — the one component with a legitimate reason to hold both. Copying it into the operational database would undo §3.1's separate-store guarantee, and a notification table is exactly the kind of table that later gets exported.

**Concealed reporters are notified, by email.** They gave an address so it could reach them, and §4's approval gate is theatre without it. `EMAIL` moves from P5 into **P1**, scoped to one sender: the approval request, the dispute, and the status transitions a reporter cannot see otherwise. The general push channel stays P5, and no concealed report gets an in-app notification, because there is no session to deliver it to.

Delivery is explicit, never optimistic. The outbox publisher retries on transient failure; a permanent bounce sets `contact_state = UNDELIVERABLE`, which surfaces the report in the manager's queue and **does not** close it. A report whose reporter cannot be reached is an operational problem for a human, not a transition the system is entitled to make on the reporter's behalf.

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

Codes: `VALIDATION_ERROR` (400) · `UNAUTHENTICATED` (401) · `FORBIDDEN` (403, wrong role for the endpoint only) · `NOT_FOUND` (404) · `INVALID_STATE_TRANSITION` (409) · `OFFICER_NOT_IN_DEPARTMENT` (422) · `REOPEN_WINDOW_EXPIRED` (422) · `COMMENT_EDIT_WINDOW_EXPIRED` (422) · `DEPARTMENT_HAS_OPEN_ISSUES` (409) · `CATEGORY_HAS_OPEN_ISSUES` (409) · `RATE_LIMITED` (429) · `INTERNAL_ERROR` (500). `AI_UNAVAILABLE` exists internally and **never** surfaces to a citizen-facing response. `DUPLICATE_IDEMPOTENCY_KEY` is not an error — it replays the original success body.

### 7.5 Rate limits

Rolling window in Redis, sorted-set per bucket, TTL'd. The shape follows Meta's documented Graph API model rather than Instagram's numbers, which are proprietary and unpublished: separate **app-level and user-level** windows, both rolling, both *observable before rejection*. What is copied is the mechanism — their `X-App-Usage` / `X-Biz-Account-Usage` headers let a client grey out a button and an operator see pressure building. That is the part that changes client behaviour, and the actual limits below are ours.

| Endpoint | Limit | Key |
|---|---|---|
| `POST /auth/login` | 5/min per IP **and** 10/hour per account | both |
| `POST /auth/register` | 3/hour per IP | IP |
| `POST /issues` | 10/hour | user id, or salted IP hash when concealed |
| `POST /issues/{id}/comments` | 20/hour | user id, or salted IP hash when concealed |
| `/tracked/**` | 60/min per IP | salted IP hash — there is no user id to key on |
| `POST /contact/verify` | 10/hour per IP | salted IP hash — a verification token proves nothing until it succeeds, and must not be brute-forceable |
| `POST /contact/decision` | 20/hour per IP | salted IP hash — same reasoning, and a decision is irreversible enough to be worth throttling |
| `GET /public/**` | 60/min per IP | salted IP hash |
| AI-triggering paths | global daily budget, hard stop | global |

Every rate-limited response — **successes included** — carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` and `X-RateLimit-Bucket`; a 429 adds `Retry-After`. The client can therefore disable a submit button on the last allowed request instead of letting a citizen discover the limit by hitting it.

This table is the single source of truth for *which* operations are limited, and the pairing is enforced in both directions: no operation may advertise `X-RateLimit-*` without a row here, and no row here may go without them on its 2xx **and** its 429. The two sides drifted once already — `GET /issues` advertised a budget it had no limit for, three `/tracked/**` operations never declared a 429, and the hand-inlined `POST /auth/login` 429 was the only 429 in the API missing `Retry-After`. `scripts/check-rate-limit-pairing.mjs` reads this table and fails on that class of mismatch, because OpenAPI lint cannot: none of it is a schema error.

Two rules that follow from concealment:
- **Bucket keys hold a salted, rotating IP hash, never a raw address.** A Redis dump or a support screenshot must not deanonymize a reporter, and rotation means the hash is useless for correlating a reporter across a long period.
- **The identity segment goes to metrics, never to the client.** `X-RateLimit-Bucket` carries the coarse bucket *name* (`issue-create`, `tracked-read`, `public-read`, …) and stops there. The user id or IP hash that completes the Redis key is logged and metered, not returned.
  - A truncated salted hash is not reversible, so it leaks no address — but it is a **stable correlation handle**. Emitting it lets anyone reading a client-side log group one concealed reporter's requests together, and under a shared-address bucket it confirms that two strangers hit the same identity limit. That is the enumeration aid the rule exists to prevent, and the client gains nothing by knowing it: the limit, the remainder and the reset time are all it needs to grey out a button.

  *This was previously contradicted by the contract, which returned `tracked-comment:iphash:41ab…` to the client. Fixed 2026-09-28.*

**Fails open.** If Redis is unavailable the request is served and a warning logged. A cache outage must not reject every report in the city; bounded abuse during an outage is strictly better than total unavailability.

---

## 8. Data model and migrations

Flyway, one file per logical change, never edit an applied migration. Every table has `id UUID PK DEFAULT gen_random_uuid()` and `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`. `pgcrypto` and `vector` extensions enabled in V1.

**No PostGIS.** Geospatial queries use a bounding-box pre-filter in SQL and Haversine distance in Java, which is sufficient at the target scale and removes a native-extension dependency. `issues(latitude, longitude)` is a plain btree index.

### V1 — Report and Track

`departments` · `users` · `refresh_tokens` · `device_tokens` · `categories` · `issues` · `tracking_tokens` · **`contact_channels`** · `contact_tokens` · `notification_outbox` · `issue_comments` · `comment_revisions` · `issue_attachments` · `issue_status_history` · `resolution_reports`

Highlights and deliberate shape:
- `issues.public_code` = `'CIV-' || nextval('issue_public_code_seq')`, `START 100001`, generated in the service layer. Never `COUNT(*)+1`. A share handle, never a credential — see §3.1.
- `issues.disclosure` ∈ `SHARE_DETAILS` | `CONCEALED`, required, never inferred, never defaulted. `issues.reporter_id` is **nullable** and null means concealed; there is no sentinel "concealed user" row, so no join or query can mistake concealment for an account.
- **`contact_channels` is in a separate database with separate credentials**, and is the only table in the system holding a reporter's address. It is reached by the notification service and `/contact/**` and by nothing that serves a report read.
  - `contact_channels(id, issue_id, channel_type, encrypted_value, state, verified_at, last_delivery_at, last_error, created_at)` — `state` ∈ `PENDING_VERIFICATION` | `VERIFIED` | `UNDELIVERABLE`. `encrypted_value` is envelope-encrypted with a key held outside the database; the column is `BYTEA`, never readable text, so a `SELECT *` in a support session or a replica snapshot yields ciphertext.
  - `issues.contact_state` mirrors that state as a **routing fact with no PII**, because the operational database has to know whether to put the report in a queue, and copying the address to get that answer would defeat the store.
  - A separate database rather than a separate schema in the operational one. Same-database isolation is one grant away from being wrong, and the whole guarantee rests on there being no join path from a report read to an address.
- `contact_tokens(id, issue_id, purpose, token_hash, expires_at, used_at)` — `purpose` ∈ `VERIFY` | `DECIDE`. Single-use, hashed at rest, TTL'd. One table for both purposes so expiry, single-use enforcement and brute-force throttling have exactly one implementation, and a bug fixed in one fixes the other.
- `issues.approval_deadline TIMESTAMPTZ NULL` — set on resolve to `resolved_at + REOPEN_WINDOW_DAYS`, cleared when the reporter answers. Surfaced in all three issue DTOs, because a right that expires without ever being announced is not a right.
- `tracking_tokens(id, issue_id, creation_nonce, token_hash, created_at, last_used_at)` — `token_hash` is a SHA-256 of the token under a server-side pepper and the plaintext is never written to any column. `creation_nonce BYTEA NOT NULL` is 32 random bytes that reproduce the token under the pepper but cannot be inverted back into it without one, so it is a recomputation input rather than a copy of the secret. Multiple rows per reporter, because a shared kiosk legitimately creates several.
- `issues.ip_hash` — a salted, rotating hash used **only** as a rate-limit and abuse-detection key, TTL'd with the abuse window. `audit_logs.ip_address` stays null for concealed issues (§3.1).
- `issues.proposed_category_text VARCHAR(100) NULL` — set when the reporter picks the `OTHER` category. Creates nothing; surfaced in the manager's triage queue. Required when `categoryId` is `OTHER` and rejected otherwise. This is a cross-field conditional, which OpenAPI 3.1 cannot express in a schema, so it is a service-layer rule stated in prose only — the validation gate in `REQUIREMENTS.md` exists because nothing in the contract will catch its omission.
- `issues.idempotency_key` + two partial unique indexes — one on `(reporter_id, idempotency_key)` for signed-in reporters, one on `(ip_hash, idempotency_key)` for concealed ones. A single `(reporter_id, …)` index cannot work with a nullable reporter, and a shared index on the key alone would let one concealed citizen's retry collide with an unrelated one.
- `categories.active BOOLEAN NOT NULL DEFAULT true` and `departments.active BOOLEAN NOT NULL DEFAULT true`. Retired, never deleted. `/reference/*` returns active rows only, and deactivating a department or category that still holds open issues is refused with a 409 rather than silently orphaning live reports.
- `issues.priority_score INT` + `issues.score_breakdown JSONB` alongside the `priority` band.
- `issue_attachments.kind` ∈ `ISSUE_PHOTO` (max 3 per issue, enforced in service) | `RESOLUTION_EVIDENCE`; stores `file_key`, **never a public URL**.
- `issue_comments` gains `edited_at`, `revision_count`, `deleted_at`, `author_id NULL` (a concealed reporter's comment is attributable to the token, which is never exposed). `comment_revisions(id, comment_id, body, edited_by, created_at)` is **append-only**, one row per superseded version. This is what lets a comment be corrected inside its window without weakening the audit trail — the trail is extended, not punched through.
- `resolution_reports` is created **without** `ai_summary`; that column is added in V3 when summarization exists. A nullable column would be dead weight in V1 and an `ALTER` in V3 is free.
- `issue_status_history` and `audit_logs` are **append-only** — no update or delete code path exists, and there is a test asserting it. `comment_revisions` is held to the same standard.
- Full `audit_logs` with an `@Aspect` arrives in V2; V1 records transitions in `issue_status_history` (PLAN's explicit design: the audit log replaces the simple history once it exists).

### V2 — Triage and Workflow

`issue_assignments` · `sla_policies` · `sla_tracking` · `audit_logs` · `issue_confirmations` (`UNIQUE(issue_id, user_id)`) · `category_proposals` · `notifications` · `processed_messages`

- A user has **one** department via `users.department_id`. PLAN's `staff_departments` join table is dropped — it models multi-department staff, which this product does not need, and a join table in the authorization path is a place for bugs to hide.
- `notifications.channel` ∈ `IN_APP` | `EMAIL` | `PUSH` from day one. `EMAIL` is wired in **V1** for concealed reporters (§3.1) and `IN_APP` in V2; `PUSH` stays unwired.
- `category_proposals(id, normalized_text, issue_count, status[OPEN|PROMOTED|DISMISSED], resolved_category_id)` aggregates repeated `proposed_category_text` values so a manager can promote a real problem into a real category instead of merging the same three near-duplicates by hand every week. P1 only stores the text on the issue; this table is what turns a pile of proposals into taxonomy.

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

**The outbox row holds `issue_id` and channel, never an address.** The `notification.queue` consumer reads the address from `contact_channels` at dispatch time, decrypting it, and it is the only component holding both an issue and a contact channel. That is what lets a failed dispatch be recorded precisely (`last_error` on the channel, `state = UNDELIVERABLE`) rather than guessed at — the report row and the channel row are updated together, so "we emailed them and it bounced" and "we decided not to email them" are distinguishable states in the data rather than a matter of inference.

---

## 12. Cache (Redis)

| Item | Key | TTL | Invalidation |
|---|---|---|---|
| Dashboard aggregates | `dash:{role}:{deptId}` | 60 s | time-based; short staleness acceptable |
| Reference lists | `ref:categories`, `ref:departments` | 1 h | explicit evict on admin write |
| Rate-limit counters | `rl:{identity}:{endpoint}` where identity is a user id or a salted IP hash | rolling | expires naturally |
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
├── core/        AuthService, TokenStore, AuthInterceptor, ErrorInterceptor, RoleGuard, CorrelationIdInterceptor, TrackingTokenStore
├── shared/      StatusBadge, PriorityBadge, SlaCountdown, FileUploader, CommentThread, StatusTimeline, MapPicker, PublicIssueCard, DisclosureChoice
├── layouts/     CitizenShell, OfficerShell, ManagerShell, AdminShell
└── features/
    ├── auth/        login, register
    ├── issues/      report, my-reports, issue-detail, public-issue-detail
    ├── tracked/     concealed-reports, tracked-issue-detail — token in localStorage, never a URL
    ├── contact/     verify, decision — the approval gate, reached from an emailed link
    ├── officer/     assigned, resolve
    ├── manager/     queue, assignment, sla-monitor, duplicate-review, category-proposals, analytics
    ├── admin/       users, departments, categories, sla-config, audit-logs
    └── notifications/
```

`TrackingTokenStore` keeps the concealed token in `localStorage` under a CivicLens key, attaches it via an interceptor, and clears it on explicit "forget this report". The token is a bearer credential, so it is never placed in a route, a query string or a `Referer` — a shared link to `/tracked/...` must be impossible to construct by copying the address bar.

The `/contact/**` pages are the deliberate exception, and the reason is narrow: the approval link is often opened in a different browser or a different device from the one that holds the tracking token, so making it depend on that token would fail exactly when it is most needed. What arrives in the query string there is a single-use token that grants no access to report content — no body, no comments, no status. It is consumed on arrival and replaced with a token-free URL, so the browser history entry cannot be replayed and the address bar stops being a credential. The report's actual content still requires the tracking token.

Two interceptors of note: the auth interceptor attaches the bearer token and transparently refreshes once on 401; the correlation-id interceptor echoes `traceId` from error responses into the UI so a citizen can quote it in a support request. Accessibility: every interactive element reachable by keyboard, visible focus, AA contrast, `aria-live` on async status changes, and a form that survives a flaky connection without losing typed input.

**Vocabulary:** the UI says **"Report"**; the domain, API, and database say `issue`.

---

## 15. Phases and gates

PLAN.md remains the source for effort estimates and cut order. Scope mapped to the merged spec:

| Phase | Ships | Gate |
|---|---|---|
| **P1 — Report and Track** | Auth, roles, **concealed reporting with a tracking token, a verified contact channel and `/tracked/**` + `/contact/**`**, issue create (3 photos, map pin, explicit no-default disclosure choice, `OTHER` free text), full 11-state machine **with no auto-close and a reporter approval gate on every close**, priority v1, my-reports + timeline, staff list/detail/transition, stale-resolution + undeliverable-approval queues, public shareable page with concealed title redaction, comment edit within window, resolution report, seed data, deploy | A stranger reports a pothole from a phone browser **without an account**, verifies their email, gets a tracking link, receives the officer's proposed fix by email, disputes it, and watches it reopen. CI green, deployed, seeded, README with run steps |
| **P2 — Triage and Workflow** | Departments + routing, assignment, SLA policies + overdue job, audit log, outbox + RabbitMQ + **general transition emails to signed-in citizens**, Redis cache + rate-limit budget headers, confirmations, rule-based duplicate flags, `category_proposals` promotion flow, free-text `?q=` search on `GET /issues` | An issue breaches SLA and appears in the overdue queue; the citizen gets an email on every transition; staff see only their department. The concealed-reporter email path already exists from P1 — P2 widens it, it does not introduce it |
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
- [ ] Rate limits live on login, register, issue create, comments, public reads, `/tracked/**`, `/contact/**`, AI paths.
- [ ] Rate-limited responses carry `X-RateLimit-*` budget headers on success as well as on 429, and `Retry-After` on 429. `node scripts/check-rate-limit-pairing.mjs` exits 0, so §7.5 and the contract have not drifted apart in either direction.
- [ ] Concealment: `public_code` is never accepted as a credential; tracking tokens are derived from a nonce and persisted hashed only, with no plaintext column anywhere including the idempotency store; a token reaches only its own issues.
- [ ] Concealment: a replayed `Idempotency-Key` returns the original `trackingToken`, re-derived rather than read back, so a retry is served without ever putting a usable credential at rest.
- [ ] Concealment: `audit_logs.ip_address` is null for every action on a concealed issue, and the reporter's IP appears in no admin-readable table.
- [ ] Concealment: `TrackedIssueDetail` and `PublicIssue` are asserted field-for-field in tests, and the public title of a concealed report is redacted.
- [ ] **Concealment: no reporter address is stored in the operational database.** An integration test asserts the issue store has no column, table or JSONB path that can hold one, and that a reporter address submitted to `POST /issues` never appears in an operational-DB query result, an `IssueDetail`, a `TrackedIssueDetail`, a `PublicIssue`, the CSV export, an `audit_logs` row, or a log line. `contact_channels` is a separate database reached with separate credentials; a test asserts the reporting service's datasource has no grant on it.
- [ ] **Concealment: no concealed report is queued before its channel is verified.** A test submits a concealed report, leaves it unverified, and asserts it is absent from every triage, assignment and SLA query, and that `contact_state` reads `PENDING_VERIFICATION`.
- [ ] **Concealment: a leaked tracking token cannot deconceal.** A test calls `POST /tracked/issues/{id}/reveal` and asserts `disclosure` is still `CONCEALED` until the new address is verified.
- [ ] **Concealment is one-way.** A test asserts there is no inverse reveal operation in the contract and no service method that sets `disclosure` back to `CONCEALED` from `SHARE_DETAILS`.
- [ ] **Contact tokens are single-use, hashed, TTL'd, and brute-force throttled.** A test replays a used verification token and a used decision token and asserts 410, and asserts no `contact_tokens.token_hash` column stores plaintext.
- [ ] Comments: edit and delete write revisions and audit rows; neither overwrites in place; editing invalidates a cached `ai_summary`.
- [ ] Nothing transitions an issue to `CLOSED` except its own reporter's approval, and **the same gate serves concealed and signed-in reporters**. No timer, job or SYSTEM actor can close one.
- [ ] **No delivery failure can close or advance a report.** A test forces a permanent bounce on a concealed reporter's channel and asserts the report is still `RESOLVED`, `contact_state` is `UNDELIVERABLE`, and it is visible in the manager's undeliverable-approval queue.
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
STALE_RESOLVED_DAYS=14              # stale-resolution queue. Never closes anything
COMMENT_EDIT_WINDOW_MINUTES=30
DUPLICATE_RADIUS_METERS=150
DUPLICATE_SIMILARITY_THRESHOLD=0.85
RETENTION_DAYS=730

# Concealment — all of these are secrets, generate them, never commit real values
TRACKING_TOKEN_PEPPER=              # HMAC key for hashing tracking tokens
IP_HASH_PEPPER=                     # HMAC key for IP hashing
IP_HASH_ROTATION_DAYS=30            # rotated on this cadence, old hashes dropped
ABUSE_WINDOW_DAYS=30                # how long an IP hash is retained
CONTACT_ENCRYPTION_KEY=             # envelope key for contact_channels.encrypted_value
                                     #   (BYTEA, key held outside the DB - KMS or env)
CONTACT_ENCRYPTION_KEY_ID=          # key version, so the ciphertext can be rotated
                                     #   later without a migration over live addresses
CONTACT_TOKEN_PEPPER=               # HMAC key for contact_tokens.token_hash
SMTP_API_KEY=                        # transactional sender for the approval gate
CONTACT_VERIFICATION_TTL_MINUTES=30  # how long a "prove you own this address" link lives
DECISION_TTL_DAYS=14                 # approval/dispute link lifetime; matches REOPEN_WINDOW_DAYS
```

There is deliberately **no `AUTO_CLOSE_AFTER_DAYS`**. See §4: nothing closes an issue on a timer, and `STALE_RESOLVED_DAYS` only drives a manager queue.

Priority band thresholds (`80` / `55` / `30`) and all rate limits are configuration, not code.

---

## 19. Decisions taken while reconciling the architecture spec

These four were not in the original 36 and come from reading `docs/CivicLens-Architecture-Spec.md`. All default to my recommendation and are flagged for veto.

| # | Question | Decision | Why |
|---|---|---|---|
| N1 | Auto-close vs. reopen right | **Auto-close removed entirely.** `RESOLVED → CLOSED` is CITIZEN-only; `REOPENED` stays reachable from `CLOSED` within the 14-day window; the gap is covered by a `staleResolvedOnly` manager queue | An N-day auto-close silently destroys a citizen's right to dispute a fix, and teaches departments that reports vanish on their own. Replaced with a non-destructive queue that keeps a human in the loop |
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

NgRx · microservices · Kubernetes · a dedicated vector database · a generic rules-engine DSL for priority · a generic "vector search framework" · open-ended NL-to-SQL · image-embedding duplicate matching · WebSocket/SSE realtime (poll and refresh are enough) · multi-city tenancy · multi-language i18n · a general public open-data API · autonomous AI actions · open-ended NL analytics (cut first) · **citizen-created categories** (a proposal, reviewed by a manager — see §7.2 and §8 V2) · **tracking-token recovery** (it would require holding the identifier concealment exists to avoid; the verified contact channel is the sanctioned route back, and it is a different thing) · **auto-close on any timer** (see §4) · **SMS or push as a concealed reporter's channel** (email only in P1; two channels means two delivery-failure paths to get right before there is a second reporter) · **a sender-reversible reveal**.
