/**
 * Q2 - Cryptographic Replay Testing, Stateful Nonces & Hash-Chain API Chaining
 * =============================================================================
 *   Q2.1  POST to mint a transaction wrapper; the id is read out of the RESPONSE
 *         HEADER, not the body.
 *   Q2.2  PUT signed with X-Frugal-Mac = HMAC-SHA512 over
 *         rawBody | microsecondTimestamp | server challenge token.
 *   Q2.3  Byte-for-byte replay of that packet within 150ms of the PUT completing.
 *   Q2.4  Assert the gateway rejects the replay (409/422). If it answers 200/201
 *         instead, raise a high-risk data-mutation vulnerability alert into the
 *         execution log - which the last test proves by running a gateway with
 *         the replay guard deliberately switched off.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { test, expect, request: playwrightRequest } = require('@playwright/test');

const { signPacket, computeMac, microsNow, tamperMac } = require('../lib/mac-signer');

const GATEWAY = 'http://127.0.0.1:4500';
const SALT = process.env.Q2_SALT || 'frugal::s4lt::sequence::7f3a91';
const REPLAY_DEADLINE_MS = 150;
const ARTIFACT_DIR = path.resolve(__dirname, '../../artifacts');

const alerts = [];

/**
 * The escalation path required by Q2.4. A duplicated success response is not a
 * test failure to be shrugged off - it means the gateway applied the same
 * mutation twice, so it is logged as a high-risk finding and written to an
 * artifact the pipeline can gate on.
 */
function raiseVulnerabilityAlert({ severity = 'HIGH-RISK', title, detail, evidence }) {
  const alert = { severity, title, detail, evidence, at: new Date().toISOString() };
  alerts.push(alert);

  // eslint-disable-next-line no-console
  console.error(
    [
      '',
      '  ################################################################',
      `  # ${severity} DATA-MUTATION VULNERABILITY`,
      `  # ${title}`,
      '  #',
      ...detail.match(/.{1,60}(\s|$)/g).map((line) => `  # ${line.trim()}`),
      '  #',
      `  # evidence: ${JSON.stringify(evidence)}`,
      '  ################################################################',
      '',
    ].join('\n')
  );
  return alert;
}

test.afterAll(() => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(ARTIFACT_DIR, 'q2-replay-alerts.json'),
    JSON.stringify({ suite: 'Q2', generatedAt: new Date().toISOString(), alerts }, null, 2)
  );
});

// ---------------------------------------------------------------------------
// Step 1 - chain a transaction out of the response headers
// ---------------------------------------------------------------------------
async function mintTransaction(api, payload) {
  const res = await api.post('/api/v1/transactions', { data: payload });
  expect(res.status(), 'POST must mint a transaction').toBe(201);

  const headers = res.headers();
  const chained = {
    id: headers['x-transaction-id'],
    challenge: headers['x-challenge-token'],
    serverTimestampUs: headers['x-server-timestamp'],
    algorithm: headers['x-mac-algorithm'],
  };

  // Every one of these has to come off the header, or there is nothing to chain.
  expect(chained.id, 'X-Transaction-Id header').toBeTruthy();
  expect(chained.challenge, 'X-Challenge-Token header').toBeTruthy();
  expect(chained.serverTimestampUs, 'X-Server-Timestamp header').toBeTruthy();
  expect(chained.algorithm).toBe('HMAC-SHA512');

  return chained;
}

// ===========================================================================
// Q2.1 - dynamic sequence chaining
// ===========================================================================

test('Q2.1 chaining: transaction id and challenge nonce are extracted from response headers', async ({
  request,
}) => {
  const chained = await mintTransaction(request, { instrument: 'LEDGER-AUD', notional: 1200.5 });

  expect(chained.id).toMatch(/^txn_[0-9a-f]{18}$/);
  expect(chained.challenge.length).toBeGreaterThanOrEqual(30);
  // Server clock in microseconds - 16 digits for any date in this era.
  expect(chained.serverTimestampUs).toMatch(/^\d{16}$/);

  // eslint-disable-next-line no-console
  console.log(`\n  chained id=${chained.id}  challenge=${chained.challenge.slice(0, 12)}...\n`);
});

// ===========================================================================
// Q2.2 - cryptographic nonce injection
// ===========================================================================

test('Q2.2 signing: an HMAC-SHA512 packet over body|micros|challenge is accepted', async ({ request }) => {
  const chained = await mintTransaction(request, { instrument: 'LEDGER-AUD', notional: 1200.5 });

  const packet = signPacket({
    payload: { notional: 1875.25, memo: 'q2 signed mutation' },
    challengeToken: chained.challenge,
    salt: SALT,
  });

  expect(packet.mac).toMatch(/^[0-9a-f]{128}$/); // SHA-512 -> 64 bytes -> 128 hex
  expect(packet.timestampMicros).toMatch(/^\d{16}$/);

  const res = await request.put(`/api/v1/transactions/${chained.id}`, {
    headers: packet.headers,
    data: packet.rawBody,
  });

  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('updated');
  expect(body.version).toBe(1);
  expect(body.payload.notional).toBe(1875.25);
});

test('Q2.2 negative: a tampered digest, a stale timestamp and missing headers are all refused', async ({
  request,
}) => {
  const chained = await mintTransaction(request, { instrument: 'LEDGER-AUD' });
  const payload = { notional: 42 };

  // (a) tampered MAC
  const good = signPacket({ payload, challengeToken: chained.challenge, salt: SALT });
  const tampered = await request.put(`/api/v1/transactions/${chained.id}`, {
    headers: { ...good.headers, 'X-Frugal-Mac': tamperMac(good.mac) },
    data: good.rawBody,
  });
  expect(tampered.status()).toBe(401);
  expect((await tampered.json()).error).toBe('E_BAD_MAC');

  // (b) timestamp outside the freshness window, correctly signed for that time
  const staleUs = (BigInt(microsNow()) - 30_000_000n).toString(); // 30s in the past
  const rawBody = JSON.stringify(payload);
  const stale = await request.put(`/api/v1/transactions/${chained.id}`, {
    headers: {
      'Content-Type': 'application/json',
      'X-Frugal-Timestamp': staleUs,
      'X-Frugal-Challenge': chained.challenge,
      'X-Frugal-Mac': computeMac({
        rawBody,
        timestampMicros: staleUs,
        challengeToken: chained.challenge,
        salt: SALT,
      }),
    },
    data: rawBody,
  });
  expect(stale.status()).toBe(401);
  expect((await stale.json()).error).toBe('E_STALE_TIMESTAMP');

  // (c) no auth headers at all
  const bare = await request.put(`/api/v1/transactions/${chained.id}`, { data: payload });
  expect(bare.status()).toBe(400);
  expect((await bare.json()).error).toBe('E_MISSING_AUTH_HEADERS');
});

// ===========================================================================
// Q2.3 + Q2.4 - the replay attack vector
// ===========================================================================

test('Q2.3 replay vector: a byte-identical packet resent inside 150ms is rejected as a replay', async ({
  request,
}) => {
  const chained = await mintTransaction(request, { instrument: 'LEDGER-AUD', notional: 500 });

  const packet = signPacket({
    payload: { notional: 990.75, memo: 'replay probe' },
    challengeToken: chained.challenge,
    salt: SALT,
  });

  // --- original ------------------------------------------------------------
  const firstRes = await request.put(`/api/v1/transactions/${chained.id}`, {
    headers: packet.headers,
    data: packet.rawBody,
  });
  const putCompletedAt = Date.now();
  expect(firstRes.status(), 'the original mutation must succeed').toBe(200);
  expect((await firstRes.json()).version).toBe(1);

  // --- replay: same headers, same timestamp, same MAC, same body bytes -----
  const replayDispatchedAt = Date.now();
  const replayRes = await request.put(`/api/v1/transactions/${chained.id}`, {
    headers: packet.headers,
    data: packet.rawBody,
  });
  const gapMs = replayDispatchedAt - putCompletedAt;

  expect(
    gapMs,
    `replay was dispatched ${gapMs}ms after the PUT completed, outside the ${REPLAY_DEADLINE_MS}ms window`
  ).toBeLessThanOrEqual(REPLAY_DEADLINE_MS);

  const status = replayRes.status();
  const body = await replayRes.json();

  // --- assertion layer -----------------------------------------------------
  if (status === 200 || status === 201) {
    raiseVulnerabilityAlert({
      title: 'Replay protection absent - duplicate mutation applied',
      detail:
        `The gateway answered HTTP ${status} to a byte-for-byte replay dispatched ${gapMs}ms after ` +
        `the original PUT. Identical timestamp and identical X-Frugal-Mac were accepted twice, so the ` +
        `same signed mutation was committed more than once. In a payment path this is a double-spend.`,
      evidence: { transaction: chained.id, status, gapMs, version: body.version },
    });
  }

  expect(
    [409, 422],
    `replay answered HTTP ${status}: ${JSON.stringify(body)}`
  ).toContain(status);
  expect(body.error).toBe('E_REPLAY_DETECTED');
  expect(body.replayGapMs).toBeLessThanOrEqual(REPLAY_DEADLINE_MS + 50);

  // The mutation must not have been applied a second time.
  const audit = await (await request.get('/api/v1/_audit')).json();
  expect(audit.replaysBlocked).toBeGreaterThan(0);
  expect(audit.replaysLeaked).toBe(0);

  // eslint-disable-next-line no-console
  console.log(
    `\n  replay dispatched +${gapMs}ms -> HTTP ${status} ${body.error} (blocked ${audit.replaysBlocked})\n`
  );
});

test('Q2.4 escalation: an unguarded gateway triggers the high-risk vulnerability alert', async () => {
  const port = 4501;
  const child = spawn(process.execPath, [path.resolve(__dirname, '../server/mock-gateway.js')], {
    env: { ...process.env, Q2_PORT: String(port), Q2_REPLAY_GUARD: 'off' },
    stdio: 'ignore',
  });

  const api = await playwrightRequest.newContext({ baseURL: `http://127.0.0.1:${port}` });

  try {
    // Wait for the child to bind by probing it, not by sleeping on a guess.
    await expect
      .poll(
        async () => {
          try {
            const res = await api.get('/healthz');
            return res.ok() ? (await res.json()).replayGuard : null;
          } catch {
            return null;
          }
        },
        { timeout: 20_000, intervals: [100, 200] }
      )
      .toBe('off');

    const chained = await mintTransaction(api, { instrument: 'LEDGER-AUD' });
    const packet = signPacket({
      payload: { notional: 250, memo: 'unguarded replay' },
      challengeToken: chained.challenge,
      salt: SALT,
    });

    const first = await api.put(`/api/v1/transactions/${chained.id}`, {
      headers: packet.headers,
      data: packet.rawBody,
    });
    const putCompletedAt = Date.now();
    expect(first.status()).toBe(200);

    const replay = await api.put(`/api/v1/transactions/${chained.id}`, {
      headers: packet.headers,
      data: packet.rawBody,
    });
    const gapMs = Date.now() - putCompletedAt;
    const body = await replay.json();

    // This gateway is knowingly unguarded, so the duplicated success is the
    // expected observation - and the alert is the deliverable.
    expect(replay.status()).toBe(200);
    expect(body.version).toBe(2); // the same signed mutation committed twice

    const alert = raiseVulnerabilityAlert({
      title: 'Replay protection absent - duplicate mutation applied (guard disabled)',
      detail:
        `Gateway on :${port} answered HTTP 200 to a byte-for-byte replay sent ${gapMs}ms after the ` +
        `original PUT and incremented the record to version ${body.version}. The identical ` +
        `X-Frugal-Mac and timestamp were honoured twice.`,
      evidence: { port, status: replay.status(), gapMs, version: body.version },
    });

    expect(alert.severity).toBe('HIGH-RISK');
    expect(alerts.some((a) => a.evidence.port === port)).toBe(true);

    const audit = await (await api.get('/api/v1/_audit')).json();
    expect(audit.replaysLeaked).toBe(1);
  } finally {
    await api.dispose();
    child.kill();
  }
});
