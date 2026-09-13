/**
 * Pixel-probing coordinate + state engine (Q1.2 - the "Anti-AI Constraint")
 *
 * What is deliberately NOT used anywhere in this file:
 *   - page.waitForTimeout / setTimeout as a synchronisation primitive
 *   - waitForSelector, toBeVisible, or any fluent visibility poll
 *   - locator.boundingBox() as a readiness signal
 *   - any DOM query beyond obtaining the single <canvas> drawing surface
 *
 * What is used instead:
 *   1. A coordinate calculation engine that recovers the grid's geometry by
 *      scanning getImageData() for runs of the separator RGB - the cell rects
 *      are *measured from the rendered frame*, not read from the application.
 *   2. A requestAnimationFrame latch that samples a probe point inside a cell
 *      every frame and resolves the moment its classification crosses from the
 *      implicit gray loading threshold to an active colour.
 *
 * The only geometric fact taken from outside the pixel domain is the canvas
 * element's own rect, used purely as the affine canvas-space -> viewport-space
 * transform required to address the mouse. It is never consulted to decide
 * whether anything is ready, and the circuit breaker re-reads it on every
 * attempt so a scroll or resize mid-run cannot desynchronise the mapping.
 */

/* eslint-disable no-undef */

/**
 * Installed into the page before any application script runs.
 * Exposed as window.__PIXEL_ENGINE__.
 */
function installPixelEngine() {
  const TOLERANCE = 14;

  const CLASSES = {
    loading: [128, 128, 128],
    up: [22, 163, 74],
    down: [220, 38, 38],
    armed: [168, 85, 247],
  };
  const GRIDLINE = [27, 36, 48];

  function surface() {
    const canvas = document.querySelector('canvas');
    if (!canvas) throw new Error('pixel-engine: no canvas surface present');
    return { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) };
  }

  function near(rgb, target, tol = TOLERANCE) {
    return (
      Math.abs(rgb[0] - target[0]) <= tol &&
      Math.abs(rgb[1] - target[1]) <= tol &&
      Math.abs(rgb[2] - target[2]) <= tol
    );
  }

  function classify(rgb) {
    for (const [name, target] of Object.entries(CLASSES)) {
      if (near(rgb, target)) return name;
    }
    return 'unknown';
  }

  /** Mean RGB of a small patch - flat fills make this exact, AA-proof. */
  function samplePatch(ctx, x, y, size = 5) {
    const half = Math.floor(size / 2);
    const data = ctx.getImageData(Math.round(x) - half, Math.round(y) - half, size, size).data;
    let r = 0;
    let g = 0;
    let b = 0;
    const px = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
    }
    return [Math.round(r / px), Math.round(g / px), Math.round(b / px)];
  }

  function cluster(indices, gap = 2) {
    if (!indices.length) return [];
    const centres = [];
    let start = indices[0];
    let prev = indices[0];
    for (let i = 1; i < indices.length; i += 1) {
      const v = indices[i];
      if (v - prev <= gap) {
        prev = v;
      } else {
        centres.push((start + prev) / 2);
        start = v;
        prev = v;
      }
    }
    centres.push((start + prev) / 2);
    return centres;
  }

  /**
   * Last geometry produced by deriveGrid().
   *
   * Layering, which matters for the 30-100ms budget: a full derivation is two
   * whole-surface getImageData passes (~70ms here), far too expensive to repeat
   * between the phases of a chained action. So the breaker's recalibrate hook
   * calls deriveGrid() to refresh this cache once per attempt, and the cheap
   * intra-chain barriers reuse it - a 5x5 patch read instead of a 468k-pixel
   * scan. Geometry is therefore always at most one attempt stale, never
   * silently stale across a recalibration.
   */
  let cachedGrid = null;

  /**
   * Recover grid geometry from the rendered frame alone.
   *
   * Pass A: for each scanline y, count pixels matching the separator RGB across
   *         the full width. Horizontal separators spike; cluster them into
   *         row boundaries.
   * Pass B: within the y-range found above, count separator pixels down each
   *         column x. Vertical separators spike; cluster into column boundaries.
   */
  function deriveGrid() {
    const { canvas, ctx } = surface();
    const W = canvas.width;
    const H = canvas.height;
    const frame = ctx.getImageData(0, 0, W, H).data;

    const at = (x, y) => {
      const i = (y * W + x) * 4;
      return [frame[i], frame[i + 1], frame[i + 2]];
    };

    const rowHits = [];
    for (let y = 0; y < H; y += 1) {
      let hits = 0;
      for (let x = 0; x < W; x += 4) {
        if (near(at(x, y), GRIDLINE, 8)) hits += 1;
      }
      if (hits > (W / 4) * 0.5) rowHits.push(y);
    }

    const rowBoundaries = cluster(rowHits);
    if (rowBoundaries.length < 2) {
      return { ok: false, reason: 'no horizontal separators resolved', rowHits: rowHits.length };
    }

    const yTop = Math.min(...rowHits);
    const yBottom = Math.max(...rowHits);
    const span = yBottom - yTop;

    const colHits = [];
    for (let x = 0; x < W; x += 1) {
      let hits = 0;
      for (let y = yTop; y <= yBottom; y += 4) {
        if (near(at(x, y), GRIDLINE, 8)) hits += 1;
      }
      if (hits > (span / 4) * 0.5) colHits.push(x);
    }

    const colBoundaries = cluster(colHits);
    if (colBoundaries.length < 2) {
      return { ok: false, reason: 'no vertical separators resolved', colHits: colHits.length };
    }

    const cols = colBoundaries.length - 1;
    const rows = rowBoundaries.length - 1;
    const cells = [];
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const x0 = colBoundaries[c];
        const x1 = colBoundaries[c + 1];
        const y0 = rowBoundaries[r];
        const y1 = rowBoundaries[r + 1];
        cells.push({
          index: r * cols + c,
          row: r,
          col: c,
          x: x0,
          y: y0,
          w: x1 - x0,
          h: y1 - y0,
          centre: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 },
          // Probe high in the cell: clear of the price text at the bottom, the
          // drag handle above it, and the 3px hover stroke at the edges.
          probe: { x: (x0 + x1) / 2, y: y0 + (y1 - y0) * 0.28 },
        });
      }
    }

    cachedGrid = {
      ok: true,
      canvas: { w: W, h: H },
      cols,
      rows,
      colBoundaries,
      rowBoundaries,
      cells,
      derivedAt: Date.now(),
    };
    return cachedGrid;
  }

  function probeCell(cellIndex, grid) {
    const g = grid || cachedGrid || deriveGrid();
    if (!g.ok) return { ok: false, reason: g.reason };
    const cell = g.cells[cellIndex];
    if (!cell) return { ok: false, reason: `cell ${cellIndex} outside derived grid` };
    const { ctx } = surface();
    const rgb = samplePatch(ctx, cell.probe.x, cell.probe.y);
    return { ok: true, cellIndex, rgb, klass: classify(rgb), probe: cell.probe, at: Date.now() };
  }

  /**
   * rAF latch. Resolves the first frame on which the cell's classification
   * leaves `from` and lands in `to`.
   */
  function watchCellTransition(cellIndex, opts) {
    const from = (opts && opts.from) || ['loading'];
    const to = (opts && opts.to) || ['up', 'down'];
    const timeoutMs = (opts && opts.timeoutMs) || 45000;

    return new Promise((resolve) => {
      const grid = deriveGrid();
      if (!grid.ok) {
        resolve({ ok: false, reason: `geometry unresolved: ${grid.reason}` });
        return;
      }

      const cell = grid.cells[cellIndex];
      if (!cell) {
        resolve({ ok: false, reason: `cell ${cellIndex} outside derived grid` });
        return;
      }

      const { ctx } = surface();
      const startedAt = performance.now();
      const startedEpoch = Date.now();
      let frames = 0;
      let baselineSeen = false;
      let baselineClass = null;

      const tick = () => {
        frames += 1;
        const rgb = samplePatch(ctx, cell.probe.x, cell.probe.y);
        const klass = classify(rgb);

        if (!baselineSeen) {
          if (from.includes(klass)) {
            baselineSeen = true;
            baselineClass = klass;
          } else if (performance.now() - startedAt > timeoutMs) {
            resolve({ ok: false, reason: `baseline never observed (saw '${klass}')`, frames, rgb });
            return;
          }
          requestAnimationFrame(tick);
          return;
        }

        if (to.includes(klass)) {
          resolve({
            ok: true,
            cellIndex,
            fromClass: baselineClass,
            toClass: klass,
            rgb,
            frames,
            // Wall clock, so the Node side can measure the 30-100ms action
            // window against the same reference.
            detectedEpoch: Date.now(),
            latchedAfterMs: Math.round(performance.now() - startedAt),
            waitedMs: Date.now() - startedEpoch,
            cell: { x: cell.x, y: cell.y, w: cell.w, h: cell.h, centre: cell.centre, probe: cell.probe },
            // Shipped with the latch so the interaction layer needs no round
            // trip of its own before dispatching - every millisecond here comes
            // straight out of the 100ms action budget.
            transform: viewportTransform(),
            geometry: { cols: grid.cols, rows: grid.rows, colBoundaries: grid.colBoundaries },
          });
          return;
        }

        if (performance.now() - startedAt > timeoutMs) {
          resolve({ ok: false, reason: `no transition within ${timeoutMs}ms (stuck at '${klass}')`, frames, rgb });
          return;
        }
        requestAnimationFrame(tick);
      };

      requestAnimationFrame(tick);
    });
  }

  /** Read one arbitrary canvas point (used for bands outside the grid). */
  function samplePoint(x, y, size = 5) {
    const { ctx } = surface();
    const rgb = samplePatch(ctx, x, y, size);
    return { rgb, klass: classify(rgb), at: Date.now() };
  }

  /**
   * Count pixels matching a colour anywhere on the surface, and return their
   * bounding box. Lets the suite ask "has the amber exception band appeared?"
   * without hardcoding where that band happens to be drawn.
   */
  function countColour(target, tol = TOLERANCE, stride = 3) {
    const { canvas, ctx } = surface();
    const W = canvas.width;
    const H = canvas.height;
    const data = ctx.getImageData(0, 0, W, H).data;

    let hits = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (let y = 0; y < H; y += stride) {
      for (let x = 0; x < W; x += stride) {
        const i = (y * W + x) * 4;
        if (near([data[i], data[i + 1], data[i + 2]], target, tol)) {
          hits += 1;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }

    return {
      hits,
      sampledEvery: stride,
      bbox: hits ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null,
    };
  }

  /** Canvas-space -> viewport-space transform. Re-read on every attempt. */
  function viewportTransform() {
    const { canvas } = surface();
    const r = canvas.getBoundingClientRect();
    return {
      left: r.left,
      top: r.top,
      scaleX: r.width / canvas.width,
      scaleY: r.height / canvas.height,
    };
  }

  /**
   * Everything the interaction layer needs, in one round trip.
   *
   * `force: false` reuses the cached geometry - correct on the first attempt,
   * because the latch that just fired derived it from the very frame the state
   * change was observed on. `force: true` re-scans, which is what a retry after
   * a rejected attempt actually needs.
   */
  function calibrate(cellIndex, opts) {
    const force = Boolean(opts && opts.force);
    const grid = force || !cachedGrid ? deriveGrid() : cachedGrid;
    if (!grid.ok) return { ok: false, reason: grid.reason };

    const cell = grid.cells[cellIndex];
    if (!cell) return { ok: false, reason: `cell ${cellIndex} absent from grid` };

    const { ctx } = surface();
    const rgb = samplePatch(ctx, cell.probe.x, cell.probe.y);

    return {
      ok: true,
      forced: force,
      geometryAgeMs: Date.now() - grid.derivedAt,
      grid: {
        cols: grid.cols,
        rows: grid.rows,
        colBoundaries: grid.colBoundaries,
        rowBoundaries: grid.rowBoundaries,
      },
      cell: { x: cell.x, y: cell.y, w: cell.w, h: cell.h, centre: cell.centre, probe: cell.probe },
      klass: classify(rgb),
      rgb,
      transform: viewportTransform(),
    };
  }

  window.__PIXEL_ENGINE__ = {
    CLASSES,
    GRIDLINE,
    classify,
    deriveGrid,
    probeCell,
    samplePoint,
    countColour,
    watchCellTransition,
    viewportTransform,
    calibrate,
  };
}

// ---------------------------------------------------------------------------
// Node-side thin wrappers
// ---------------------------------------------------------------------------

async function deriveGrid(page) {
  return page.evaluate(() => window.__PIXEL_ENGINE__.deriveGrid());
}

async function probeCell(page, cellIndex) {
  return page.evaluate((i) => window.__PIXEL_ENGINE__.probeCell(i), cellIndex);
}

async function watchCellTransition(page, cellIndex, opts = {}) {
  return page.evaluate(
    ([i, o]) => window.__PIXEL_ENGINE__.watchCellTransition(i, o),
    [cellIndex, opts]
  );
}

async function viewportTransform(page) {
  return page.evaluate(() => window.__PIXEL_ENGINE__.viewportTransform());
}

async function samplePoint(page, x, y, size = 5) {
  return page.evaluate(([a, b, s]) => window.__PIXEL_ENGINE__.samplePoint(a, b, s), [x, y, size]);
}

async function countColour(page, target, tol = 14, stride = 3) {
  return page.evaluate(
    ([t, tl, s]) => window.__PIXEL_ENGINE__.countColour(t, tl, s),
    [target, tol, stride]
  );
}

async function calibrate(page, cellIndex, opts = {}) {
  return page.evaluate(
    ([i, o]) => window.__PIXEL_ENGINE__.calibrate(i, o),
    [cellIndex, opts]
  );
}

/** Map a canvas-space point to viewport coordinates for mouse addressing. */
function toViewport(point, transform) {
  return {
    x: transform.left + point.x * transform.scaleX,
    y: transform.top + point.y * transform.scaleY,
  };
}

/** RGB triples the application publishes state with. Mirrors the page palette. */
const PALETTE = {
  loading: [128, 128, 128],
  up: [22, 163, 74],
  down: [220, 38, 38],
  armed: [168, 85, 247],
  gridline: [27, 36, 48],
  boundary: [217, 131, 36], // #d98324 - exception band
};

module.exports = {
  installPixelEngine,
  deriveGrid,
  probeCell,
  samplePoint,
  countColour,
  calibrate,
  watchCellTransition,
  viewportTransform,
  toViewport,
  PALETTE,
};
