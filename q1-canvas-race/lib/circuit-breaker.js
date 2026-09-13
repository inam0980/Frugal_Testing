/**
 * Circuit-breaker macro for the interaction layer (Q1.3)
 *
 * A canvas terminal repaints on every frame. Between the instant the pixel latch
 * fires and the instant the mouse actually lands, the grid can have shifted, the
 * frame the latch observed can already be stale, or the compositor can have
 * dropped the repaint entirely. Retrying blindly makes that worse; retrying
 * against *recalibrated* geometry fixes it.
 *
 * Each attempt is therefore: recalibrate -> act -> verify.
 *   recalibrate  re-derives the grid offsets from the current frame's pixels
 *   act          fires the chained interaction against the fresh offsets
 *   verify       re-probes the pixels to confirm the interaction landed
 *
 * States
 *   closed     normal operation
 *   half-open  at least one attempt has failed; geometry is resuspect
 *   open       failure budget exhausted; stop acting and surface the trace
 *
 * The breaker never sleeps. Backoff between attempts is work, not waiting: the
 * recalibrate hook performs a real pixel scan, which is what the next attempt
 * needs anyway.
 */

class CircuitOpenError extends Error {
  constructor(name, trace) {
    const lines = trace.map(
      (t) =>
        `  attempt ${t.attempt} [${t.state}] -> ${t.outcome}` +
        (t.error ? ` :: ${t.error}` : '') +
        (t.verify && t.verify.reason ? ` :: ${t.verify.reason}` : '') +
        (t.act ? ` :: ${JSON.stringify(t.act)}` : '')
    );
    super([`circuit '${name}' opened after ${trace.length} attempt(s)`, ...lines].join('\n'));
    this.name = 'CircuitOpenError';
    this.trace = trace;
  }
}

class CircuitBreaker {
  constructor({ name = 'interaction', maxAttempts = 4 } = {}) {
    this.name = name;
    this.maxAttempts = maxAttempts;
    this.state = 'closed';
    this.trace = [];
  }

  /**
   * @param {object} hooks
   * @param {(attempt:number) => Promise<any>} hooks.recalibrate re-derive offsets from pixels
   * @param {(calibration:any, attempt:number) => Promise<any>} hooks.act
   * @param {(actResult:any) => Promise<{ok:boolean, detail?:any}>} hooks.verify
   */
  async run({ recalibrate, act, verify }) {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const startedAt = Date.now();
      const entry = { attempt, state: this.state, startedAt };

      try {
        const calibration = await recalibrate(attempt);
        entry.calibration = summarise(calibration);

        const actResult = await act(calibration, attempt);
        entry.act = actResult && actResult.summary ? actResult.summary : undefined;

        const verdict = await verify(actResult);
        entry.verify = verdict;
        entry.elapsedMs = Date.now() - startedAt;

        if (verdict.ok) {
          entry.outcome = 'passed';
          this.trace.push(entry);
          this.state = 'closed';
          return { ok: true, attempts: attempt, result: actResult, verdict, trace: this.trace };
        }

        entry.outcome = 'rejected';
        this.trace.push(entry);
        this.state = 'half-open';
      } catch (err) {
        entry.outcome = 'threw';
        entry.error = err.message;
        entry.elapsedMs = Date.now() - startedAt;
        this.trace.push(entry);
        this.state = 'half-open';
      }
    }

    this.state = 'open';
    throw new CircuitOpenError(this.name, this.trace);
  }

  report() {
    return {
      circuit: this.name,
      state: this.state,
      attempts: this.trace.length,
      recalibrations: this.trace.filter((t) => t.calibration).length,
      outcomes: this.trace.map((t) => t.outcome),
    };
  }
}

function summarise(calibration) {
  if (!calibration) return null;
  if (calibration.grid) {
    return {
      cols: calibration.grid.cols,
      rows: calibration.grid.rows,
      colBoundaries: calibration.grid.colBoundaries,
      cellOrigin: calibration.cell ? { x: calibration.cell.x, y: calibration.cell.y } : undefined,
    };
  }
  return { keys: Object.keys(calibration) };
}

module.exports = { CircuitBreaker, CircuitOpenError };
