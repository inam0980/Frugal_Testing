# Q3 — Sealed Closed-Boundary Shadow DOM Pathfinding

Two deliverables:

- **this file** — the shadow-piercing strategy, with the working implementation in
  `lib/shadow-piercer.js` and the proof in `tests/shadow-pathfinding.spec.js`
- **`COT-SYSTEM-PROMPT.md`** — the prompt-architecture task

```bash
npm run q3:test
```

---

## 1. The problem, stated precisely

The boundary from the brief:

```html
<enterprise-portal id="root-gateway">
  #shadow-root (open)
    <payment-terminal class="obfuscated_v4_x89a">
      #shadow-root (closed)          <-- this is the wall
        <security-sandbox id="iframe-sandbox-wrapper">
          #shadow-root (open)
            <button class="trigger-finalize" data-qa-state="unlocked-token">
              Authorize Ledger Funds
            </button>
```

Two independent difficulties, which need separate answers:

**(a) The closed root is not addressable.** `element.shadowRoot` returns `null` for a
root created with `{ mode: 'closed' }`. This is not obscurity — the reference is
genuinely not exposed. A recursive `.shadowRoot` walk terminates at
`<payment-terminal>` and can never see anything beneath it. No selector reaches
past it either: Playwright's auto-piercing locators pierce *open* roots only.

`tests/shadow-pathfinding.spec.js` asserts this rather than assuming it — `Q3.1`
measures the naive walk reaching depth 1 (`document → enterprise-portal`), finding
one button, and confirms `page.locator('button[data-qa-state="unlocked-token"]')`
counts **0**.

**(b) Every identifier churns.** `obfuscated_v4_x89a` regenerates on each render. So
even once you are inside, any locator keyed on a class, an id, or a generated test
hook is dead on the next paint. The testbed models this at its worst: class strings
**and** ids are regenerated on load *and* rewritten every 1.5 s.

---

## 2. Strategy for (a): capture at construction, not at query time

A closed root is unreachable *afterwards* — but it has to be **created**, and there
is exactly one way to create it. Wrapping `Element.prototype.attachShadow` before
any component code runs records every root, open or closed, as it is constructed:

```js
const registry = [];
const native = Element.prototype.attachShadow;

Element.prototype.attachShadow = function (init) {
  const root = native.call(this, init);
  registry.push({ host: this, root, mode: init?.mode ?? 'open' });
  return root;
};
```

Traversal then walks `registry` instead of the `.shadowRoot` property, and the
closed boundary stops mattering.

**Ordering is the entire technique.** The patch must be installed before the first
`customElements.define` callback fires. Install it late and you get an empty
registry and a confusing, intermittent failure.

| Environment | Injection point |
|---|---|
| Playwright | `page.addInitScript(fn)` — runs before any page script, and re-runs on every navigation |
| Selenium (CDP) | `Page.addScriptToEvaluateOnNewDocument` |
| Browser extension | content script at `"run_at": "document_start"` |
| Application build | a pre-init module imported ahead of the component bundle |

`Q3.2` asserts all three roots are captured in construction order, and that the
middle one reports `shadowRootVisibleFromOutside: false` — the capture was
necessary, not incidental.

### Limits, stated honestly

This is instrumentation, not an exploit, and it has real boundaries:

- **It cannot retrofit.** A root created before the patch is installed is lost for
  good. There is no recovery path.
- **It does not cross iframes.** Each document has its own `Element.prototype`, so
  the patch must be injected per frame. `addInitScript` does this automatically;
  a hand-rolled injector must walk frames itself.
- **It is detectable.** `Element.prototype.attachShadow.toString()` no longer
  returns native code. An application that actively defends against
  instrumentation can notice. Against *encapsulation* it works; against a
  deliberate anti-tamper check it is a starting point, not a finish.
- **It mutates a global prototype.** Acceptable in a test harness. It does not
  belong in production code.

### If you cannot inject early

Fallbacks, in descending order of preference — and all of them are worse:

1. **Ask the application.** Many design systems expose a debug handle
   (`window.__COMPONENTS__`, a `ref` registry). Cheapest and most stable when it exists.
2. **Drive the platform accessibility tree**, which is flattened across shadow
   boundaries by the browser itself and needs no piercing at all. In Playwright this
   is `locator.getByRole()` plus `_snapshotForAI`; at OS level it is UIA / AT-SPI2 /
   NSAccessibility. This is the most robust option and is why Q3's second half is
   built on it.
3. **Synthesise real input at coordinates** derived from a reliable anchor. Works,
   but reintroduces the geometric fragility Q1 exists to demonstrate.
4. **Ask for `mode: 'open'` in a test build.** Not a technique, but frequently the
   correct engineering answer: encapsulation the harness must defeat on every run
   is a testability defect, and the cheapest fix is upstream.

---

## 3. Strategy for (b): key on semantics, not on cosmetics

Once inside, the locator has to survive churn. The rule that follows from the threat
model: **key only on facts the application cannot change without changing its
meaning.**

| Used | Why it survives |
|---|---|
| custom element tag names | registered with `customElements`; renaming one is a breaking API change |
| shadow boundary depth | structural, and changes only with a real component refactor |
| computed ARIA role | semantic contract; changing it changes assistive-technology behaviour |
| accessible name, `aria-label` first | authored intent, not a rendering artefact |
| `aria-live` / `role=status` regions | the app's own outcome-announcement channel |

| Refused | Why |
|---|---|
| class strings | regenerated every render — the stated threat |
| ids | same, in this testbed |
| absolute XPath | breaks on any DOM insertion, and cannot express a shadow boundary |
| nth-child / position | breaks on reorder |
| `data-*` test hooks | churn with the build; also absent from hardened third-party components |
| visible text as the primary key | ambiguous — see below |

A derived path is therefore the host chain plus role and accessible name:

```json
{
  "hostChain": ["enterprise-portal", "payment-terminal", "security-sandbox"],
  "role": "button",
  "name": "Authorize Ledger Funds",
  "nameFrom": "aria-label",
  "boundaryDepth": 3
}
```

`Q3.4` snapshots the volatile class and id, waits for the page to rotate them,
re-resolves the same path, and asserts it still matches **exactly one** node —
`onExpectedChain: 1`. The host chain is validated alongside the target, so a control
that still matches by role but has moved to a different boundary is reported rather
than silently accepted.

### Why visible text cannot be the primary key

The testbed places a decoy in the outer open root with the **identical** visible
text `"Authorize Ledger Funds"`, marked `aria-hidden="true"` and `disabled`. A
text-content match, a `:has-text()` selector, or an LLM reading the rendered page
finds the decoy first — it is shallower and appears earlier in document order.

Resolution therefore runs an exposure filter before any name comparison
(`isInAccessibilityTree()`: walks up through shadow hosts checking `aria-hidden`,
`hidden`, `display:none`, `visibility:hidden`). `Q3.3` asserts the decoy is **seen
and explicitly rejected** with `reason: "not exposed to the accessibility tree"` —
a discard log, not a silent miss. That distinction matters: it is the difference
between a locator that is correct and one that is lucky.

Text still appears as the last tier of accessible-name computation, because that is
what the ARIA accname algorithm specifies. But `nameFrom` is always recorded, and a
name sourced from `contents` caps confidence — the same rule the CoT prompt enforces
at Stage 3.

### Verification through the accessibility tree

A resilient locator is only half of it: the *confirmation* has to be resilient too.
Asserting on a class change re-imports the fragility you just removed.

The target's only externally observable effect is an `aria-live="assertive"`
announcement. `Q3.4` activates the control through its platform default action and
asserts on that announcement — `"Ledger authorization committed (ref 1)"`, atomic,
at depth 3. The application's own accessibility contract is the assertion surface.

---

## 4. Test results

```
Q3.1  baseline       naive walk reached depth 1 (document -> enterprise-portal),
                     found 1 button (the decoy); CSS piercing count 0
Q3.2  capture        enterprise-portal(open) > payment-terminal(closed) > security-sandbox(open)
                     closed root: shadowRootVisibleFromOutside = false
Q3.3  resolution     role=button name="Authorize Ledger Funds" at depth 3 via aria-label
                     1 candidate rejected: decoy at depth 1, not exposed
Q3.4  resilience     class trigger_kv6p7c -> trigger_ay7n0d, id rotated
                     path still resolves to exactly 1 node
                     aria-live: "Ledger authorization committed (ref 1)" (assertive, depth 3)

4 passed
```
