# Section B — Core Competencies, AI Reasoning & Scenarios

> **Format note.** Descriptive prose in every answer is held under the 150-word
> limit (verified by script; counts listed in `WORD-COUNTS.md`). Tables carry
> enumerations, and fenced blocks carry the artifacts the questions explicitly
> ask to be produced — a rewritten system prompt (Q6), refactored code (Q7), a
> rewritten JSON schema (Q13), a triage briefing sheet (Q15) and a CoT prompt
> (Q16). Those are deliverables, not description, and are counted separately.

---

## Q4. Architectural Critique: The Cascading Drift in Multi-Agent Synthesis Pipelines

**1. The structural vulnerability**

The loop has no independent oracle. Agent B infers *expected* behaviour by reading
Agent A's source, so specification and implementation collapse into one artifact —
and a suite written from the code under test can detect that the code *changed*,
never that it is *wrong*.

Dependency mirroring converts that single defect into three approvals drawn from one
information source. A's race condition becomes B's asserted baseline; C reads only
B's green report, so C's sign-off is a pure function of A's diff. The chain looks
like defence in depth and is one point of failure with two amplifiers.

Confidence also rises falsely: a human reviewing three agreeing agents reasonably
infers corroboration that does not exist.

**2. The external deterministic layer**

Gate on artifacts authored **before and independently of** A's diff:

| Layer | Enforces |
|---|---|
| OpenAPI / protobuf / JSON Schema, frozen per release | request and response shape |
| Consumer-driven contracts (Pact broker) | every service boundary the diff touches |
| Property-based invariants (Hypothesis, jqwik) | conservation laws that must hold for all inputs |
| Model checking (TLA+, Alloy, `-race`, Lincheck) | linearisability and isolation — unreachable by example-based tests |
| Static analysis, pinned ruleset | taint flows, lock discipline |
| Mutation testing against the frozen spec suite | rejects the build if B's tests survive a forbidden mutant |

The non-negotiable property: **the validation layer's input set must not contain
Agent A's diff.** Everything else is hygiene.

---

## Q5. Log File Analysis: Garbage Collection Leaks & Microtask Loop Starvation

**1. Sequence of events**

`processor.js` reads frames faster than it completes them, so socket descriptor 12
overflows — no backpressure is applied. Each frame enters a promise chain, and every
unresolved promise's closure retains its captured payload, so 68,240 pending closures
pin 68,240 buffers.

The retained set grows monotonically to 98.4%, and V8 responds with full mark-compact
cycles every 12 ms. That is the inversion point: GC owns the thread, the microtask
queue — the only mechanism that could *drain* those closures — never runs, and the
socket keeps delivering. Compaction is reported "ineffective" precisely because
nothing is unreachable.

Root cause is unbounded queueing, not a classical leak.

**2. Why functional E2E reports green**

The failure is a function of *concurrent arrival rate × retention time*. One user
drives one socket: the buffer never saturates, each promise resolves before the next
frame arrives, retention stays near zero, and V8 never leaves the scavenger.

Functional checks also assert the wrong property class — *output correctness*, which
remains correct until the instant the process dies. Nothing in the suite asserts
queue depth, heap fraction, GC pause share, or event-loop lag, so there is nothing
to fail on.

| Gate that would catch it | Ceiling |
|---|---|
| event-loop lag p99 | < 100 ms |
| `heapUsed / heapLimit` | < 0.80 sustained |
| GC pause share of wall time | < 5% |
| pending-task / queue depth | bounded, asserted non-growing over a 30-min soak |

---

## Q6. AI Code Safety Review & Prompt Engineering Mitigation

**1. Breaking tenant isolation**

Every parameter is f-string interpolated, so `tenant_id` is SQL, not data. Passing
`1' OR '1'='1' --` rewrites the predicate to always-true and returns every tenant's
rows; `1' UNION SELECT table_name,NULL,NULL FROM information_schema.tables --` pivots
to schema enumeration. `target_metric` and `filtering_date` are equally open.

The deeper defect is architectural: tenant isolation lives **inside the WHERE
clause**, so one injection anywhere dissolves the entire boundary. Row-level security
or a per-tenant connection role would survive the injection; a string predicate
cannot.

Secondarily, `SELECT *` leaks columns added after review, and the unbounded
`fetchall()` is a memory-exhaustion vector — one `OR '1'='1'` pulls the whole table
into the process.

**2. Rewritten developer system prompt**

````text
# ROLE
You generate Python data-access functions for a multi-tenant analytics platform
handling regulated customer data. The constraints below are not stylistic
preferences; a violation is a rejected output, not a warning to attach.

# MANDATORY STRUCTURAL PRIMITIVES

1. PARAMETERISATION IS THE ONLY WAY VALUES ENTER SQL.
   - Every value MUST pass through the driver's parameter sequence:
     cursor.execute(sql, params)
   - The SQL string MUST be a module-level constant of literal text and
     placeholders only. It MUST NOT be assembled at call time.
   - FORBIDDEN in SQL construction, without exception: f-strings, %-formatting,
     .format(), +, join(), or any expression placing a caller value in the string.
   - If a requirement appears to need dynamic SQL, apply rule 2. There is no
     third option.

2. IDENTIFIERS ARE ALLOW-LISTED, NEVER INTERPOLATED.
   Column, table and sort-direction names cannot be parameterised by any driver,
   so they MUST be looked up in a frozen module-level mapping:
       _METRIC_COLUMNS = {"revenue": "metric_revenue", ...}
   On a miss, raise ValueError. Never pass the caller's string through, even
   escaped, even quoted.

3. TENANT ISOLATION IS ENFORCED TWICE.
   - in the predicate, as a bound parameter
   - outside the query: SET LOCAL app.tenant_id for row-level security, or a
     per-tenant connection role
   A single-layer tenant filter is a rejected design.

4. EXPLICIT PROJECTION, BOUNDED RESULTS.
   Name every column; SELECT * is forbidden. Every query carries a LIMIT bound by
   a parameter with a documented server-side maximum. Use fetchmany() or a
   server-side cursor; never unbounded fetchall().

5. TYPED BOUNDARY.
   Validate and coerce before the query: tenant_id -> int, dates -> datetime.date,
   metric -> allow-list key. Reject invalid input; do not sanitise it.

6. RESOURCE DISCIPLINE.
   Acquire the connection in a context manager. Never hold it across a network
   call to another service.

# OUTPUT SCHEMA - emit in exactly this order, nothing else
  1. module-level SQL constant(s), placeholders only
  2. module-level identifier allow-list mapping(s)
  3. the function, fully type-annotated, returning list[TypedDict] or a dataclass
  4. a "# SECURITY:" block naming, line by line, where rules 1-6 are satisfied
  5. the unit test proving rule 1: assert tenant_id="1' OR '1'='1" returns zero
     rows, not all rows

# SELF-CHECK BEFORE EMITTING
Scan your own output for: an f-prefix before a SQL literal, % inside a SQL
literal, .format( on a SQL literal, SELECT *, fetchall(, and any query string
built inside a function body. If any is present, discard and regenerate from
rule 1. Do not explain the violation; do not emit it.

# REFUSAL
If a request cannot be satisfied under these rules - for example "let the caller
pass an arbitrary WHERE clause" - name the blocking rule and propose the
allow-listed equivalent. Never produce the unsafe version alongside a warning.
````

---

## Q7. Flaky Test Code Review & Clock-Drift Desynchronization in Ephemeral Workers

**1. Why it is severely flaky on shared-core runners**

`setTimeout(15000)` encodes a guess about someone else's scheduler. On a shared vCPU,
steal time and noisy neighbours mean replication finishes in 2 s or 40 s.

Worse, `isVisible()` samples once. A toast rendering at 15.1 s reads false — and one
that auto-dismissed at 14 s also reads false. It fails in both directions, which is
why the flake looks random.

`performance.mark` reads `CLOCK_MONOTONIC` while the assumption is wall-clock;
ephemeral containers rarely run NTP, and the two clocks diverge across host suspend
and VM migration. The `else` branch then reloads, discarding transaction context and
risking a double submit.

With no assertion the test cannot fail — it silently takes the wrong branch and
reports green.

**2. Refactored implementation**

```javascript
// Three changes carry the determinism:
//   1. No wall-clock guess. Every wait observes a state change, and the retry
//      cadence belongs to Playwright, not to us.
//   2. Assertions, not branches. A missing toast fails the test instead of
//      silently taking a reload() path that can double-submit.
//   3. The settle signal is subscribed to BEFORE the action that triggers it,
//      closing the race where the event fires in between.

const { test, expect } = require('@playwright/test');

test('ledger transaction completes and can be confirmed', async ({ page }) => {
  // Subscribe first. Registering after navigation would race the event.
  const settled = page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        window.addEventListener('ledger:replicated', (e) => resolve({ ok: true, detail: e.detail }), {
          once: true,
        });
        window.addEventListener('ledger:failed', (e) => reject(new Error(e.detail?.code)), {
          once: true,
        });
        // Late-subscription guard: if it already settled, read the state.
        if (window.__LEDGER__?.replicated) resolve({ ok: true, detail: window.__LEDGER__.state });
      })
  );

  await page.goto('https://core-platform.com/ledger-vault', { waitUntil: 'domcontentloaded' });

  // Resolves on the application's own replication event - no fixed duration.
  expect((await settled).ok).toBe(true);

  // Web-first assertion: retries until the condition holds, and FAILS if it
  // never does. This is the line the original was missing.
  const toast = page.getByRole('status').filter({ hasText: /transaction complete/i });
  await expect(toast).toBeVisible({ timeout: 30_000 });

  const confirm = page.getByRole('button', { name: /confirm/i });
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expect(page.getByRole('status')).toContainText(/confirmed/i);
});
```

If the app emits no such event, use `page.waitForResponse` on the replication
endpoint or `expect.poll` against a status API — never a sleep. An unobservable wait
is a **testability defect to fix upstream**, not a duration to tune.

---

## Q8. Systems Concurrency & Connection Pool Leak Mechanics under Distributed Strain

**1. Profiling strategy**

The error message is consistent with both hypotheses, so the strategy is to measure
*where connections spend their time* rather than how many exist.

The decisive comparison is **connection hold time against query execution time**,
read alongside the presence of a database-side blocking chain. Hold ≈ execution with
a blocking chain is lock contention. Hold ≫ execution with an idle database is a
leak — almost always an HTTP call made inside a `@Transactional` block, which pins a
connection for the duration of someone else's network latency.

| # | Step | Discriminates |
|---|---|---|
| 1 | Export HikariCP metrics; set `leakDetectionThreshold=20000` **before** reproducing | without a timeline everything after is guesswork |
| 2 | Reproduce at 50 / 100 / 200 runners | linear onset → sizing; abrupt threshold with an idle DB → contention |
| 3 | Three `jstack` dumps 10 s apart during saturation | `BLOCKED` on `SocketInputStream.read` → waiting on the DB; `WAITING` on `HikariPool.getConnection` → waiting on the pool |
| 4 | Compare `connection.usage` p99 to query duration p99 | hold ≫ execution → leak |
| 5 | `pg_locks` ⋈ `pg_stat_activity`, or `performance_schema.data_lock_waits` | a real blocking chain exists, or it does not |
| 6 | Raise pool size 50% and re-run | throughput rises → sizing; wait merely shifts to the DB → the pool was correctly protecting an overloaded backend |

**2. Telemetry that confirms the diagnosis**

| Metric | Lock contention | Thread / connection exhaustion |
|---|---|---|
| `hikaricp_connections_active` / `_idle` | active at max, idle 0 | active at max, idle 0 |
| `hikaricp_connections_pending` | high | high |
| `hikaricp_connections_usage_millis` p99 (hold) | ≈ query time | ≫ query time |
| `hikaricp_connections_acquire_nanos` p50 / p95 / p99 | p99 ≫ p50 | all percentiles climb together |
| JVM thread states | many `BLOCKED` on socket read | many `WAITING` on the pool |
| `innodb_row_lock_time_avg` / blocked-PID count | rising, with a blocking chain | flat |
| DB active sessions vs pool size | sessions ≈ pool, all running | sessions ≪ pool |

---

## Q9. Operational Ambiguity: Headless CSS Layout Tree Thread Collapses

**1. How 1,000 checks pass over a blank screen**

Because they assert the wrong layer. The compiler crashes *after* DOM construction,
so `querySelector` resolves and `textContent` is correct — the object graph exists
and only layout and paint failed. A suite built on DOM presence measures something
that never broke.

It is also invisible to the usual tripwires by construction: no HTTP status, no DOM
exception, no console syntax error. Nothing to listen for.

Headless compounds it — without a real compositor, paint is often skipped entirely,
so "nothing painted" is indistinguishable from success. And 1,000 checks on the same
DOM contract give 1,000× confidence in one property: breadth of count, not of
coverage.

**2. Structural visual triage layer**

Assert on geometry and paint, not markup:

| Gate | Signal | Fails when |
|---|---|---|
| Layout produced | `getBoundingClientRect()` area > 0 for the app root and each critical region | layout tree construction halted |
| Layout ran | CDP `Performance.getMetrics` → `LayoutCount > 0`, `LayoutDuration > 0` | no layout pass occurred |
| Paint occurred | LCP > 0 and `first-contentful-paint` present via `PerformanceObserver` | nothing was painted |
| Non-blank frame | screenshot pixel variance / distinct-colour count above a floor | uniform blank render |
| Perceptual diff | visual regression per breakpoint and theme | silent layout regressions |
| Error channel | `page.on('pageerror')`, console `error`, CSP violations, `unhandledrejection` — all piped into failure | the crash is thrown but unlistened |

Run these under `--headless=new` or headed so a compositor exists, and add a
production canary reporting a blank-frame metric so detection is not CI-only.

---

## Q10. Next-Generation Agentic Loops: Autonomous Multi-Branch Cascading Loops

**1. External architectural validation layer**

The agent must never hold the capability it abused. Privilege belongs to a
**non-generative applier** that the agent can only submit to — something that cannot
be argued with, reasoned around, or prompt-injected.

The load-bearing rule is that the compute ceiling is enforced at the cloud-provider
layer, as a quota or spend cap, not inside agent logic. An agent in a recursive loop
cannot be trusted to respect its own limit.

| Control | Implementation |
|---|---|
| No direct write path | ephemeral sandbox, no push credentials; output is a patch bundle |
| Deterministic applier | separate service validates each patch against static policy, then applies |
| Path scoping | write allow-list by glob; hard deny on CI config, IAM, migrations, secrets, dependency manifests |
| Hard resource ceiling | provider-level quota and spend cap |
| Rate limits | max branches/hour, commits/branch, wall-clock per task |
| Attempt dedup | hash `(failure_signature, proposed_diff)`; refuse a signature attempted K times |
| Progress circuit breaker | no objective-metric improvement across N iterations → halt and page |
| Human gate | anything touching the deny list, or any diff over a size threshold |

**2. Telemetry that flags a hallucination loop**

The signature is **activity without progress**, so instrument progress:

| Parameter | Trigger |
|---|---|
| iterations since the objective metric last improved | plateau while activity continues |
| diff self-similarity (Levenshtein / cosine between consecutive diffs) | collapse toward 0, or oscillation between two states — the agent is reverting itself |
| error-signature novelty ratio (unique ÷ total) | collapse toward 0 — re-encountering one wall |
| branch creation rate, branch-from-branch depth | the 85-branch symptom, caught in minutes |
| compute cost per resolved failure | leading economic indicator |
| tool-call sequence entropy | a repeating n-gram is a loop |
| **time since last novel state** | the single best trigger; hard-cap it |

Alert on the *conjunction* of plateau and high activity; either alone is normal.

---

## Q11. AST-Driven Test Selection Frameworks & Contextual Path Dependency Mapping

**1. System logic**

Line diffs are the wrong granularity — a reformat changes every line and no
behaviour. Parse both revisions to ASTs and diff at **declaration** level, yielding
changed symbols: functions, methods, classes, exported members, schema and constant
definitions.

Resolve impact through two graphs. A **static graph** built from imports, call sites,
DI bindings and route registrations gives each changed symbol's transitive
reverse-dependency closure. A **dynamic coverage map** from prior runs records which
test executed which symbol. Intersect them.

Rank candidates by historical failure correlation and execution cost, running highest
signal-per-second first so the pipeline fails fast. Classify the change: body-only
edits select narrowly; signature, schema or configuration changes widen the closure
sharply.

**2. Minimising the subset without losing distributed coverage**

Selection is an optimisation with a non-negotiable **safety floor**. Coverage maps
are blind to reflection, DI, dynamic imports, serialised boundaries and
config-driven wiring — exactly the mechanisms distributed systems are built from.

| Always-run overlay | Reason |
|---|---|
| every consumer-driven contract test for a boundary the diff touches | cross-service breakage is invisible to coverage |
| tests tagged critical-path (auth, payment, deletion) | consequence, not probability |
| any test with missing or stale coverage data | treat unknown as impacted |
| **fail-open triggers** — build config, shared schema, framework version, IaC | run everything |

Then measure the framework itself: nightly full runs compute **selection recall** —
failures the full run caught that selection would have skipped. Publish it as an SLO
and widen the closure when it drops. Selection without a measured recall number is a
hope, not a control.

---

## Q12. Self-Healing Testing Engines: Graph-Based Structural Neighbor Analysis

**1. The algorithmic failures**

Four compounding errors.

**Wrong feature space** — similarity was computed over visual and spatial properties,
which correlate with *appearance*, not identity. `.btn-danger` and
`#confirm-balance-wipe` share a semantic field (destructive), and the engine read
that resemblance as evidence of sameness.

**Best-match-wins with no absolute floor** — ranking always yields a winner, so the
nearest candidate is selected even when every candidate is poor.

**Absence treated as neutral** — nothing resembled the original locator, which is
strong evidence the element was *removed* and should collapse confidence. It was
ignored.

**Consequence was not a variable** — likelihood was weighed, cost never was. Closing
a modal and wiping a cluster scored identically, and healing was permitted to *act*
rather than propose.

**2. Confirmation protocol and scoring model**

Composite score, components normalised to [0,1]:

| Signal | Weight | Computation |
|---|---|---|
| Accessible identity | **0.32** | exact `role` + accessible-name match — the strongest semantic key |
| Locator-string similarity | 0.22 | `1 − normalisedLevenshtein(old, candidate)` over the *stable* attribute, not the class |
| DOM neighbour-graph proximity | 0.20 | Jaccard overlap of ancestor chains + inverse shortest-path distance to the original's surviving siblings |
| Stable-attribute overlap | 0.14 | `data-testid`, `name`, `type`, `aria-*` set intersection |
| Historical stability | 0.12 | how often this candidate was previously the correct heal |

Hard gates, evaluated **before** the score is consulted:

| # | Gate |
|---|---|
| 1 | **Destructive classification** — flag if the accessible name, `aria-label`, surrounding copy, or triggered HTTP method matches a destructive lexicon (`delete`, `wipe`, `drop`, `purge`, `revoke`, `terminate`), or if it sits inside a confirmation dialog |
| 2 | **Asymmetric thresholds** — non-destructive auto-heals at score ≥ 0.85; **destructive never auto-heals** and fails immediately pending human approval |
| 3 | **Role invariance** — reject any candidate whose computed role differs from the original's last known role. A `button` never heals to a `link`. |
| 4 | **Consequence asymmetry** — where the original's action class is unknown, a destructive candidate is rejected outright |
| 5 | **Two-signal confirmation** — above threshold, verify against an independent signal (state transition or `aria-live` announcement) in a dry-run environment before committing |

Governing principle: **a self-healing engine may reduce false negatives; it must
never be permitted to create an irreversible false positive.** The expected cost of a
destructive false positive is unbounded; a failed test costs one engineer-hour.

---

## Q13. Model Context Protocol (MCP) Sandboxing: Zero-Trust Schema Configurations

**Why the original cannot be fixed by filtering**

Its input is one free-form string handed to a shell. Blocklisting `&&` and `|` is a
losing game — `$(…)`, backticks, newline, `;`, `%0a`, unicode homoglyphs and
`bash -c` all survive it.

The durable fix has two halves, and neither is sufficient alone: make injection
**unrepresentable in the schema**, and **remove the interpreter** that would execute
it. With no shell behind the tool, `&&` is just bytes in a filename that does not
exist.

**Rewritten tool definition**

```json
{
  "name": "read_service_log_tail",
  "description": "Read the trailing lines of one allow-listed application log file. Strictly read-only. This tool cannot chain commands, spawn a shell, pipe, redirect, glob, write, delete, or reach any path outside /var/log/frugal-app/. It accepts no command string of any kind.",
  "input_schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["log_name"],
    "properties": {
      "log_name": {
        "type": "string",
        "description": "Which log to read. A closed set, not a path: separators, traversal sequences and wildcards are not expressible here.",
        "enum": [
          "api-gateway.log",
          "auth-service.log",
          "ledger-engine.log",
          "scheduler.log",
          "exception-analyzer.log"
        ]
      },
      "lines": {
        "type": "integer",
        "description": "Number of trailing lines to return.",
        "minimum": 1,
        "maximum": 150,
        "default": 150
      },
      "grep_literal": {
        "type": "string",
        "description": "Optional case-insensitive LITERAL substring filter, applied in-process after reading. Not a regex, never passed to a shell. The pattern excludes every shell and regex metacharacter.",
        "maxLength": 64,
        "pattern": "^[A-Za-z0-9 _:.@/-]*$"
      },
      "since_iso8601": {
        "type": "string",
        "description": "Optional lower bound on log line timestamps.",
        "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,6})?Z$"
      }
    }
  },
  "annotations": {
    "readOnlyHint": true,
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": false
  }
}
```

**Server-side enforcement the schema cannot express**

| # | Control | Effect |
|---|---|---|
| 1 | **No shell, ever** — in-process file I/O, or `execve` with an `argv` array. Never `sh -c`, `exec()`, or `shell: true` | removes the interpreter; chaining has no meaning |
| 2 | `realpath(join(ROOT, log_name))`, reject unless still prefixed by `ROOT` | defeats symlink escape even though the enum already blocks traversal |
| 3 | `O_RDONLY` on a read-only bind mount, non-root uid, no write capability in the namespace | mutation is impossible, not merely unrequested |
| 4 | `seccomp-bpf` allow-list: `openat`, `read`, `fstat`, `lseek`, `close`, `exit_group` | `execve`, `write`, `unlink`, `socket` denied by the kernel, not by review |
| 5 | Response byte cap (256 KB) with an explicit truncation marker | bounds tokens; prevents log-flood exfiltration |
| 6 | Per-session rate limit; audit every call with resolved path and caller identity | detection and forensics |
| 7 | Server-side re-validation against the same schema | never trust that the client validated |

Net effect: the model's maximum achievable action is "read at most 150 lines of one
of five named files." Command chaining, subshell piping, file mutation and arbitrary
disk writes have no representation in the interface and no interpreter behind it.

---

## Q14. Systems Scalability: Asynchronous Log Ingestion Topographies for Enterprise Triage

**1. Horizontally scalable architecture**

35,000 bundles in 30 s is ~1,170/s of *large* payloads. The design rule is that the
synchronous path must do almost nothing.

Two decisions carry most of the benefit. **Reject base64 at the contract level** —
issue a presigned URL so screenshots upload directly to object storage, removing the
largest component from the request path entirely. And **fingerprint before doing any
expensive work**: a merge storm's 35,000 payloads typically collapse to dozens of
distinct stack signatures, so deduplication, not scaling, is the primary cost control.

| Stage | Design |
|---|---|
| Edge | stateless autoscaled tier; validates size, content type, auth only — never parses traces |
| Claim check | stream the body to S3 under a content-addressed key; enqueue only `{s3_key, service, release_sha, trace_id, fingerprint, received_at}` |
| Broker | Kafka partitioned by `fingerprint` so identical failures dedupe locally; retention in hours so a consumer outage is recoverable, not lossy; DLQ for poison messages |
| Workers | stateless consumer groups autoscaled on **consumer lag**, not CPU |
| Storage tiers | Redis (fingerprint dedupe, TTL) · Postgres (triage records, state) · S3/Parquet + Athena (raw traces) |

**2. Protecting against token limits and pool exhaustion**

| Risk | Control |
|---|---|
| LLM rate limits | per-tenant and global token buckets; a semaphore bounding in-flight calls well under the account RPM/TPM |
| LLM cost | analyse **one representative per fingerprint group** and fan the verdict out; cheap classifier triages first, escalating only ambiguous cases; cache by fingerprint |
| Provider `429` | exponential backoff with full jitter, then DLQ after N attempts — the queue is the buffer, so bursts extend latency and never drop data |
| DB connections | one bounded pool per process, `(cores × 2)` × replicas kept under `max_connections`, with PgBouncer in transaction mode so 200 workers ≠ 200 backends |
| **Connection pinning** | **never hold a connection across an LLM call** — a 20 s completion pins it for 20 s; this is the classic exhaustion cause |
| Write amplification | `COPY` or multi-row upserts per batch, not per payload; transactions cover only the write |

Backpressure then propagates naturally: a saturated pool raises consumer lag,
autoscaling reacts, and Kafka absorbs the difference.

---

## Q15. Distributed Tracing & Cascade Failures across Distributed Ledgers

**1. Isolating the component**

**Span 5 — `LedgerDB`, Lock Wait Timeout Exceeded, 2043 ms.** It accounts for 2043 of
the gateway's 2150 ms, so everything above it is waiting, not failing.

Read the tree by *self-time*. `LedgerEngine` shows 2138 ms ERROR but 2043 ms of that
sits in its child, leaving ~95 ms of its own — it is a **propagator**, not the fault.
`TokenService` (12 ms) and `AccountService` (95 ms) are healthy.

The proximate cause is row-lock contention on `user_accounts` id=92. `AuditBalances`
reads that row earlier in the same transaction, so the read-then-write pattern
extends the lock hold window and serialises every concurrent transfer behind the
slowest one.

**2. How correlation tokens cross container boundaries**

The trace is reassembled from context propagated **in-band**, because the services
share no memory.

| Mechanism | Detail |
|---|---|
| Wire format | W3C `traceparent: 00-<32-hex trace-id>-<16-hex span-id>-<flags>`, carried as an HTTP header, gRPC metadata, or a message attribute for queue hops |
| Business keys | `baggage` carries e.g. `account_id=92`, making a trace searchable by domain identity |
| At each boundary | the SDK *extractor* reads the header into a context; the service starts a child span inheriting `trace_id` and setting `parent_span_id` to the caller's `span_id`; the *injector* writes the updated header onto every outbound call |
| The invariant | `trace_id` is immutable end to end — that alone lets a collector rebuild the tree from spans exported independently by five containers |
| Where it breaks | thread pools, async executors and queue consumers lose ambient context unless it is explicitly captured and restored; DB calls need `sqlcommenter`-style comment injection to tie `trace_id` to the statement — precisely what would have linked Span 5's lock wait to its blocking query |

**3. Triage briefing sheet — Database Platform Team**

> **To:** Database Platform · **Severity:** P1, launch blocker
> **Trace:** `POST /v5/payment/process` → Span 5 · `LedgerDB` · Lock Wait Timeout
> **Symptom:** 2043 ms lock wait on `user_accounts` id=92 under concurrent checkout
> load, surfacing as HTTP 500 at the gateway.
> **Diagnosis:** row-lock contention with an over-long hold window — not
> insufficient capacity. The application reads the balance (Span 4) and updates it
> (Span 5) inside one transaction, so the queue is as long as the *transaction*,
> not as long as the update.

| # | Requested change | Rationale |
|---|---|---|
| 1 | Replace read-then-write with a **single atomic conditional update** — `UPDATE user_accounts SET active_balance = active_balance - 500 WHERE id = 92 AND active_balance >= 500`, then branch on affected rows | Removes the read-modify-write window. The lock is held for one statement, not one transaction. This alone should clear the timeout. |
| 2 | Where a prior read is unavoidable, take the write lock **first** with `SELECT … FOR UPDATE` at transaction start, and move `AuditBalances` **out** of the write transaction | Eliminates the shared→exclusive lock upgrade generating the convoy |
| 3 | Enforce **deterministic lock ordering by primary key** for multi-row transfers | Prevents deadlock and convoy formation on overlapping accounts |
| 4 | Lower `innodb_lock_wait_timeout` 50 s → **3 s**; add application retry with exponential backoff and full jitter | Fail fast, retry cheaply. A 2 s wait should never consume the request budget. |
| 5 | Evaluate `READ COMMITTED` in place of `REPEATABLE READ` **for this path only** | Under RR, InnoDB takes gap and next-key locks on range predicates, widening the footprint beyond the target row. **Verify first** that nothing in this transaction depends on repeatable reads. |
| 6 | Confirm the update resolves via the primary key; audit neighbouring queries for range predicates on non-unique indexes | A range scan under RR gap-locks rows the statement never touches |

> **Explicitly not recommended:** `READ UNCOMMITTED` (dirty reads of balances are
> unacceptable in a ledger) and `SERIALIZABLE` (worsens this). Raising the connection
> pool also worsens it — more concurrent writers on one row lengthens the queue.
>
> **Verification:** `innodb_row_lock_waits`, `innodb_row_lock_time_avg`,
> `performance_schema.data_lock_waits` blocking chains, deadlock count, Span 5 p99.
> **Exit criterion:** Span 5 p99 < 50 ms at simulated load, zero lock timeouts.

---

## Q16. Cognitive Prompt Critiques: Halting the Context Contraction in Refinement Cycles

**1. Architectural flaws in the conversation**

The developer is **debugging by complaint**. Requirements arrive serially — nesting
and ISO timestamps in turn 2, multiline in turn 3 — so every answer was optimal for a
specification already obsolete. No failing input, no expected output: "still throwing
errors" carries almost no discriminative signal.

Context degrades because the window fills with **superseded wrong answers**. The
model attends to its own prior output and anchors on the approach it already chose,
patching a brace-counting regex instead of abandoning it. Attention budget is spent
re-reading three dead patterns.

The decisive failure is that nobody re-examined the premise: **balanced nesting is
not a regular language.** The conversation iterates inside an impossible problem
class, and refinement cannot escape it — each turn presupposes the approach is sound.

**2. Restructured single-shot CoT + few-shot prompt**

````text
# ROLE
You are a parsing specialist. You choose the correct *class* of solution before
writing any pattern, and you say so plainly when a regular expression is the
wrong tool.

# TASK
Extract complete JSON objects embedded in unstructured application log text.

# INPUT CHARACTERISTICS (complete - nothing further will be revealed)
1. Every line begins with an ISO 8601 timestamp, e.g. 2026-03-14T08:22:11.482Z
2. A JSON payload may start mid-line, after arbitrary prefix text
3. Payloads are arbitrarily nested - objects inside arrays inside objects
4. A payload may span many lines, with arbitrary indentation
5. String values may contain escaped quotes (\") and literal braces ({ })
6. Multiple independent payloads may appear in one file
7. Some payloads are truncated by log rotation and are structurally invalid
8. Files reach 2 GB: the solution must stream and must not backtrack
   catastrophically

# REASONING PROCEDURE - work in order, show each step
Step 1. CLASSIFY THE PROBLEM. State whether this is matchable by a true regular
  expression, justified from the formal language class of the input - not from
  experience.
Step 2. IF IT IS NOT REGULAR, SAY SO EXPLICITLY, then choose between:
  (a) a recursive-capable engine - PCRE (?R), .NET balancing groups
  (b) a bracket-depth scanner that is string- and escape-aware
  State the trade-off: (a) is a one-liner but engine-specific and can backtrack
  badly; (b) is longer but linear-time, streamable and portable.
Step 3. HANDLE THE STRING-LITERAL PROBLEM. Show why depth counting must ignore
  braces inside string literals, how you track in-string state and backslash
  escapes, and give the input that breaks a naive counter.
Step 4. IMPLEMENT the approach chosen in Step 2 for a 2 GB streaming input.
Step 5. STATE COMPLEXITY - time and memory - and name the input that would cause
  catastrophic backtracking in the alternative you rejected.
Step 6. PROVE IT on all four examples below, showing extracted output for each.
  If your solution fails any, return to Step 2 and choose differently.

# FEW-SHOT EXAMPLES - your solution must satisfy all four

Example 1 - single line, nested
  IN : 2026-03-14T08:22:11.482Z INFO req={"id":7,"tags":["a","b"],"m":{"k":1}}
  OUT: {"id":7,"tags":["a","b"],"m":{"k":1}}

Example 2 - multiline, indented, timestamps interleaved INSIDE the payload
  IN : 2026-03-14T08:22:12.001Z DEBUG payload=
       2026-03-14T08:22:12.002Z   {
       2026-03-14T08:22:12.003Z     "outer": { "inner": [ { "x": 1 } ] }
       2026-03-14T08:22:12.004Z   }
  OUT: {"outer":{"inner":[{"x":1}]}}

Example 3 - the case a naive brace counter gets wrong
  IN : 2026-03-14T08:22:13.100Z WARN {"msg":"unbalanced { brace","ok":true}
  OUT: {"msg":"unbalanced { brace","ok":true}
  NOTE: the brace inside the string literal must not increment depth

Example 4 - truncated by rotation
  IN : 2026-03-14T08:22:14.900Z ERROR {"id":9,"trace":["a",
  OUT: (nothing emitted; reported as incomplete at EOF, not as a match)

# OUTPUT FORMAT
  1. Step 1-6 reasoning, labelled
  2. the implementation, commented at each non-obvious decision
  3. a results table: example | extracted | matches expected (yes/no)
  4. a LIMITATIONS section naming at least two inputs it does not handle

# CONSTRAINTS
Do not emit a pattern before completing Step 2. If the honest answer is "a regular
expression cannot do this", say it and give the correct alternative. Do not produce
a regex that works on the examples and fails at depth 4.
````

It converges in one turn because every constraint is stated up front, Step 1 forces
the model to confront the formal limit before committing, the four examples act as
executable acceptance criteria, and the mandatory LIMITATIONS section removes the
incentive to overclaim.

---

## Q17. Quality Engineering Blueprint: Critical Infrastructure Data Flow Distortions

**1. Resource allocation**

Weighted by **expected loss**, not by tier popularity. For PHI, a breach is
existentially expensive and a silent data-integrity defect is a patient-safety event;
a visual glitch is neither — but it is not nothing, because a misrendered dosage
figure is itself a safety defect.

| Tier | Share | Justification |
|---|---|---|
| Application Security | **25%** | HIPAA exposure dominates the risk register: authz-per-record, encryption in transit and at rest, audit-log completeness, PHI leakage in logs and error bodies, token scope |
| Consumer-Driven Contract | **20%** | Wearable firmware × app × API versions is the highest-churn surface, and the one place no single team can test alone |
| Unit | **20%** | Cheapest detection, and the only practical place to exhaustively cover clinical calculations — unit conversion, threshold logic, timezone and DST on device timestamps |
| Load & Soak | **15%** | Concurrency spikes are stated in the brief; also the only tier that finds the resource-exhaustion class from Q5 and Q8 |
| API Functional | **15%** | Integration correctness and negative paths — deliberately thinner because contract plus unit already cover much of it |
| Multi-Modal Visual Regression | **5%** | Lowest marginal value, retained non-zero for critical clinician views only |

**2. Non-overlapping operational roles**

Each tier owns one property class; where two could cover something, the cheaper one
owns it and the costlier is forbidden from duplicating it.

| Tier | Owns | Answers |
|---|---|---|
| Unit | logic correctness in isolation | is the transformation right for every input class, including boundaries? |
| App Security | confidentiality and authorisation | can any actor reach data they are not entitled to, and is every access provably logged? |
| Contract | inter-party compatibility | will this deploy break a producer or consumer we do not control? |
| API Functional | integration and orchestration | wired together with real I/O, is the end-to-end effect correct? |
| Visual Regression | presentation fidelity | is the correct value legibly and unambiguously rendered to a clinician? |
| Load & Soak | behaviour under time and pressure | do correctness and durability survive concurrency, duration and partial failure? |

| Goal | Ownership |
|---|---|
| **Data consistency** | Unit proves the transform; Contract proves the schema agrees across boundaries; Load proves consistency holds *under concurrency*, where it actually fails. Ingestion must be idempotent per `(device_id, sample_timestamp)`, asserted under duplicate delivery. |
| **System durability** | Soak owns retention across restarts, backpressure and queue drain; Security owns immutability and completeness of the audit trail |
| **Performance under spikes** | Load owns it exclusively — SLOs on ingestion lag p99, dropped-sample count (target zero) and error-budget burn, never on average response time |

---

## Q18. OpenAPI Specification Boundary Exploitation & Semantic Attack Topographies

**1. Vectors the mutation agent must generate**

The headline finding: **`NestedMetaTag` is recursively self-referential through
`childTag` with no depth or size limit.** A payload nested 10,000 levels deep
overflows the stack in most recursive validators — a single-request denial of
service available to any authenticated caller. With `additionalProperties: $ref`,
key names are also unconstrained, so the same field permits key-count explosion and
prototype pollution.

Two spec defects worth reporting independently of any test result: `accountPasscode`
transmits a credential with no `format: password` or `writeOnly: true`, so any
request-logging middleware will persist it; and its `maxLength: 8` is redundant with
the pattern, suggesting the pattern was not the author's intent.

| Field | Vectors |
|---|---|
| `metadataPayload` | depth 1 / 20 / 1,000 / 10,000 / 100,000; 10,000 sibling keys at depth 2; `__proto__`, `constructor`, `prototype` as keys; 1 MB key names; the `$ref` cycle as a JSON Pointer loop |
| `X-Idempotency-Key` | `format: uuid` is **annotation-only** in most validators — send `abc`, empty, 10,000 chars, trailing whitespace, CRLF (`%0d%0a`) for header injection, and the real semantic test: **same key, different body**, which must be 409 rather than a silent replay |
| `targetRegion` | value outside the enum; case variants (`US-EAST-1`); parameter pollution `?targetRegion=us-east-1&targetRegion=ap-south-1`; `targetRegion[]=`; empty; null; 8 KB value |
| `tenantId` | 999 / 1000 / 999999 / 1000000; `-1`; `0`; `"1000"`; `1000.0`; `1.0e3`; `9223372036854775808` (int64 overflow); `NaN`; `null`; `[1000]` |
| `transactionAmount` | `0.009` / `0.01` / `50000.00` / `50000.01`; `-0.01`; `1e-7`; `1e+308`; `Infinity`; `NaN`; `50000.000000001`; `0.1+0.2` artefacts; `"100"`; a value in range at `binary64` but out of range as a decimal |
| `accountPasscode` | `"AAAA\n"` — in Python's `re`, `$` matches before a trailing newline, so this passes in a Python backend and fails in a Node one; also `"AAAA\nDROP TABLE"`, unicode look-alikes (`Α` U+0391 for `A`), 3- and 9-char values, lowercase, empty |
| Structural | `metadataPayload` omitted (it is required); unknown top-level key (must be rejected); duplicate JSON keys; `Content-Type: application/xml` with a JSON body; XXE / YAML-anchor payloads; 100 MB body; `Content-Length` mismatch; chunked-encoding smuggling |

**2. Required validations and assertion parameters**

| Control | Specification |
|---|---|
| **Depth limit** | reject pre-parse at depth > 20, in parser configuration so it applies to every endpoint — the only mitigation for the recursive `$ref` |
| Size limits | body 256 KB · 100 keys/object · 1,000 array elements · 128-char keys, all pre-deserialisation |
| No type coercion | `"1000"` and `1.0e3` are 400 for an `integer` field; assert the exact error code, not merely non-2xx |
| Format validation | explicitly enable `format` assertion so `uuid` is enforced; do not assume the framework does |
| Money is decimal | parse as `Decimal`, never `float`; assert `0.01` and `50000.00` accepted, `0.009` and `50000.01` rejected, boundaries documented as inclusive |
| Anchored regex | `\A…\z` semantics (`re.fullmatch`, Java `matches`) so `"AAAA\n"` is rejected in every runtime; add an explicit trailing-newline test |
| Parameter pollution | define and assert first-wins or last-wins, or 400 on duplicates — never leave it to framework defaults, which differ |
| Idempotency semantics | same key + identical body → replay the original response; same key + different body → **409**. Assert both; the second is usually unimplemented. |
| Prototype-pollution guard | reject `__proto__`, `constructor`, `prototype` as keys at the parse boundary |
| **Invariants for every vector** | status is 4xx and **never 5xx**; response under 500 ms (a timeout is a DoS signal); no stack trace, SQL fragment, path or library version in the body; RSS and open FDs return to baseline; no partial write — query the ledger to confirm |
| Contract conformance | `schemathesis --checks all` against the live spec; "response not documented in the spec" is a failure, and any 5xx during fuzzing is a P1 regardless of input validity |

The organising assertion: **a malformed request must produce a documented 4xx, in
bounded time, with no state change and no internal detail leaked.**

---

## Q19. Automated Quality Release Sign-Off Gates

*(Compulsory; carries no marks.)*

**1. Architecture and rules engine**

Five stages, with one rule that makes the whole thing trustworthy: **the gate is
deterministic, and no LLM holds a veto.** An LLM may summarise the decision and draft
the rollback narrative; it never computes the verdict, because a non-deterministic
sign-off is not a sign-off — and Q4's cascading drift is exactly what happens when
generated judgement enters the gate.

| Stage | Function |
|---|---|
| Collectors | pull-based adapters per source, each emitting `{metric, value, confidence, collected_at, source_sha}`. A missing or stale collector is `UNKNOWN`, never `PASS`. |
| Evidence store | append-only, keyed by release SHA — a decision you cannot reconstruct months later is not a sign-off |
| Rules engine | versioned declarative policy (OPA/Rego) held in the repo and reviewed like code |
| Decision | `GO`, `GO WITH CANARY`, or `NO-GO`, each emitted with the evidence that produced it |
| Actuator | triggers progressive rollout, watches SLO burn, auto-rolls back on breach |

**Hard gates** (absolute, non-scoreable, any one fails the release): critical or high
CVE with a fix available · any P1 open in release scope · contract test failure ·
security test failure · **coverage on changed lines below 80%** · migration without a
tested rollback.

**2. Ingesting, weighting and correlating**

Raw metrics are not comparable, so each is normalised to a 0–1 risk contribution and
weighted by demonstrated correlation with past incidents — recalibrated quarterly
against the actual incident record, so weights are empirical rather than negotiated
in a meeting.

| Signal | Weight | Normalisation | Why this shape |
|---|---|---|---|
| Coverage on **changed** lines | 0.20 | < 80% hard fail; 80–95% linear | absolute coverage is gameable and mostly measures codebase age; diff coverage measures *this* change |
| Integration pass **history** | 0.25 | pass rate over the last 20 runs, flaky tests quarantined and counted separately | one green run proves nothing; a suite at 15% flake is not evidence. Quarantine count is itself a gate. |
| Container vulnerabilities | 0.20 | critical/high with a fix → hard fail; medium weighted by reachability | an unreachable CVE in a dev dependency is not a blocker, and treating it as one trains people to bypass the gate |
| Open defect severity | 0.20 | P1 in scope → hard fail; weighted sum of P2/P3 against a threshold | scope-aware, so unrelated backlog does not block delivery |
| Canary SLO burn | 0.15 | error-budget consumption in the canary window | the only signal from production, and therefore the highest-value one |

**Correlation is what makes it more than a checklist:**

| Conjunction | Decision |
|---|---|
| low diff coverage **and** a diff touching a historically incident-prone module | `NO-GO`, even though each signal alone would pass |
| high weighted risk **and** a clean canary | `GO WITH CANARY` at 1% for 30 minutes, rather than a blunt block |
| **any `UNKNOWN` input** | `NO-GO` — absence of evidence is never evidence of safety; this is the rule that stops a broken collector silently approving everything |

---

## Q20. Closed-Loop Observability: Adaptive Production-Driven Stress Testing

**1. Linking production signals back to pre-deployment suites**

The link is a **shared identifier discipline** established at build time, not
inferred later. Every artifact carries a `release_sha`; every span carries
`release_sha`, `route` and `service`; every test declares the routes and symbols it
covers, from its coverage report. Those three facts make the join work in both
directions.

The highest-value direction is production → test: an error signature maps to an
owning route, which maps to the tests covering it. **If that set is empty, the
incident is automatically filed as a coverage gap** with the failing trace attached —
the best test-backlog source a team has.

| Direction | Mechanism |
|---|---|
| Production → test | normalised stack hash → owning route → tests whose coverage intersects it; empty set files a coverage gap |
| Incident → regression test | replay the recorded request, headers and payload from the failing trace as a generated case, pinned to the signature. A fix is not accepted until its test fails on the pre-fix commit. |
| Traffic → load profile | route mix, payload-size distribution, concurrency percentiles and think-time exported weekly as a versioned `traffic-profile.json` the load suite consumes directly — the difference between a load test and a number |

**2. Technical setup for adaptive, production-driven testing**

```
OTel Collector ──> metrics/traces store ──> Risk Scoring Service
                                                   │
                          ┌────────────────────────┼────────────────────────┐
                          v                        v                        v
                   CI Test Orderer         Runner Autoscaler        Chaos Scheduler
                          │                        │                        │
                          └────────> canary fleet <┘ ──> SLO watchdog ──> rollback

risk = traffic_share × error_rate_delta × latency_p99_regression × change_frequency
```

| Component | Behaviour |
|---|---|
| Risk Scoring Service | publishes the per-route score above as a ranked artifact, so prioritisation, scaling and chaos all agree on what matters today |
| CI test orderer | sorts and shards by descending risk so the highest-signal tests report first; low-risk tests move to a nightly tier rather than being deleted |
| Runner autoscaler | provisions executors proportional to risk-weighted suite size — a hot-path change gets wide parallelism, a docs change gets one runner |
| Chaos scheduler | injects latency, error rate, pod kill and dependency partition into the **top-N services by live traffic**, during a canary window, against the canary fleet only |
| Guardrails (enforced *outside* the scheduler) | blast radius capped at the canary percentage · hard kill switch · business-hours window initially · automatic abort on SLO burn |
| SLO watchdog | consumes the same telemetry and rolls back on error-budget breach |

This closes the loop: production tells the pipeline what to test, the pipeline tests
it under injected stress, and production decides whether the result was acceptable —
with no human in the latency path and a deterministic rollback when it was not.

---

## Behavioural & Fit Evaluation (Psychological Alignment Profiles)

> **⚠️ ACTION REQUIRED — pick one option per situation and delete the other.**
> These are personal-judgement answers and must reflect your own reasoning. The
> notes below are context for your decision, not a recommendation.

| Situation | Your choice | Context for deciding |
|---|---|---|
| **A** — Undocumented Legacy Crash | `Choice i` / `Choice ii` → **____** | The stated constraint is "4 hours before a major release". Choice ii is the incident-management answer; Choice i is the engineering-quality answer but may not fit the window. Be ready to justify yours against that constraint. |
| **B** — Autonomous AI Agent Alignment | `Choice i` / `Choice ii` → **____** | Relates directly to Q4 and Q10 — ungoverned agent output is the failure mode both describe. |
| **C** — Technical Ambiguity vs Speed | `Choice i` / `Choice ii` → **____** | The question states requirements are "changing daily", which is information about which approach the scenario rewards. |
| **D** — Code-Coverage Metric Divergence | `Choice i` / `Choice ii` → **____** | Relates to Q19 — the argument that diff coverage and mutation score are better gates than absolute statement coverage. |
