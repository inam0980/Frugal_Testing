# Q2 — Cryptographic Replay Testing, Stateful Nonces & Hash-Chain API Chaining

```bash
npm run q2:test      # 5 tests
npm run q2:server    # serve the gateway by hand at :4500
```

---

## Why a local gateway

`restful-booker.herokuapp.com` issues no cryptographic challenge nonce, verifies no
custom MAC header, and enforces no replay window. There is nothing there for this
question's assertions to bite on — a replay test against it would pass trivially and
prove nothing. So `server/mock-gateway.js` exposes the three mechanisms explicitly,
which the brief requires.

The gateway is a real implementation, not a stub: it verifies digests in constant
time, range-checks timestamp freshness, and keeps a replay ledger.

| Endpoint | Behaviour |
|---|---|
| `POST /api/v1/transactions` | `201`; id, challenge token and server timestamp in **response headers** |
| `PUT /api/v1/transactions/:id` | `200` first time, `409` on replay |
| `GET /api/v1/_audit` | server-side view of what it accepted, blocked and leaked |
| `GET /healthz` | liveness + current guard state |

---

## The MAC contract

```
mac = HMAC_SHA512(
        key     = SHARED_SALT,
        message = rawRequestBody + "|" + timestampMicros + "|" + challengeToken
      ).hex()
```

Sent as `X-Frugal-Mac`, alongside `X-Frugal-Timestamp` and `X-Frugal-Challenge`.

Binding the challenge token into the digest is what makes the nonce load-bearing: a
MAC captured from one transaction cannot be replayed against another, because the
challenge differs and the digest will not verify.

### Two details that break verification silently

**The digest covers the exact bytes on the wire.** `lib/mac-signer.js` serialises the
body once and both hashes and transmits *that string*. Handing an object to the HTTP
client and letting it serialise separately would re-order keys or change whitespace
and invalidate the MAC — with a `401` that looks like a key problem. The gateway
mirrors this with `express.json({ verify })`, capturing `req.rawBody` before parsing,
because re-serialising the parsed object server-side has the same failure.

**A "microsecond timestamp" has to be wall-clock anchored**, because the server
range-checks it for freshness. `process.hrtime.bigint()` alone is monotonic but has an
arbitrary origin — every request would look decades stale. `Date.now()` alone has only
millisecond resolution. So the clock anchors hrtime's monotonic delta to a single
`Date.now()` reading taken at module load:

```js
const ORIGIN_MS = Date.now();
const ORIGIN_NS = process.hrtime.bigint();
const microsNow = () =>
  (BigInt(ORIGIN_MS) * 1000n + (process.hrtime.bigint() - ORIGIN_NS) / 1000n).toString();
```

---

## The replay vector

`signPacket()` returns the **complete** packet — identical headers, identical body
bytes. Sending it twice is a byte-for-byte replay; nothing is regenerated on the
second send, which is what the vector requires.

```
POST  /api/v1/transactions            -> 201  (id + challenge from headers)
PUT   /api/v1/transactions/txn_...    -> 200  version 1
PUT   (identical packet, +0..3ms)     -> 409  E_REPLAY_DETECTED
```

The replay key is the `(transaction, timestamp, mac)` triple. `Q2.3` asserts the
dispatch gap is within the 150 ms deadline, the status is `409` or `422`, and the
audit confirms `replaysBlocked > 0` with `replaysLeaked: 0` — the mutation was not
applied a second time.

## Negative coverage

Replay rejection means little if the MAC is not actually being verified. `Q2.2
negative` proves the gateway is not just pattern-matching headers:

| Vector | Result |
|---|---|
| one hex nibble flipped in the digest | `401 E_BAD_MAC` |
| timestamp 30 s in the past, correctly signed *for that time* | `401 E_STALE_TIMESTAMP` |
| no auth headers at all | `400 E_MISSING_AUTH_HEADERS` |

The stale-timestamp case matters most: the MAC is valid, so only the freshness window
rejects it. A gateway that accepted it would have a MAC valid for all time.

---

## The escalation path

The brief requires that a duplicated success response raise a high-risk
data-mutation alert in the execution logs. Asserting that path exists is not the same
as proving it fires, so `Q2.4` spawns a second gateway with
`Q2_REPLAY_GUARD=off`, runs the same flow, and observes the failure:

```
################################################################
# HIGH-RISK DATA-MUTATION VULNERABILITY
# Replay protection absent - duplicate mutation applied (guard disabled)
#
# Gateway on :4501 answered HTTP 200 to a byte-for-byte replay
# sent 3ms after the original PUT and incremented the record
# to version 2. The identical X-Frugal-Mac and timestamp were
# honoured twice.
#
# evidence: {"port":4501,"status":200,"gapMs":3,"version":2}
################################################################
```

`version: 2` off a single signed mutation is the whole point — in a payment path that
is a double-spend. Alerts are also written to `artifacts/q2-replay-alerts.json` so a
pipeline can gate on the file rather than on log scraping.

The child gateway is waited on by **probing `/healthz`**, not by sleeping on a guess
about process startup time.
