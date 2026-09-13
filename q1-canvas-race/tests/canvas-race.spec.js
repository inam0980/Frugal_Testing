/**
 * Q1 - Dynamic HTML5 Canvas State Drifts & Asynchronous Race Interceptions
 * =============================================================================
 * Compliance summary (see ../README.md for the long form):
 *
 *   Q1.1  WebSocket interception + 1000ms x Fibonacci latency ladder, cap 8000ms
 *   Q1.2  No static delay, no visibility poll, no bounding-box readiness check.
 *         Grid geometry is *measured* from separator pixels; state readiness is
 *         latched by a requestAnimationFrame probe of the canvas image data.
 *   Q1.3  Hover -> Drag 15px X -> Click, completed inside the 30-100ms window,
 *         wrapped in a recalibrate/act/verify circuit breaker.
 *   Q1.4  Corrupted mathematical state injected back through the stream, with
 *         assertions on whether a structured exception boundary engages.
 */

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

const { FibonacciJitter } = require('../lib/fibonacci-jitter');
const { PayloadCorruptor, VECTORS } = require('../lib/payload-corruptor');
const { WsInterceptor } = require('../lib/ws-interceptor');
const { CircuitBreaker } = require('../lib/circuit-breaker');
const {
  installPixelEngine,
  deriveGrid,
  probeCell,
  countColour,
  watchCellTransition,
  PALETTE,
} = require('../lib/pixel-engine');
const { fireRaceChain, presentedProbe, WINDOW_FLOOR_MS, WINDOW_CEILING_MS } = require('../lib/race-chain');

const TERMINAL_URL = 'http://127.0.0.1:4400/';
const TARGET_CELL = 7;
const ARTIFACT_DIR = path.resolve(__dirname, '../../artifacts');

const findings = [];

function recordFinding(entry) {
  findings.push({ ...entry, at: new Date().toISOString() });
  const severity = entry.severity.padEnd(8);
  // eslint-disable-next-line no-console
  console.log(`\n  [${severity}] ${entry.title}\n             ${entry.detail}\n`);
}

test.afterAll(() => {
  if (!findings.length) return;
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(ARTIFACT_DIR, 'q1-boundary-findings.json'),
    JSON.stringify({ suite: 'Q1', generatedAt: new Date().toISOString(), findings }, null, 2)
  );
});

/**
 * Install the pixel engine, hook the socket, then navigate. Order matters:
 * both the init script and the WebSocket route must be in place before the
 * application opens its connection.
 */
async function openTerminal(page, { jitterBudget = 0, preserveOrder = true } = {}) {
  const jitter = new FibonacciJitter({ jitterBudget });
  const corruptor = new PayloadCorruptor();
  const interceptor = new WsInterceptor({ jitter, corruptor, preserveOrder });

  await page.addInitScript(installPixelEngine);
  await interceptor.attach(page);
  await page.goto(TERMINAL_URL, { waitUntil: 'domcontentloaded' });

  return { jitter, corruptor, interceptor };
}

/** Block until the renderer has painted a frame the geometry scan can read. */
async function awaitDerivableGrid(page) {
  let grid = null;
  await expect
    .poll(
      async () => {
        grid = await deriveGrid(page);
        return grid.ok;
      },
      { timeout: 20_000, intervals: [100, 150, 250] }
    )
    .toBe(true);
  return grid;
}

// ===========================================================================
// Q1.1 - latency ladder
// ===========================================================================

test('Q1.1a ladder model: 1000ms x Fibonacci, clamped at 8000ms', () => {
  const jitter = new FibonacciJitter({ jitterBudget: 10 });
  const delays = Array.from({ length: 10 }, () => jitter.next());

  expect(delays).toEqual([1000, 1000, 2000, 3000, 5000, 8000, 8000, 8000, 8000, 8000]);

  const report = jitter.report();
  expect(report.framesJittered).toBe(10);
  expect(Math.max(...report.ladderMs)).toBe(8000);
  // fib steps 13, 21, 34 and 55 all exceed the ceiling and must be clamped
  expect(report.cappedFrames).toBe(4);
});

test('Q1.1b live interception: real frames are held for the laddered durations', async ({ page }) => {
  const { interceptor } = await openTerminal(page, { jitterBudget: 6 });

  await expect
    .poll(() => interceptor.stats.framesReleased, { timeout: 45_000, intervals: [250] })
    .toBeGreaterThanOrEqual(6);

  const stats = interceptor.stats;
  expect(stats.framesIntercepted).toBeGreaterThanOrEqual(6);
  expect(stats.jitter.ladderMs.slice(0, 6)).toEqual([1000, 1000, 2000, 3000, 5000, 8000]);
  expect(stats.jitter.capMs).toBe(8000);

  // Measured proof: the wall-clock gap between consecutive releases reproduces
  // the ladder. Nothing is trusted from the model's own bookkeeping here.
  const releases = interceptor.releases.slice(0, 6);
  const gaps = releases.slice(1).map((r, i) => r.at - releases[i].at);
  const expectedGaps = [1000, 2000, 3000, 5000, 8000];

  gaps.forEach((gap, i) => {
    expect(
      Math.abs(gap - expectedGaps[i]),
      `release gap ${i + 1} was ${gap}ms, expected ~${expectedGaps[i]}ms`
    ).toBeLessThan(400);
  });

  // eslint-disable-next-line no-console
  console.log(`\n  jitter ladder measured on the wire: [${gaps.join(', ')}] ms\n`);
});

// ===========================================================================
// Q1.2 - pixel-derived geometry (no DOM, no bounding box, no static delay)
// ===========================================================================

test('Q1.2 coordinate engine: grid geometry is recovered from separator pixels alone', async ({ page }) => {
  await openTerminal(page);
  const grid = await awaitDerivableGrid(page);

  expect(grid.cols).toBe(6);
  expect(grid.rows).toBe(3);
  expect(grid.cells).toHaveLength(18);

  // Boundaries must be monotonic and evenly pitched - that is what proves the
  // scan found real separators rather than noise.
  const pitches = grid.colBoundaries.slice(1).map((b, i) => b - grid.colBoundaries[i]);
  const spread = Math.max(...pitches) - Math.min(...pitches);
  expect(spread, `column pitch spread ${spread}px`).toBeLessThanOrEqual(2);

  const target = grid.cells[TARGET_CELL];
  expect(target.w).toBeGreaterThan(100);
  expect(target.h).toBeGreaterThan(80);

  // Every cell starts at the implicit gray loading threshold.
  const probe = await probeCell(page, TARGET_CELL);
  expect(probe.ok).toBe(true);
  expect(probe.klass).toBe('loading');

  // eslint-disable-next-line no-console
  console.log(
    `\n  derived ${grid.cols}x${grid.rows} grid; column boundaries [${grid.colBoundaries.join(', ')}]\n`
  );
});

// ===========================================================================
// Q1.2 + Q1.3 - the race injection trap
// ===========================================================================

test('Q1.3 race trap: pixel latch drives Hover -> Drag15px -> Click inside the 30-100ms window', async ({
  page,
}) => {
  const { interceptor } = await openTerminal(page, { jitterBudget: 6 });

  await test.step('recover grid geometry from the rendered frame', async () => {
    const grid = await awaitDerivableGrid(page);
    expect(grid.ok).toBe(true);
  });

  // The chain has ~25-50ms of headroom inside a 100ms ceiling, so a scheduler
  // hiccup or a GC pause can push one cycle over it. A retry against the *same*
  // latch cannot help - that instant is fixed, so every further attempt is
  // further from it. What does help is the terminal's own state drift: the feed
  // re-subscribes the target cell every 2s, dropping it back to gray and
  // discarding its interaction state, which yields a genuinely fresh
  // gray->active transition to latch onto and fire against.
  const cycles = [];
  let latch;
  let outcome;
  let breaker;

  for (let cycle = 1; cycle <= 3; cycle += 1) {
    latch = await test.step(`cycle ${cycle}: latch the gray -> active transition via requestAnimationFrame`, async () => {
      const result = await watchCellTransition(page, TARGET_CELL, {
        from: ['loading'],
        to: ['up', 'down'],
        timeoutMs: 60_000,
      });
      expect(result.ok, result.reason).toBe(true);
      expect(result.fromClass).toBe('loading');
      expect(['up', 'down']).toContain(result.toClass);
      expect(result.frames).toBeGreaterThan(1);
      return result;
    });

    // The first transition had to survive the injected ladder, so it cannot
    // have been observed instantly - proof the latch tracked a genuinely
    // deferred state rather than one that was already settled.
    if (cycle === 1) {
      expect(latch.waitedMs, 'first transition must arrive under injected latency').toBeGreaterThan(3_000);
    }

    breaker = new CircuitBreaker({ name: `canvas-chained-action-c${cycle}`, maxAttempts: 4 });

    outcome = await test.step(`cycle ${cycle}: fire the chained actions behind the circuit breaker`, async () =>
      fireRaceChain(page, {
        cellIndex: TARGET_CELL,
        detectedEpoch: latch.detectedEpoch,
        seed: { cell: latch.cell, transform: latch.transform },
        breaker,
      })
    );

    // The interaction itself must land on every cycle - that is the breaker's
    // job, and a failure there is a real defect, not a timing artefact.
    expect(outcome.ok).toBe(true);
    expect(outcome.verdict.klass).toBe('armed');

    cycles.push({
      cycle,
      latchedAfterMs: latch.waitedMs,
      rafProbes: latch.frames,
      chainElapsedMs: outcome.verdict.chainElapsedMs,
      withinWindow: outcome.verdict.withinWindow,
      phases: outcome.verdict.phases.join(' '),
    });

    if (outcome.verdict.withinWindow) break;
  }

  const elapsed = outcome.verdict.chainElapsedMs;
  const phases = outcome.verdict.phases.join(' ');
  const trace = cycles.map((c) => `c${c.cycle}=${c.chainElapsedMs}ms`).join(' ');

  expect(
    elapsed,
    `chain completed ${elapsed}ms after the pixel latch (phases: ${phases}; cycles: ${trace})`
  ).toBeGreaterThanOrEqual(WINDOW_FLOOR_MS);
  expect(
    elapsed,
    `chain completed ${elapsed}ms after the pixel latch (phases: ${phases}; cycles: ${trace})`
  ).toBeLessThanOrEqual(WINDOW_CEILING_MS);
  expect(outcome.verdict.withinWindow).toBe(true);

  // Every cycle after the first exists because the terminal drifted.
  const snapshotAfterCycles = await page.evaluate(() => window.__TERMINAL__.snapshot());
  expect(snapshotAfterCycles.drifts).toBeGreaterThanOrEqual(cycles.length - 1);

  // The chain must actually have run in order: the app refuses to arm unless
  // hover preceded a >=12px drag which preceded a separate click.
  const marks = await page.evaluate(() => window.__TERMINAL__.snapshot().marks);
  expect(marks.hovered).toBeDefined();
  expect(marks.dragged).toBeDefined();
  expect(marks.armed).toBeDefined();
  expect(marks.dragged).toBeGreaterThan(marks.hovered);
  expect(marks.armed).toBeGreaterThan(marks.dragged);

  // eslint-disable-next-line no-console
  console.log(
    [
      '',
      `  latch      : ${latch.fromClass} -> ${latch.toClass} after ${latch.waitedMs}ms (${latch.frames} rAF probes)`,
      `  chain      : first action +${outcome.verdict.firstActionOffsetMs}ms, completed +${elapsed}ms  [window ${WINDOW_FLOOR_MS}-${WINDOW_CEILING_MS}ms]`,
      `  phases     : ${phases}`,
      `  cycles     : ${cycles.length} (${trace})  drifts observed ${snapshotAfterCycles.drifts}`,
      `  breaker    : ${JSON.stringify(breaker.report())}`,
      `  interceptor: ${JSON.stringify(interceptor.stats.jitter.ladderMs)}`,
      '',
    ].join('\n')
  );
});

test('Q1.3 state drift: a resubscribed cell returns to gray and its armed state is discarded', async ({
  page,
}) => {
  // No jitter here - this test is about the drift cycle itself, not latency.
  await openTerminal(page);
  await awaitDerivableGrid(page);

  // 1. gray -> active
  const activated = await watchCellTransition(page, TARGET_CELL, {
    from: ['loading'],
    to: ['up', 'down'],
    timeoutMs: 30_000,
  });
  expect(activated.ok, activated.reason).toBe(true);

  // 2. arm it, so there is interaction state for the drift to discard
  const breaker = new CircuitBreaker({ name: 'drift-precondition', maxAttempts: 4 });
  const armed = await fireRaceChain(page, {
    cellIndex: TARGET_CELL,
    detectedEpoch: activated.detectedEpoch,
    seed: { cell: activated.cell, transform: activated.transform },
    breaker,
  });
  expect(armed.ok).toBe(true);
  expect(armed.verdict.klass).toBe('armed');

  // 3. drift: armed -> back to the gray loading threshold
  const drifted = await watchCellTransition(page, TARGET_CELL, {
    from: ['armed'],
    to: ['loading'],
    timeoutMs: 30_000,
  });
  expect(drifted.ok, drifted.reason).toBe(true);
  expect(drifted.fromClass).toBe('armed');
  expect(drifted.toClass).toBe('loading');

  const afterDrift = await page.evaluate(() => window.__TERMINAL__.snapshot());
  expect(afterDrift.drifts).toBeGreaterThan(0);
  expect(afterDrift.phase, 'interaction state must be discarded by the drift').toBe('idle');
  expect(afterDrift.marks).toEqual({});

  // 4. and the cycle repeats, which is what makes the race trap re-runnable
  const reactivated = await watchCellTransition(page, TARGET_CELL, {
    from: ['loading'],
    to: ['up', 'down'],
    timeoutMs: 30_000,
  });
  expect(reactivated.ok, reactivated.reason).toBe(true);

  // eslint-disable-next-line no-console
  console.log(
    `\n  drift cycle: active -> loading -> active; ${afterDrift.drifts} drift(s), interaction reset to '${afterDrift.phase}'\n`
  );
});

test('Q1.3 resilience: an out-of-order stream is absorbed without losing the latch', async ({ page }) => {
  const { interceptor } = await openTerminal(page, { jitterBudget: 6, preserveOrder: false });

  // Poll the *application's* stale counter, not the interceptor's. The
  // interceptor increments the instant it calls route.send(), but the page has
  // not processed that frame yet - snapshotting off the sender's count races the
  // receiver and fails under load. The receiver's own counter is the signal that
  // the reorder was actually observed downstream.
  await expect
    .poll(async () => (await page.evaluate(() => window.__TERMINAL__.snapshot())).staleDrops, {
      timeout: 45_000,
      intervals: [250],
    })
    .toBeGreaterThan(0);

  const snapshot = await page.evaluate(() => window.__TERMINAL__.snapshot());

  expect(interceptor.stats.framesReordered, 'the wire must have delivered frames out of order').toBeGreaterThan(0);
  expect(snapshot.staleDrops, 'application must discard frames older than its sequence cursor').toBeGreaterThan(0);
  expect(snapshot.framesApplied).toBeGreaterThan(0);
  expect(snapshot.lastSeq).toBeGreaterThanOrEqual(snapshot.framesApplied);

  const probe = await probeCell(page, TARGET_CELL);
  expect(probe.ok).toBe(true);
  expect(probe.klass).not.toBe('unknown');

  // eslint-disable-next-line no-console
  console.log(
    `\n  reordered ${interceptor.stats.framesReordered} frame(s) on the wire; app dropped ${snapshot.staleDrops} stale frame(s)\n`
  );
});

// ===========================================================================
// Q1.4 - mismatched server boundary checking
// ===========================================================================

const BOUNDARY_CASES = [
  {
    vector: 'NON_NUMERIC',
    expectation: 'rejected',
    rationale: 'control case - proves a structured exception boundary exists at all',
  },
  {
    vector: 'SCIENTIFIC',
    expectation: 'accepted',
    rationale: 'magnitude bypass - 1e+7 is valid JSON and clears a type-only guard',
  },
  {
    vector: 'FRACTIONAL',
    expectation: 'accepted',
    rationale: 'precision bypass - a binary float artefact in a currency field',
  },
];

for (const boundaryCase of BOUNDARY_CASES) {
  const { vector, expectation, rationale } = boundaryCase;
  const meta = VECTORS[vector];

  test(`Q1.4 boundary probe [${vector}]: ${meta.label}`, async ({ page }) => {
    const { corruptor } = await openTerminal(page);
    await awaitDerivableGrid(page);

    // The band must be clean before we inject, or the reading proves nothing.
    const baseline = await countColour(page, PALETTE.boundary);
    expect(baseline.hits, 'exception band must be idle before injection').toBeLessThan(50);

    corruptor.arm(vector);

    await expect
      .poll(() => (corruptor.lastMutation ? 1 : 0), { timeout: 20_000, intervals: [100] })
      .toBe(1);

    const mutation = corruptor.lastMutation;
    expect(mutation.injected).toBe(meta.literal);

    // Read the verdict off the presented frame, then corroborate numerically.
    await presentedProbe(page, TARGET_CELL);
    const band = await countColour(page, PALETTE.boundary);
    const snapshot = await page.evaluate(() => window.__TERMINAL__.snapshot());

    const boundaryEngaged = band.hits > 50;
    const observed = boundaryEngaged ? 'rejected' : 'accepted';

    if (expectation === 'rejected') {
      expect(
        boundaryEngaged,
        `injected ${mutation.injected} but the amber exception band never rendered`
      ).toBe(true);
      expect(snapshot.boundary).not.toBeNull();
      recordFinding({
        severity: 'INFO',
        vector,
        title: `Exception boundary correctly rejected ${meta.label}`,
        detail: `wire value ${mutation.injected} -> boundary code ${snapshot.boundary.code}. A boundary mechanism is present.`,
      });
    } else {
      // Assert the *detection*, not the defect: the suite's job here is to prove
      // the corruption slipped through and to escalate it.
      expect(
        boundaryEngaged,
        `expected silent acceptance of ${mutation.injected} but the boundary engaged`
      ).toBe(false);
      expect(snapshot.boundary).toBeNull();

      const accepted = snapshot.acceptedBalances[snapshot.acceptedBalances.length - 1];
      recordFinding({
        severity: 'CRITICAL',
        vector,
        title: `Client-side corruption silently accepted: ${meta.label}`,
        detail:
          `Injected "balance":${mutation.injected} through the intercepted stream. No exception ` +
          `boundary engaged; the UI rendered balance=${accepted} as legitimate ledger state. ` +
          `${rationale}. The guard type-checks but does not range- or precision-check.`,
      });
    }

    expect(observed).toBe(expectation);
  });
}

test('Q1.4 summary: boundary coverage gaps are captured as findings', () => {
  const critical = findings.filter((f) => f.severity === 'CRITICAL');
  const info = findings.filter((f) => f.severity === 'INFO');

  expect(info.length, 'at least one control case must confirm a boundary exists').toBeGreaterThan(0);
  expect(critical.length, 'bypass vectors must be reported, not swallowed').toBe(2);

  // eslint-disable-next-line no-console
  console.log(
    [
      '',
      '  ===== Q1.4 BOUNDARY VERDICT =====',
      `  boundary mechanism present : yes (${info.length} control case rejected)`,
      `  bypass vectors accepted    : ${critical.length} (CRITICAL)`,
      ...critical.map((f) => `    - ${f.vector}: ${f.title}`),
      '  =================================',
      '',
    ].join('\n')
  );
});
