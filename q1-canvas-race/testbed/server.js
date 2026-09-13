/**
 * Q1 Testbed - Canvas Streaming Terminal (target application under test)
 * ---------------------------------------------------------------------
 * Why a local testbed: production canvas terminals (TradingView et al.) wrap their
 * feeds in proprietary protocols behind anti-bot layers, so the WebSocket frames
 * cannot be intercepted or mutated. This server exposes the same shape of problem
 * over a plain ws:// socket so the interception, jitter and corruption specs in Q1
 * are actually testable.
 *
 * Contract:
 *   HTTP  GET /            -> canvas terminal page (zero DOM widgets, pixels only)
 *   WS    /stream          -> JSON tick frames, monotonically increasing `seq`
 *
 * Frame shape:
 *   { seq, ts, cell, dir: 'up'|'down', price, balance, resubscribe? }
 *
 * `resubscribe: true` is the state drift the question is named after: the upstream
 * feed re-subscribes the cell, which drops it back to the gray loading threshold
 * and discards any interaction state attached to it. It recurs, so the terminal
 * produces a fresh gray->active transition every few seconds rather than settling
 * once and staying settled.
 */

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.Q1_PORT || 4400);

// Grid geometry is duplicated in the client; kept here so the feed only ever
// addresses cells that actually exist.
const GRID_COLS = 6;
const GRID_ROWS = 3;
const CELL_COUNT = GRID_COLS * GRID_ROWS;

// Cell 7 (row 1, col 1) is the interaction target for the race-injection spec.
// It is deliberately held back until tick 4 so the pixel engine has a real
// gray->active transition to latch onto rather than a state that has already
// settled - and so that transition lands *inside* the injected Fibonacci ladder
// rather than after it has drained.
const TARGET_CELL = 7;
const TARGET_ACTIVATION_TICK = 4;

// After the first activation the feed re-subscribes the target cell every 8 ticks
// (2s) and re-activates it 2 ticks later, so the gray->active transition recurs.
const RESUBSCRIBE_PERIOD_TICKS = 8;
const REACTIVATION_OFFSET_TICKS = 2;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (_req, res) => res.json({ ok: true, port: PORT }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (socket) => {
  let seq = 0;
  let balance = 48250.75;
  let price = 1840.5;

  // Deterministic pseudo-random so reruns are reproducible enough to debug.
  let rngState = 0x2f6e2b1;
  const rand = () => {
    rngState ^= rngState << 13;
    rngState ^= rngState >>> 17;
    rngState ^= rngState << 5;
    return ((rngState >>> 0) % 10000) / 10000;
  };

  const emit = () => {
    if (socket.readyState !== socket.OPEN) return;
    seq += 1;

    // Walk the grid, but hold the target cell back until the activation tick,
    // then drive it through a repeating resubscribe -> reactivate cycle.
    let cell;
    let resubscribe = false;

    const sinceActivation = seq - TARGET_ACTIVATION_TICK;
    const phase = sinceActivation > 0 ? sinceActivation % RESUBSCRIBE_PERIOD_TICKS : -1;

    if (seq === TARGET_ACTIVATION_TICK) {
      cell = TARGET_CELL;
    } else if (phase === 0) {
      cell = TARGET_CELL;
      resubscribe = true;
    } else if (phase === REACTIVATION_OFFSET_TICKS) {
      cell = TARGET_CELL;
    } else {
      cell = Math.floor(rand() * CELL_COUNT);
      if (cell === TARGET_CELL) cell = (cell + 1) % CELL_COUNT;
    }

    const drift = (rand() - 0.5) * 12;
    price = Math.max(1, price + drift);
    balance = Math.max(0, balance + drift * 3);

    socket.send(
      JSON.stringify({
        seq,
        ts: Date.now(),
        cell,
        resubscribe,
        dir: drift >= 0 ? 'up' : 'down',
        price: Number(price.toFixed(2)),
        balance: Number(balance.toFixed(2)),
      })
    );
  };

  const timer = setInterval(emit, 250);
  emit();

  socket.on('close', () => clearInterval(timer));
  socket.on('error', () => clearInterval(timer));
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[q1-testbed] canvas terminal  http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`[q1-testbed] tick stream      ws://localhost:${PORT}/stream`);
});

module.exports = { server, PORT, TARGET_CELL, GRID_COLS, GRID_ROWS };
