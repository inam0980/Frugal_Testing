/**
 * Q2 Mock Gateway - challenge nonces, HMAC-SHA512 verification, replay rejection
 * -----------------------------------------------------------------------------
 * Why this exists: restful-booker.herokuapp.com and the other public playground
 * APIs issue no challenge nonce, verify no custom MAC header and enforce no
 * replay window, so there is nothing there for Q2's assertions to bite on. This
 * gateway exposes those three mechanisms explicitly.
 *
 * Endpoints
 *   GET  /healthz
 *   POST /api/v1/transactions          -> 201, transaction id + challenge in HEADERS
 *   PUT  /api/v1/transactions/:id      -> 200 first time, 409 on replay
 *   GET  /api/v1/_audit                -> server-side view of what it accepted
 *
 * MAC contract (must be reproduced exactly by the client)
 *   mac = HMAC_SHA512(
 *           key     = SHARED_SALT,
 *           message = rawRequestBody + "|" + timestampMicros + "|" + challengeToken
 *         ).hex()
 *
 * Required headers on PUT
 *   X-Frugal-Mac         hex digest above
 *   X-Frugal-Timestamp   microsecond timestamp used in the digest
 *   X-Frugal-Challenge   the challenge token issued by the POST
 *
 * Replay guard can be disabled to exercise the failure branch of the suite:
 *   Q2_REPLAY_GUARD=off node q2-replay-hmac/server/mock-gateway.js
 */

const crypto = require('crypto');
const express = require('express');

const PORT = Number(process.env.Q2_PORT || 4500);
const SHARED_SALT = process.env.Q2_SALT || 'frugal::s4lt::sequence::7f3a91';
const REPLAY_GUARD = (process.env.Q2_REPLAY_GUARD || 'on').toLowerCase() !== 'off';
const CLOCK_SKEW_TOLERANCE_US = 5_000_000; // 5s expressed in microseconds

const app = express();
app.use(
  express.json({
    // The MAC is computed over the exact bytes on the wire. Re-serialising the
    // parsed object would change key order / whitespace and break verification,
    // so the raw body is captured here and used verbatim.
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);

/** @type {Map<string, {id:string, challenge:string, issuedAt:number, serverTsUs:string, version:number, consumedChallenges:Set<string>}>} */
const transactions = new Map();

/** Replay ledger: every (id, timestamp, mac) triple the gateway has honoured. */
const macLedger = new Map();

const audit = { accepted: [], rejected: [], replaysBlocked: 0, replaysLeaked: 0 };

const microsNow = () => (BigInt(Date.now()) * 1000n).toString();

function signature(rawBody, timestampMicros, challengeToken) {
  return crypto
    .createHmac('sha512', SHARED_SALT)
    .update(`${rawBody}|${timestampMicros}|${challengeToken}`)
    .digest('hex');
}

function constantTimeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

app.get('/healthz', (_req, res) =>
  res.json({ ok: true, port: PORT, replayGuard: REPLAY_GUARD ? 'on' : 'off' })
);

// ---------------------------------------------------------------------------
// Step 1 - transaction wrapper. Id and challenge are returned in the RESPONSE
// HEADERS, not the body, so the client has to read the header to chain.
// ---------------------------------------------------------------------------
app.post('/api/v1/transactions', (req, res) => {
  const id = `txn_${crypto.randomBytes(9).toString('hex')}`;
  const challenge = crypto.randomBytes(24).toString('base64url');
  const serverTsUs = microsNow();

  transactions.set(id, {
    id,
    challenge,
    issuedAt: Date.now(),
    serverTsUs,
    version: 0,
    consumedChallenges: new Set(),
    payload: req.body || {},
  });

  res
    .status(201)
    .set({
      'X-Transaction-Id': id,
      'X-Challenge-Token': challenge,
      'X-Server-Timestamp': serverTsUs,
      'X-Mac-Algorithm': 'HMAC-SHA512',
      'X-Mac-Message-Format': 'rawBody|timestampMicros|challengeToken',
    })
    .json({ status: 'created', hint: 'transaction id and challenge token are in the response headers' });
});

// ---------------------------------------------------------------------------
// Step 2/3 - authenticated mutation, with replay rejection
// ---------------------------------------------------------------------------
app.put('/api/v1/transactions/:id', (req, res) => {
  const { id } = req.params;
  const mac = req.get('X-Frugal-Mac');
  const timestampUs = req.get('X-Frugal-Timestamp');
  const challenge = req.get('X-Frugal-Challenge');

  const reject = (status, code, detail) => {
    audit.rejected.push({ id, code, detail, at: Date.now() });
    return res.status(status).json({ error: code, detail });
  };

  const txn = transactions.get(id);
  if (!txn) return reject(404, 'E_UNKNOWN_TRANSACTION', `no transaction ${id}`);
  if (!mac || !timestampUs || !challenge) {
    return reject(400, 'E_MISSING_AUTH_HEADERS', 'X-Frugal-Mac, X-Frugal-Timestamp and X-Frugal-Challenge are all required');
  }
  if (!constantTimeEqual(challenge, txn.challenge)) {
    return reject(401, 'E_BAD_CHALLENGE', 'challenge token does not match the one issued for this transaction');
  }

  // Freshness: a MAC valid for all time is not much of a defence.
  const skewUs = Math.abs(Number(microsNow()) - Number(timestampUs));
  if (!Number.isFinite(skewUs) || skewUs > CLOCK_SKEW_TOLERANCE_US) {
    return reject(401, 'E_STALE_TIMESTAMP', `timestamp skew ${Math.round(skewUs / 1000)}ms exceeds tolerance`);
  }

  const expected = signature(req.rawBody || '', timestampUs, challenge);
  if (!constantTimeEqual(mac, expected)) {
    return reject(401, 'E_BAD_MAC', 'HMAC-SHA512 verification failed');
  }

  // ---- replay detection ---------------------------------------------------
  const replayKey = `${id}:${timestampUs}:${mac}`;
  const seen = macLedger.get(replayKey);

  if (seen) {
    if (REPLAY_GUARD) {
      audit.replaysBlocked += 1;
      audit.rejected.push({ id, code: 'E_REPLAY_DETECTED', at: Date.now() });
      return res.status(409).json({
        error: 'E_REPLAY_DETECTED',
        detail: 'this (transaction, timestamp, mac) triple has already been honoured',
        firstAcceptedAt: seen.at,
        replayGapMs: Date.now() - seen.at,
      });
    }
    // Guard intentionally disabled - the suite must catch this and escalate.
    audit.replaysLeaked += 1;
    txn.version += 1;
    return res.status(200).json({
      status: 'updated',
      version: txn.version,
      warning: 'replay guard disabled - duplicate mutation applied',
    });
  }

  macLedger.set(replayKey, { at: Date.now() });
  txn.consumedChallenges.add(challenge);
  txn.version += 1;
  txn.payload = { ...txn.payload, ...(req.body || {}) };

  audit.accepted.push({ id, version: txn.version, at: Date.now() });

  return res.status(200).json({
    status: 'updated',
    id,
    version: txn.version,
    payload: txn.payload,
  });
});

app.get('/api/v1/_audit', (_req, res) =>
  res.json({
    replayGuard: REPLAY_GUARD ? 'on' : 'off',
    transactions: transactions.size,
    ledgerEntries: macLedger.size,
    ...audit,
  })
);

const server = app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[q2-gateway] listening        http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`[q2-gateway] replay guard     ${REPLAY_GUARD ? 'ON (409 on replay)' : 'OFF (vulnerable mode)'}`);
});

module.exports = { app, server, PORT, SHARED_SALT, signature };
