/**
 * WebSocket stream interception (Q1.1 + Q1.4)
 *
 * Hooks the page's live socket with Playwright's `routeWebSocket`, which puts
 * this process in the middle of the connection: server frames arrive here
 * first, and only reach the application when this code forwards them. That is
 * the seam the Fibonacci latency ladder and the corruption vectors are injected
 * through.
 *
 * Release ordering
 * ----------------------------------------------------------------------------
 * `preserveOrder: true` (default) models real link latency: each frame is
 * released at `max(now, tailOfQueue) + delay`, so the ladder genuinely defers
 * the application's state transition without ever reordering the stream. Naive
 * per-frame timers would let a 0ms frame overtake an 8000ms frame, the app's
 * sequence guard would discard the older one, and the state under test would
 * simply never arrive - a self-inflicted flake rather than a finding.
 *
 * `preserveOrder: false` is the opposite on purpose: it lets frames overtake so
 * the suite can prove the application defends its sequence counter and that the
 * pixel latch tolerates stale frames.
 *
 * The setTimeout here is not a synchronisation primitive - the suite never waits
 * on it. It is the latency being injected, which is the requirement.
 */

class WsInterceptor {
  constructor({ jitter, corruptor, preserveOrder = true } = {}) {
    this.jitter = jitter;
    this.corruptor = corruptor;
    this.preserveOrder = preserveOrder;

    this.queueTail = 0;
    this.frames = [];          // every intercepted server frame
    this.releases = [];        // when each frame was actually handed to the page
    this.reorderedCount = 0;
    this.lastReleasedSeq = 0;
  }

  /**
   * @param {import('@playwright/test').Page} page
   * @param {RegExp|string} urlPattern
   */
  async attach(page, urlPattern = /\/stream/) {
    await page.routeWebSocket(urlPattern, (route) => {
      const upstream = route.connectToServer();

      upstream.onMessage((message) => {
        const raw = typeof message === 'string' ? message : String(message);
        const seq = extractSeq(raw);
        const receivedAt = Date.now();

        const mutated = this.corruptor ? this.corruptor.apply(raw) : raw;
        const delayMs = this.jitter ? this.jitter.next() : 0;

        this.frames.push({ seq, receivedAt, delayMs, mutated: mutated !== raw, bytes: raw.length });

        const now = Date.now();
        const releaseAt = this.preserveOrder
          ? Math.max(now, this.queueTail) + delayMs
          : now + delayMs;
        this.queueTail = releaseAt;

        const hand = () => {
          try {
            route.send(mutated);
          } catch {
            return; // socket closed mid-flight; nothing to forward to
          }
          if (seq !== null && seq < this.lastReleasedSeq) this.reorderedCount += 1;
          if (seq !== null) this.lastReleasedSeq = Math.max(this.lastReleasedSeq, seq);
          this.releases.push({ seq, at: Date.now(), heldMs: Date.now() - receivedAt });
        };

        const wait = releaseAt - now;
        if (wait <= 0) hand();
        else setTimeout(hand, wait);
      });

      // Client -> server direction is passed through untouched.
      route.onMessage((message) => {
        try {
          upstream.send(message);
        } catch {
          /* upstream gone */
        }
      });
    });

    return this;
  }

  get stats() {
    return {
      framesIntercepted: this.frames.length,
      framesReleased: this.releases.length,
      framesMutated: this.frames.filter((f) => f.mutated).length,
      framesReordered: this.reorderedCount,
      maxHeldMs: this.releases.reduce((m, r) => Math.max(m, r.heldMs), 0),
      jitter: this.jitter ? this.jitter.report() : null,
    };
  }
}

function extractSeq(raw) {
  const m = /"seq"\s*:\s*(\d+)/.exec(raw);
  return m ? Number(m[1]) : null;
}

module.exports = { WsInterceptor };
