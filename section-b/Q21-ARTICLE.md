# Architectural Chaos: Engineering Asynchronous Network Interception and Fault-Injection Frameworks inside Playwright CI/CD Pipelines

*Topic A. ~1,290 words.*

Most fault-injection work in browser automation fails for a reason that has nothing
to do with faults. It fails because the team picks the wrong seam to inject at,
discovers the framework's own overhead is larger than the fault they are studying,
and then compensates with sleeps — at which point the suite is measuring the CI
runner's scheduler rather than the application.

I hit all three while building a WebSocket jitter-injection suite against a canvas
streaming terminal. What follows is what the measurements actually forced, including
two design decisions I got wrong first.

---

## 1. Choosing the seam

Playwright offers four distinct interception points, and they are not
interchangeable. The choice determines which faults are expressible at all.

| Seam | Reaches | Cannot do |
|---|---|---|
| `page.route` | HTTP/fetch/XHR | WebSocket frames; anything below the request layer |
| `page.routeWebSocket` | individual WS frames, both directions | HTTP; TLS-level faults |
| `CDPSession` — `Fetch`, `Network` domains | request bodies, response codes, `Network.emulateNetworkConditions` | per-frame WS control; Chromium only |
| External proxy — mitmproxy, Toxiproxy | TCP, TLS, connection resets, bandwidth shaping | correlating a fault to a specific in-page action |

The instinct is to reach for the proxy because it is the most powerful. That is
usually wrong for CI. A proxy sits outside the browser, so it cannot tell you *which
page action* a corrupted frame arrived during, and it needs certificate
configuration in every runner image. Its power costs you attribution and
reproducibility — both of which matter more in a pipeline than raw capability.

`routeWebSocket` was the correct seam for my case because the fault I needed was
*per-frame latency on a live socket*, and that is the only seam where a frame is a
first-class object:

```javascript
await page.routeWebSocket(/\/stream/, (route) => {
  const upstream = route.connectToServer();
  upstream.onMessage((msg) => {
    const delay = jitter.next();          // 1000ms x fib, clamped at 8000ms
    const mutated = corruptor.apply(msg);  // raw-text mutation, see §4
    releaseOrdered(() => route.send(mutated), delay);
  });
  route.onMessage((m) => upstream.send(m)); // client -> server untouched
});
```

The general rule: **inject at the lowest layer that still lets you attribute the
fault to an action.** Going lower buys capability you will pay for in flakiness.

---

## 2. The ordering problem, which is where naive implementations break

My first release mechanism was one timer per frame:

```javascript
setTimeout(() => route.send(frame), delay);   // wrong
```

This looks correct and is not. With a Fibonacci ladder, frame 4 waits 3,000 ms while
frame 7 — past the ladder's budget and therefore released immediately — arrives
first. The application's sequence guard correctly discarded frame 4 as stale. The
state I was testing *never appeared*, and the suite failed with a timeout that looked
like an application bug.

Real link latency does not reorder like that. It queues. The fix was a single line of
arithmetic:

```javascript
const releaseAt = Math.max(now, queueTail) + delay;
queueTail = releaseAt;
```

That preserves order while still deferring state, which is what the fault was
supposed to model.

The broader lesson is the one worth carrying: **a fault injector is a simulation, and
an unfaithful simulation produces failures that belong to the harness.** I then kept
the unordered mode deliberately, behind `preserveOrder: false`, as a *separate* test
asserting the application defends its sequence cursor. Two faults, two tests, each
with a clear expected outcome — instead of one test with two faults and an ambiguous
one.

---

## 3. The trade-off nobody mentions: your framework's overhead is part of the fault

The spec I was working to required a chained interaction — hover, 15 px drag, click —
to complete within 30–100 ms of a detected state change. I instrumented each phase
before tuning anything, which turned out to be the single highest-value decision in
the project:

```
hover:end          +24ms
barrier            +42ms
drag:end           +69ms   <- down + move(steps:3) + up
barrier            +41ms
click              +7ms
                   -----
                   183ms   against a 100ms ceiling
```

Playwright's `mouse` API consumed 93 ms — 93% of the budget — before any of it bought
correctness. Each call is a round trip with framework bookkeeping I did not need.

Dropping to `Input.dispatchMouseEvent` over a `CDPSession` took the same four events
to ~15 ms. Then a second insight: CDP guarantees in-order processing per session, so
the events do not need individual acks. Dispatching them as one pipelined burst —
`Promise.all` over four sends — collapsed four round trips into one. The drag phase
went from 69 ms to 4–12 ms, and the whole chain landed at **41–76 ms across runs**.

The trade-off is real and worth stating: raw CDP gives up Playwright's actionability
checks, auto-waiting and cross-browser support. For a canvas surface with no DOM
nodes, those checks had nothing to act on anyway, so the cost was zero — but on a
normal DOM application, reaching for CDP to save latency would be trading away the
thing that makes Playwright reliable. **Measure first; the answer is
application-specific.**

---

## 4. Corrupting payloads without the serialiser undoing you

Injecting a malformed numeric value looks trivial and has a trap. The intended fault
was scientific notation reaching a UI that does not range-check:

```javascript
frame.balance = 1e7;
route.send(JSON.stringify(frame));   // sends "balance":10000000
```

`JSON.stringify` normalises `1e7` to `10000000`. The fault never reached the wire.
The fix is to treat the frame as text and splice it:

```javascript
raw.replace(/"balance"\s*:\s*[^,}]+/, '"balance":1e+7');
```

The principle generalises to every fault-injection framework: **mutate at the
representation the system under test actually parses.** Parse-then-reserialise
launders exactly the malformations you were trying to introduce — which is why so
many "we tested malformed input" suites test well-formed input.

That vector found a real defect: a guard that rejected `"NaN"` but accepted `1e+7`
and `0.30000000000000004` as ledger balances. Type-checked, not range-checked — the
class of bug a type-only code review passes.

---

## 5. Synchronisation without sleeps, in a pipeline

Fault injection makes timing non-deterministic by design, so it removes the crutch
teams usually lean on. The discipline that replaces it has two halves.

**Read state where state actually lives.** With no DOM, readiness came from
`getImageData` sampling in a `requestAnimationFrame` loop — a state change is a
pixel classification crossing from a loading grey to an active colour. One
measurement mattered here too: a full geometry re-derivation cost ~70 ms, so it could
not run inside a 100 ms budget. It runs once per circuit-breaker attempt, and the
cheap intra-chain probes reuse the cached result. Geometry is at most one attempt
stale, never silently stale.

**Synchronise on presentation, not on a clock.** Between phases the chain waits for
the compositor to present the frame the previous action produced — a double
`requestAnimationFrame` — and re-probes on that frame. This resolves on vsync, and
it does three things a sleep cannot: it absorbs repaint lag, it guarantees the probe
reads a presented frame rather than a queued one, and it detects coordinate drift at
the offsets just used.

It also, conveniently, made the 30 ms *floor* of the window deterministic. At 60 Hz
the barrier costs ~33 ms of genuine vsync time. Padding with `setTimeout(35)` would
have produced the same number and proved nothing.

---

## 6. What this costs in CI, and what to gate on

Three pipeline realities shape the design.

**Shared-core runners have steal time.** My chain has 25–50 ms of headroom inside a
100 ms ceiling, which a GC pause can consume. Retrying the same measurement cannot
help — the detection instant is fixed, so every retry is further from it. The fix was
to make the *scenario* re-runnable: the testbed's feed re-subscribes the target every
two seconds, producing a genuinely fresh state transition to latch onto. The retry
loop then re-runs the whole latch-and-fire cycle rather than re-firing a stale one.
Distinguishing "retry the measurement" from "re-run the scenario" is the difference
between a suite that hides flake and one that tolerates a real machine.

**Headless has no vsync guarantee.** Anything that depends on frame cadence needs a
compositor. Run visual and timing-sensitive gates under `--headless=new` or headed,
and pin the browser build in the runner image.

**Faults must be observable.** Every injected fault is recorded with its intended and
measured effect, and the suite asserts against the *measured* value. My ladder test
does not trust the model's bookkeeping; it measures the wall-clock gaps between
releases and asserts `[999, 1999, 2999, 5001, 8000] ms`. An unverified fault
injector is a source of false confidence — you cannot tell a passing test from a
fault that silently failed to fire.

---

## Closing

Fault injection is not about inventing worse conditions. It is about being able to
state precisely which condition you created, prove it was created, and attribute the
outcome to it. Pick the lowest seam that preserves attribution; model the fault
faithfully enough that reordering artefacts are not mistaken for defects; measure
your harness's overhead before blaming the application; mutate at the layer the
system parses; and synchronise on observable state rather than on a clock.

Do that, and the suite becomes a measuring instrument. Skip any of it, and it becomes
a very elaborate way of testing your CI runner.
