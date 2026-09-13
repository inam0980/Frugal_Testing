# Section A — Practical Anti-AI Engineering & Automation

Frugal Testing / BuildNexTech — AI-Native Software Engineer Intern

**Stack:** Node.js + Playwright (`@playwright/test`), Express, `ws`, Node `crypto`.
One toolchain covers all three questions: the same runtime hosts the canvas
testbed's WebSocket feed, the Q2 HMAC gateway, and the test suites that attack them.

---

## Quick start

```bash
npm install
npx playwright install chromium

npm test                      # all three questions, 19 tests
npm run q1:test               # Q1 only
npm run q2:test               # Q2 only
npm run q3:test               # Q3 only

HEADED=1 npx playwright test  # watch the canvas drift and the chained action
npm run report                # open the HTML report
```

Both local servers start automatically via Playwright's `webServer` config
(`:4400` canvas testbed, `:4500` HMAC gateway). To drive them by hand:

```bash
npm run q1:testbed            # http://localhost:4400
npm run q2:server             # http://localhost:4500
```

---

## Layout

```
q1-canvas-race/
  testbed/server.js              Express + ws feed, 250ms tick
  testbed/public/index.html      canvas-only terminal (no DOM widgets at all)
  lib/fibonacci-jitter.js        1000ms x fib ladder, clamped at 8000ms
  lib/ws-interceptor.js          routeWebSocket hook + ordered release queue
  lib/payload-corruptor.js       raw-text mutation of the balance field
  lib/pixel-engine.js            geometry-from-pixels + rAF state latch
  lib/circuit-breaker.js         recalibrate / act / verify, closed-half-open-open
  lib/race-chain.js              CDP-dispatched Hover -> Drag15px -> Click
  tests/canvas-race.spec.js      10 tests

q2-replay-hmac/
  server/mock-gateway.js         challenge nonces, HMAC-SHA512, replay ledger
  lib/mac-signer.js              wall-clock-anchored microsecond clock + signer
  tests/replay-hmac.spec.js      5 tests

q3-shadow-dom/
  testbed/sealed-portal.html     open -> CLOSED -> open roots, churning class/id
  lib/shadow-piercer.js          attachShadow capture + AX-tree pathfinding
  tests/shadow-pathfinding.spec.js  4 tests
  COT-SYSTEM-PROMPT.md           the prompt-architecture deliverable
  README.md                      the piercing-strategy write-up

artifacts/                       findings JSON written by the suites
```

---

## Compliance matrix

### Q1 — Dynamic HTML5 Canvas State Drifts & Asynchronous Race Interceptions

| Requirement | Where | Evidence in the run |
|---|---|---|
| Hook the live browser connection via the framework's network proxy | `lib/ws-interceptor.js` — `page.routeWebSocket` | 3 roots of the connection proxied; client→server passed through untouched |
| Inject `1000ms x Fibonacci`, capped at 8000ms | `lib/fibonacci-jitter.js` | `Q1.1a` asserts `[1000,1000,2000,3000,5000,8000,8000,...]` with 4 clamped rungs; `Q1.1b` measures the gaps **on the wire** at `[999,1999,2999,5001,8000]ms` |
| No static delays, no visibility polls, no bounding-box readiness | `lib/pixel-engine.js` | see *Anti-AI constraint* below |
| Custom coordinate calculation engine over pixel-colour variation | `deriveGrid()` | `Q1.2` recovers a 6×3 grid with boundaries `[39.5, 175.5, … 855.5]` from separator-RGB runs alone |
| `requestAnimationFrame` execution loop | `watchCellTransition()` | `Q1.3` latches `loading → down` after **420 rAF probes** / 6991ms |
| Gray loading threshold → active element colour | palette contract | `rgb(128,128,128)` → `rgb(22,163,74)` / `rgb(220,38,38)` |
| Chained actions Hover → Drag 15px X → Click | `lib/race-chain.js` | app refuses to arm unless hover precedes a ≥12px drag precedes a separate click; `marks` ordering asserted |
| Fired within 30–100ms of the pixel validation change | `lib/race-chain.js` | measured 41–76ms across runs; window asserted in the spec |
| Circuit-breaker macro that dynamically updates target grid offsets | `lib/circuit-breaker.js` | attempt 1 uses latch-seeded geometry; any retry forces a full pixel re-scan |
| Handle coordinate deviations / stale frames / repaint lag | compositor barrier + sequence guard | `Q1.3 resilience` reorders the stream and asserts the app drops stale frames while the latch survives |
| **State drifts** (the question's title) | feed `resubscribe` cycle | `Q1.3 state drift` asserts `active → loading → active` and that a drift discards the armed interaction state |
| Inject corrupted maths (`1e+7`, fractional) back through the stream | `lib/payload-corruptor.js` | raw-text splice, so `1e+7` reaches the wire literally |
| Assert structured exception boundary vs silent corruption | `Q1.4` ×4 | boundary **exists** (rejects `"NaN"`) but **is incomplete** — 2 CRITICAL findings |

### Q2 — Cryptographic Replay Testing, Stateful Nonces & Hash-Chain API Chaining

| Requirement | Where | Evidence |
|---|---|---|
| Local gateway exposing nonces / HMAC / replay protection | `server/mock-gateway.js` | Restful-Booker exposes none of these, so the mechanisms are built |
| POST to mint a transaction; **extract the id from the response header** | `mintTransaction()` | `X-Transaction-Id`, `X-Challenge-Token`, `X-Server-Timestamp` |
| Parse challenge token + variable server timestamp from the previous step | `Q2.2` | both fed into the digest |
| `X-Frugal-Mac` = HMAC-SHA512 over body + microsecond timestamp + salt | `lib/mac-signer.js` | 128 hex chars asserted; clock is wall-clock-anchored hrtime |
| Replay the identical packet within 150ms | `Q2.3` | dispatched at +0–3ms; deadline asserted |
| Assert 409 / 422 | `Q2.3` | `409 E_REPLAY_DETECTED`, `replaysLeaked: 0` |
| On a duplicated success, raise a high-risk alert in the logs | `raiseVulnerabilityAlert()` | `Q2.4` runs a gateway with `Q2_REPLAY_GUARD=off`, gets `200` + `version: 2`, and emits the HIGH-RISK banner |

### Q3 — Sealed Closed-Boundary Shadow DOM Pathfinding & Accessibility Tree Refactoring

| Requirement | Where | Evidence |
|---|---|---|
| Resilient strategy for deeply nested shadow structures | `lib/shadow-piercer.js`, `q3-shadow-dom/README.md` | `attachShadow` capture, installed before `customElements.define` |
| Specifically where obfuscated class strings regenerate every reload | `testbed/sealed-portal.html` | classes **and** ids rotate on load *and* every 1.5s |
| CoT system prompt restricted to the OS accessibility tree | `COT-SYSTEM-PROMPT.md` | 7-stage procedure, AX-only input contract, schema that cannot express a selector |
| Forbid ids, absolute XPath, text matching, CSS tags | same | prohibited by construction (the model never receives markup), not merely by instruction |

---

## The Anti-AI constraint, defended explicitly

The brief bans three specific things. Each ban is honoured, and each has a
replacement that does more work than the thing it replaces:

These claims are greppable; the exact counts are given so they can be checked
rather than taken on trust.

**No static delays.** Zero `waitForTimeout`, zero `sleep`, and no timer used as a
synchronisation primitive. The suite contains exactly **one** `setTimeout`
(`ws-interceptor.js:77`) and it *is* the latency being injected — the requirement,
not a workaround for it; nothing waits on it. The two `setInterval` calls in the
tree belong to the *applications under test*, not the suite: the 250ms tick of the
Q1 feed (`testbed/server.js:90`) and the 1.5s obfuscation churn of the Q3 portal
(`sealed-portal.html:77`).

Synchronisation is instead **frame-synchronised**: the chain waits for the
compositor to present the frame its previous action produced (double
`requestAnimationFrame`) and re-probes on that presented frame. That resolves on
vsync rather than on a clock, which is also how the 30ms floor of the action window
is met deterministically without padding — see the header comment in
`lib/race-chain.js`.

**No visibility fluent polls.** Zero `waitForSelector`, `toBeVisible`,
`locator.waitFor`, or `expect(locator)` assertion of any kind. Q1 uses four
`expect.poll` calls, and none of them polls rendered visibility:

- two poll *the harness's own Node-side bookkeeping* — frames the interceptor has
  released, and whether the corruptor has fired;
- one (`awaitDerivableGrid`) polls the page, but what it polls is `deriveGrid()` —
  a separator-RGB scan of the canvas returning `ok` once the geometry resolves.
  That is a pixel-domain measurement, not a visibility query;
- one polls the application's own stale-frame counter in the reordering test.
  Deliberately the *receiver's* counter rather than the interceptor's: the sender
  increments the instant it calls `route.send()`, so asserting off it races the
  page and fails under load. Still frame bookkeeping, not rendered state.

Page state is read exclusively through `getImageData`.

**No bounding-box checks.** `getBoundingClientRect` appears twice in the tree, and
only one of those is the suite: `pixel-engine.js:338` (`viewportTransform()`), used
solely as the affine canvas-space → viewport-space transform needed to address the
mouse. It is never consulted to decide whether anything is ready, present, or
settled, and the circuit breaker re-reads it on every attempt so a scroll or resize
cannot desynchronise the mapping. The second occurrence
(`testbed/public/index.html:183`) is the *application's* own pointer handling —
the code under test, not the code testing it. Readiness is always a pixel
classification.

**No DOM locators for state.** The Q1 testbed has no button, label, input, or aria
node — the canvas is the entire application surface. `document.querySelector('canvas')`
is the only DOM query in the Q1 path, and it exists to obtain the drawing context.

---

## Findings the suite produced

Both are written to `artifacts/` as JSON on every run.

**Q1 — incomplete client-side exception boundary (2 × CRITICAL).**
The terminal's balance guard rejects non-numeric input (`"NaN"` → `E_NON_NUMERIC`,
amber band engages) but applies no magnitude ceiling and no precision rule. Injecting
`"balance":1e+7` renders `10000000` as legitimate ledger state, and
`"balance":0.30000000000000004` renders a binary float artefact into a currency
field. Both pass silently with no boundary engagement. The precise finding is not
"there is no validation" — it is that the guard **type-checks but does not
range-check**, which is the failure mode a type-only review would miss.

**Q2 — replay protection is load-bearing (1 × HIGH-RISK, demonstrated).**
With the guard enabled the gateway answers `409` to a byte-identical replay. With
`Q2_REPLAY_GUARD=off` it answers `200` and increments the record to `version: 2` —
the same signed mutation committed twice off one MAC. `Q2.4` runs that second
gateway deliberately to prove the escalation path fires rather than asserting it
would.

---

## Notes on target selection

Both Q1 and Q2 run against purpose-built local testbeds, which the brief explicitly
permits and which is the only way these tests can exist:

- Production canvas terminals (TradingView and similar) wrap their feeds in
  proprietary protocols behind anti-bot layers. The frames cannot be intercepted or
  mutated, so Q1.1 and Q1.4 would be unimplementable against them.
- `restful-booker.herokuapp.com` issues no challenge nonce, verifies no custom MAC
  header, and enforces no replay window. There is nothing there for Q2's assertions
  to bite on.

Building the target is therefore part of the answer, not a shortcut around it: each
testbed is constructed to *have* the failure modes under test, and the Q1 testbed in
particular carries a deliberately incomplete validation guard so that Q1.4 has a
real defect to find rather than a simulated one.
# Frugal_Testing
