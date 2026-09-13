/**
 * Mismatched server boundary checking (Q1.4)
 *
 * Mutates the intercepted frame *as raw text* rather than parse -> edit ->
 * re-serialise. That distinction matters: `JSON.stringify(1e7)` collapses to
 * `10000000`, so re-serialising would never put scientific notation on the wire.
 * Splicing the string keeps the literal `1e+7` in the frame exactly as a
 * misbehaving upstream service would emit it.
 *
 * Three vectors, deliberately chosen to include one control case:
 *
 *   NON_NUMERIC  "balance":"NaN"                -> control; the app's guard
 *                                                  SHOULD reject this, proving a
 *                                                  boundary mechanism exists
 *   SCIENTIFIC   "balance":1e+7                 -> magnitude bypass; valid JSON,
 *                                                  parses to 10000000
 *   FRACTIONAL   "balance":0.30000000000000004  -> precision bypass; float
 *                                                  artefact in a currency field
 *
 * If the two bypass vectors are accepted while the control is rejected, the
 * finding is precise: the boundary is present but incomplete - it type-checks
 * and does not range-check.
 */

const VECTORS = {
  NON_NUMERIC: { literal: '"NaN"', label: 'non-numeric string', expectRejection: true },
  SCIENTIFIC: { literal: '1e+7', label: 'scientific notation magnitude', expectRejection: true },
  FRACTIONAL: { literal: '0.30000000000000004', label: 'binary float precision artefact', expectRejection: true },
};

const BALANCE_RE = /"balance"\s*:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|"[^"]*")/;

class PayloadCorruptor {
  constructor() {
    this.armedVector = null;
    this.mutations = [];
  }

  /** Arm a vector; the next intercepted frame carrying a balance gets rewritten. */
  arm(vectorName) {
    if (!VECTORS[vectorName]) {
      throw new Error(`unknown corruption vector: ${vectorName}`);
    }
    this.armedVector = vectorName;
    return VECTORS[vectorName];
  }

  disarm() {
    this.armedVector = null;
  }

  /**
   * @param {string} raw the intercepted frame text
   * @returns {string} the frame to forward to the page
   */
  apply(raw) {
    if (!this.armedVector || typeof raw !== 'string') return raw;
    if (!BALANCE_RE.test(raw)) return raw;

    const vector = VECTORS[this.armedVector];
    const before = raw.match(BALANCE_RE)[1];
    const mutated = raw.replace(BALANCE_RE, `"balance":${vector.literal}`);

    this.mutations.push({
      vector: this.armedVector,
      label: vector.label,
      replaced: before,
      injected: vector.literal,
      at: Date.now(),
      wire: mutated.slice(0, 160),
    });

    // One-shot: fire per arm() so each assertion owns exactly one mutated frame.
    this.armedVector = null;
    return mutated;
  }

  get lastMutation() {
    return this.mutations[this.mutations.length - 1] || null;
  }
}

module.exports = { PayloadCorruptor, VECTORS };
