# Q1 — Dynamic HTML5 Canvas State Drifts & Asynchronous Race Interceptions

```bash
npm run q1:test            # 10 tests
HEADED=1 npm run q1:test   # watch it
npm run q1:testbed         # serve the terminal by hand at :4400
```

---

## The target

`testbed/` is a canvas streaming terminal built for this question. A `ws://` feed
emits a tick every 250 ms; the page renders an 18-cell ledger grid, a balance
readout and an exception band **entirely into a `<canvas>`**. There is no button,
no label, no input, no aria node — nothing an LLM's habitual DOM locator can attach
to. Every piece of state is published as pixels, in a fixed palette that is the
application's only contract with the test:

| State | RGB |
|---|---|
| implicit gray loading threshold | `128,128,128` |
| active, tick up | `22,163,74` |
| active, tick down | `220,38,38` |
| chained interaction completed | `168,85,247` |
| grid separator (used to derive geometry) | `27,36,48` |
| exception boundary engaged | `217,131,36` |

Production canvas terminals could not be used: TradingView and its peers wrap their
feeds in proprietary protocols behind anti-bot layers, so the frames cannot be
intercepted or mutated and specs 1 and 4 would be unimplementable. The brief permits
a local testbed for exactly this reason.

---

## Spec 1 — WebSocket stream corruption & jitter

`lib/ws-interceptor.js` puts the harness in the middle of the live connection with
`page.routeWebSocket`. Server frames arrive there first and reach the application
only when the interceptor forwards them.

`lib/fibonacci-jitter.js` supplies the delay for each frame: `1000ms × fib`, clamped
at `8000ms` → `1000, 1000, 2000, 3000, 5000, 8000, 8000, …`.

**Release ordering.** Frames are released at `max(now, tailOfQueue) + delay`, which
models real link latency: the ladder genuinely defers the application's state
transition without reordering the stream. Naive per-frame timers would let a 0 ms
frame overtake an 8000 ms frame, the app's sequence guard would discard the older
one, and the state under test would never arrive — a self-inflicted flake dressed up
as a finding.

`preserveOrder: false` is the deliberate opposite, used by one test to prove the
app defends its sequence cursor.

**Why the ladder is budgeted.** At a 250 ms tick, holding every frame for up to 8 s
would build an unbounded backlog. The ladder is applied to the first 6 frames — the
full climb, 20 s of cumulative injected latency — then falls through. The cap itself
is asserted separately in a pure unit test over 10 rungs, where four exceed the
ceiling and clamp.

> `Q1.1b` measures the gaps **on the wire**, not in the model's own bookkeeping:
> `[999, 1999, 2999, 5001, 8000] ms`.

---

## Spec 2 — The Anti-AI constraint

Banned: static delays, visibility fluent polls, bounding-box checks. See the root
`README.md` for the greppable audit of each. What replaces them:

### Coordinate calculation engine (`deriveGrid`)

The grid's geometry is **measured from the rendered frame**, never read from the
application:

- **Pass A** — for each scanline `y`, count pixels matching the separator RGB across
  the full width. Horizontal separators spike; cluster the spikes into row boundaries.
- **Pass B** — within that `y` range, count separator pixels down each column `x`.
  Vertical separators spike; cluster into column boundaries.
- Cell rects come from consecutive boundary pairs. Each cell gets a **probe point** at
  `y + 0.28h` — clear of the price text at the bottom, the drag handle above it, and
  the 3 px hover stroke at the edges.

`Q1.2` asserts a 6×3 grid with boundaries `[39.5, 175.5, 311.5, 447.5, 583.5, 719.5,
855.5]` and a column-pitch spread `≤ 2px` — evenness is what proves the scan found
real separators rather than noise.

### State latch (`watchCellTransition`)

A `requestAnimationFrame` loop samples a 5×5 patch at the probe point every frame and
classifies it against the palette (per-channel tolerance 14). It first establishes that
the cell *is* at the gray loading threshold, then resolves on the first frame where it
reads an active colour. `Q1.3` latches `loading → down` after **420 rAF probes** /
6991 ms — the ladder deferred it, and the latch tracked it frame by frame.

### Geometry cache layering

A full derivation is two whole-surface `getImageData` passes (~70 ms) — far too
expensive to repeat between the phases of a chained action. So the breaker's
recalibrate hook refreshes the cache once per attempt, and the cheap intra-chain
barriers reuse it: a 5×5 patch read instead of a 468k-pixel scan. Geometry is always
at most one attempt stale, never silently stale across a recalibration.

---

## Spec 3 — The race injection trap

`lib/race-chain.js` fires Hover → Drag 15 px X → Click so the chain completes inside
the 30–100 ms window that opens when the latch fires.

### Two measurements that forced the design

Both were found by instrumenting, not by guessing:

**`page.mouse` is too slow.** A hover cost ~24 ms and a
`down / move(steps:3) / up` drag cost ~69 ms — 93 ms of a 100 ms budget spent on
framework overhead. Replaced with `Input.dispatchMouseEvent` over a `CDPSession`
(~3–5 ms per event; the brief names CDP sessions for exactly this).

**Awaiting each ack is waste.** CDP guarantees in-order processing on a single
session, so hover and drag are dispatched as **one pipelined burst** of four events.
The application still sees four ordered events and still refuses to arm unless hover
precedes the drag; the wire cost drops from four round trips to one. That is what
makes the series genuinely *ultra-rapid* rather than merely sequential.

**Result:** first action at +7–18 ms, chain complete at **41–76 ms** across runs.

### State drift, and why the test has cycles

The chain has ~25–50 ms of headroom inside the 100 ms ceiling, so a scheduler hiccup
or a GC pause can push one cycle over it. Retrying against the *same* latch cannot
help — that instant is fixed, so every further attempt is further from it.

What does help is the terminal's own **state drift**, which is what the question is
named after. The feed re-subscribes the target cell every 2 s: the cell drops back to
the gray loading threshold and any interaction state attached to it is discarded, so
a cell that was armed is no longer armed. That yields a genuinely fresh gray → active
transition to latch onto and fire against.

`Q1.3 race trap` therefore runs up to three latch-and-fire cycles and breaks on the
first that lands inside the window, reporting every cycle's timing. In practice
cycle 1 succeeds; the loop is insurance against a real machine, not a workaround for
a broken measurement. `Q1.3 state drift` proves the mechanism independently —
`active → loading → active`, with `phase` reset to `idle` and `marks` cleared — so
the retry path is exercised rather than assumed.

### Hitting the 30 ms floor without a static delay

With CDP dispatch the chain would *undershoot*. Padding it with a sleep is forbidden
and is the wrong fix anyway. Instead, after the drag the chain waits for the
compositor to present the frame that drag produced (double `requestAnimationFrame`)
and re-probes on that presented frame. At 60 Hz that barrier costs ~33 ms of real
vsync time — so the chain lands in the window deterministically, while doing three
things the spec actually asks for:

- **repaint lag** — resolves on vsync, so the click is aimed at a frame that has been
  presented, not one still queued for paint
- **stale frames** — the probe reads the presented frame, not a queued one
- **coordinate deviation** — re-reads the cell's pixels at the offsets just used; a
  fallback to the loading class aborts the attempt

### Circuit breaker (`lib/circuit-breaker.js`)

Each attempt is `recalibrate → act → verify`, with states `closed → half-open → open`.

- **attempt 1** uses the geometry the latch shipped with its result — derived from the
  very frame the transition was observed on, and free of round trips
- **any retry** forces a full pixel re-scan, because a rejection means the offsets just
  acted on can no longer be trusted
- **backoff is work, not waiting** — the recalibration *is* the delay, and it is what
  the next attempt needs anyway

The breaker deliberately does **not** retry on a window overshoot. The latch instant is
fixed, so every further attempt is further from it; retrying would guarantee four
failures instead of surfacing one. The window is asserted once, by the spec, against the
measured value. Retries are reserved for failures a recalibration can actually fix.

### Interaction ordering is enforced by the application

The terminal arms the target cell only if: hover set phase `hovered`, a drag of
`≥ 12px` on X followed, and then a **separate** click arrived. The `mouseup` that ends
a drag synthesises a click event, which the app suppresses — so a lone drag cannot arm
it. `Q1.3` asserts `marks.hovered < marks.dragged < marks.armed`, which means the chain
cannot be faked by a single click landing in the right place.

---

## Spec 4 — Mismatched server boundary checking

`lib/payload-corruptor.js` rewrites the intercepted frame **as raw text** rather than
parse → edit → re-serialise. That distinction is load-bearing: `JSON.stringify(1e7)`
collapses to `10000000`, so re-serialising would never put scientific notation on the
wire. Splicing the string keeps the literal `1e+7` in the frame exactly as a
misbehaving upstream service would emit it.

Three vectors, including a control:

| Vector | Wire value | Expected |
|---|---|---|
| `NON_NUMERIC` | `"balance":"NaN"` | **rejected** — control; proves a boundary exists |
| `SCIENTIFIC` | `"balance":1e+7` | magnitude bypass |
| `FRACTIONAL` | `"balance":0.30000000000000004` | precision bypass |

The verdict is read from the pixels: `countColour()` scans the whole surface for the
amber exception RGB and reports hit count and bounding box, so the test asks *"has the
exception band appeared anywhere?"* without hardcoding where it is drawn. The app's
numeric state is read afterwards only to corroborate what value it accepted.

### Finding (2 × CRITICAL)

The guard rejects non-numeric input (`"NaN"` → `E_NON_NUMERIC`, amber band engages) but
applies no magnitude ceiling and no precision rule. `1e+7` renders `10000000` as
legitimate ledger state; `0.30000000000000004` renders a binary float artefact into a
currency field. Both pass with no boundary engagement.

The precise finding is not "there is no validation" — it is that the guard
**type-checks but does not range-check**, which is the failure mode a type-only review
would pass. Written to `artifacts/q1-boundary-findings.json` on every run.

The bypass tests assert the **detection**, not the defect, so the suite stays green
while the findings stay loud. `Q1.4 summary` fails if a bypass ever stops being
reported.
