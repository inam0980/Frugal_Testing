/**
 * Fibonacci latency ladder for WebSocket frame interception.
 *
 * Spec (Q1.1): "inject a dynamically scaling network delay model
 *               (1000 ms x Fibonacci sequence step) capped at 8000 ms"
 *
 * Ladder: 1,1,2,3,5,8,13,... x 1000ms, clamped to 8000ms
 *      -> 1000, 1000, 2000, 3000, 5000, 8000, 8000, 8000 ...
 *
 * Design note on `jitterBudget`
 * ----------------------------------------------------------------------------
 * The feed emits a frame every 250ms. If every frame were held for up to 8s the
 * socket would accumulate an unbounded backlog and the suite would take minutes
 * to reach a decidable state. So the ladder is applied to the first N frames
 * (the full climb, 20s of cumulative injected latency by default) and then the
 * route falls through to zero-delay. `rearm()` restarts the climb when a test
 * wants to re-stress an already-settled UI.
 *
 * Because each delayed frame is released on its own timer rather than through a
 * FIFO, the ladder also reorders frames - which is the intended secondary
 * effect: it forces the application to defend its sequence counter and gives
 * the suite real stale frames to observe instead of simulated ones.
 */

const DEFAULT_UNIT_MS = 1000;
const DEFAULT_CAP_MS = 8000;
const DEFAULT_BUDGET = 6; // 1+1+2+3+5+8 = 20s of climb

class FibonacciJitter {
  constructor({ unitMs = DEFAULT_UNIT_MS, capMs = DEFAULT_CAP_MS, jitterBudget = DEFAULT_BUDGET } = {}) {
    this.unitMs = unitMs;
    this.capMs = capMs;
    this.jitterBudget = jitterBudget;
    this.rearm();
  }

  rearm() {
    this.prev = 0;
    this.curr = 1;
    this.issued = 0;
    this.ledger = [];
  }

  /** @returns {number} milliseconds of latency to apply to the next frame */
  next() {
    if (this.issued >= this.jitterBudget) {
      this.ledger.push({ step: this.issued + 1, delayMs: 0, capped: false, passthrough: true });
      this.issued += 1;
      return 0;
    }

    const step = this.curr;
    const raw = step * this.unitMs;
    const delayMs = Math.min(raw, this.capMs);

    this.ledger.push({
      step: this.issued + 1,
      fib: step,
      rawMs: raw,
      delayMs,
      capped: raw > this.capMs,
      passthrough: false,
    });

    // advance the sequence
    const nextFib = this.prev + this.curr;
    this.prev = this.curr;
    this.curr = nextFib;
    this.issued += 1;

    return delayMs;
  }

  /** Total latency deliberately injected into the stream so far. */
  get injectedTotalMs() {
    return this.ledger.reduce((sum, e) => sum + e.delayMs, 0);
  }

  /** Human-readable proof for the execution log / video walkthrough. */
  report() {
    const climbed = this.ledger.filter((e) => !e.passthrough);
    return {
      framesSeen: this.ledger.length,
      framesJittered: climbed.length,
      ladderMs: climbed.map((e) => e.delayMs),
      cappedFrames: climbed.filter((e) => e.capped).length,
      injectedTotalMs: this.injectedTotalMs,
      capMs: this.capMs,
    };
  }
}

module.exports = { FibonacciJitter, DEFAULT_CAP_MS, DEFAULT_UNIT_MS };
