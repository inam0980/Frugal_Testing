/**
 * Client-side request signer for the Q2 gateway.
 *
 * The MAC contract, reproduced from the gateway:
 *   mac = HMAC_SHA512(
 *           key     = SHARED_SALT,
 *           message = rawRequestBody + "|" + timestampMicros + "|" + challengeToken
 *         ).hex()
 *
 * Two details that are easy to get wrong and break verification silently:
 *
 * 1. The digest is taken over the *exact bytes sent on the wire*. So the body is
 *    serialised once, here, and that same string is both hashed and transmitted.
 *    Handing an object to the HTTP client and letting it serialise separately
 *    would re-order keys or change whitespace and invalidate the MAC.
 *
 * 2. A "microsecond timestamp" has to be wall-clock anchored, because the server
 *    range-checks it for freshness. `process.hrtime.bigint()` alone is monotonic
 *    but has an arbitrary origin, and `Date.now()` alone has only millisecond
 *    resolution. So the clock below anchors hrtime's monotonic delta to a single
 *    Date.now() reading taken at module load.
 */

const crypto = require('crypto');

const ORIGIN_MS = Date.now();
const ORIGIN_NS = process.hrtime.bigint();

/** Wall-clock-anchored microsecond timestamp, as a decimal string. */
function microsNow() {
  const elapsedNs = process.hrtime.bigint() - ORIGIN_NS;
  return (BigInt(ORIGIN_MS) * 1000n + elapsedNs / 1000n).toString();
}

function computeMac({ rawBody, timestampMicros, challengeToken, salt }) {
  return crypto
    .createHmac('sha512', salt)
    .update(`${rawBody}|${timestampMicros}|${challengeToken}`)
    .digest('hex');
}

/**
 * Build a fully signed, replayable packet.
 *
 * The returned object is the *complete* packet - identical headers and identical
 * body bytes. Sending it twice is therefore a byte-for-byte replay, which is
 * exactly what the attack vector requires; nothing is regenerated on the second
 * send.
 */
function signPacket({ payload, challengeToken, salt, timestampMicros = microsNow() }) {
  const rawBody = JSON.stringify(payload);
  const mac = computeMac({ rawBody, timestampMicros, challengeToken, salt });

  return {
    rawBody,
    timestampMicros,
    mac,
    headers: {
      'Content-Type': 'application/json',
      'X-Frugal-Mac': mac,
      'X-Frugal-Timestamp': timestampMicros,
      'X-Frugal-Challenge': challengeToken,
    },
  };
}

/** Flip one hex nibble - produces a structurally valid but wrong digest. */
function tamperMac(mac) {
  const head = mac.slice(0, -1);
  const last = mac.slice(-1);
  const swapped = last === '0' ? '1' : '0';
  return head + swapped;
}

module.exports = { microsNow, computeMac, signPacket, tamperMac };
