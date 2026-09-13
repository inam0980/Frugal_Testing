/**
 * Q3 - Sealed Closed-Boundary Shadow DOM Pathfinding & Accessibility Tree
 * =============================================================================
 * Four things are proved here, in order:
 *
 *   1. The naive baseline genuinely fails. Recursive `.shadowRoot` traversal
 *      stops dead at the closed boundary - asserted, not asserted from memory.
 *   2. Patching `attachShadow` before the components register captures every
 *      root, closed ones included, and reaches the sealed target.
 *   3. Resolving by ARIA role + accessible name picks the real control and
 *      rejects the aria-hidden decoy that carries identical visible text.
 *   4. The derived path survives obfuscation churn: class strings and ids are
 *      rewritten every 1.5s, and the same path still resolves to one node.
 */

const path = require('path');
const { test, expect } = require('@playwright/test');
const { installShadowPiercer } = require('../lib/shadow-piercer');

const PORTAL = `file://${path.resolve(__dirname, '../testbed/sealed-portal.html').replace(/\\/g, '/')}`;
const TARGET = { role: 'button', name: 'Authorize Ledger Funds' };

async function openPortal(page, { withPiercer = true } = {}) {
  // Ordering is the entire technique: the patch has to be in place before the
  // first customElements callback runs, so it goes in as an init script.
  if (withPiercer) await page.addInitScript(installShadowPiercer);
  await page.goto(PORTAL);
  await expect
    .poll(async () => page.evaluate(() => typeof window.__PORTAL_STATE__ === 'function'), {
      timeout: 10_000,
    })
    .toBe(true);
}

// ===========================================================================

test('Q3.1 baseline: recursive .shadowRoot traversal cannot cross the closed boundary', async ({
  page,
}) => {
  await openPortal(page);

  const naive = await page.evaluate(() => window.__SHADOW_PIERCER__.naiveShadowWalk('button'));

  // It reaches the outer open root (depth 1) and stops: payment-terminal's root
  // is closed, so `el.shadowRoot` is null and there is nothing to recurse into.
  expect(naive.deepestDepth).toBe(1);
  expect(naive.visited.map((v) => v.scope)).toEqual(['document', 'enterprise-portal']);

  // The only button it can see is the decoy.
  expect(naive.found).toBe(1);

  // Playwright's own piercing locators fail for the same structural reason.
  const piercingCount = await page.locator('button[data-qa-state="unlocked-token"]').count();
  expect(piercingCount, 'CSS cannot pierce a closed root either').toBe(0);

  // eslint-disable-next-line no-console
  console.log(
    `\n  naive walk reached depth ${naive.deepestDepth} (${naive.visited
      .map((v) => v.scope)
      .join(' -> ')}) and found ${naive.found} button (the decoy)\n`
  );
});

test('Q3.2 capture: patching attachShadow records the closed root and reaches the target', async ({
  page,
}) => {
  await openPortal(page);

  const roots = await page.evaluate(() => window.__SHADOW_PIERCER__.roots());

  expect(roots).toHaveLength(3);
  expect(roots.map((r) => `${r.hostTag}:${r.mode}`)).toEqual([
    'enterprise-portal:open',
    'payment-terminal:closed',
    'security-sandbox:open',
  ]);

  // The closed root is the one the browser refuses to hand back.
  const closed = roots.find((r) => r.mode === 'closed');
  expect(closed.shadowRootVisibleFromOutside).toBe(false);
  expect(roots.filter((r) => r.mode === 'open').every((r) => r.shadowRootVisibleFromOutside)).toBe(true);

  // With the registry, all three buttons across all three boundaries are visible.
  const buttonCount = await page.evaluate(() =>
    window.__SHADOW_PIERCER__.queryDeep("el => el.tagName === 'BUTTON'")
  );
  expect(buttonCount).toBe(2); // decoy + real target

  // eslint-disable-next-line no-console
  console.log(
    `\n  captured roots: ${roots.map((r) => `${r.hostTag}(${r.mode})`).join(' > ')}\n`
  );
});

test('Q3.3 accessibility resolution: role + accessible name selects the real control, not the decoy', async ({
  page,
}) => {
  await openPortal(page);

  const resolution = await page.evaluate(
    ([role, name]) => window.__SHADOW_PIERCER__.findByRole(role, name),
    [TARGET.role, TARGET.name]
  );

  // Exactly one exposed match, at the deepest boundary, named by aria-label.
  expect(resolution.matches).toHaveLength(1);
  expect(resolution.matches[0].nameFrom).toBe('aria-label');
  expect(resolution.matches[0].depth).toBe(3);
  expect(resolution.matches[0].hostTag).toBe('security-sandbox');

  // The decoy carries the same visible text and was rejected on accessibility
  // exposure, not on anything cosmetic.
  const decoy = resolution.rejected.find((r) => r.name === TARGET.name);
  expect(decoy, 'the decoy must be seen and explicitly rejected').toBeDefined();
  expect(decoy.exposed).toBe(false);
  expect(decoy.reason).toBe('not exposed to the accessibility tree');
  expect(decoy.depth).toBe(1);

  // eslint-disable-next-line no-console
  console.log(
    `\n  resolved role=button name="${TARGET.name}" at depth 3 via aria-label;` +
      ` rejected ${resolution.rejected.length} candidate(s), decoy at depth 1 not exposed\n`
  );
});

test('Q3.4 resilience: the derived path survives class and id churn, and activation is read from aria-live', async ({
  page,
}) => {
  await openPortal(page);

  const derived = await page.evaluate(
    ([role, name]) => window.__SHADOW_PIERCER__.derivePathByRole(role, name),
    [TARGET.role, TARGET.name]
  );

  expect(derived).not.toBeNull();
  expect(derived.hostChain).toEqual(['enterprise-portal', 'payment-terminal', 'security-sandbox']);
  expect(derived.role).toBe('button');
  expect(derived.nameFrom).toBe('aria-label');

  // Snapshot the volatile identifiers, then wait for the page to rotate them.
  const before = await page.evaluate(
    (spec) => window.__SHADOW_PIERCER__.resolvePath(spec).describe,
    derived
  );

  await expect
    .poll(
      async () =>
        page.evaluate(
          (spec) => window.__SHADOW_PIERCER__.resolvePath(spec).describe.volatileClassNow,
          derived
        ),
      { timeout: 10_000, intervals: [200] }
    )
    .not.toBe(before.volatileClassNow);

  const after = await page.evaluate(
    (spec) => window.__SHADOW_PIERCER__.resolvePath(spec).describe,
    derived
  );

  // Volatile facts changed; the path still resolves to exactly one node.
  expect(after.volatileClassNow).not.toBe(before.volatileClassNow);
  expect(after.volatileIdNow).not.toBe(before.volatileIdNow);
  expect(after.role).toBe('button');
  expect(after.name).toBe(TARGET.name);
  expect(after.hostChain).toEqual(derived.hostChain);

  const resolved = await page.evaluate(
    (spec) => window.__SHADOW_PIERCER__.resolvePath(spec),
    derived
  );
  expect(resolved.ok).toBe(true);
  expect(resolved.onExpectedChain).toBe(1);

  // --- activate, and verify through the accessibility tree -----------------
  const before_live = await page.evaluate(() => window.__SHADOW_PIERCER__.liveRegions());
  expect(before_live).toHaveLength(1);
  expect(before_live[0].politeness).toBe('assertive');
  expect(before_live[0].announcement).toBe('');

  const activation = await page.evaluate(
    (spec) => window.__SHADOW_PIERCER__.activate(spec),
    derived
  );
  expect(activation.ok).toBe(true);

  const after_live = await page.evaluate(() => window.__SHADOW_PIERCER__.liveRegions());
  expect(after_live[0].announcement).toMatch(/^Ledger authorization committed \(ref 1\)$/);
  expect(after_live[0].atomic).toBe(true);
  expect(after_live[0].depth).toBe(3);

  // eslint-disable-next-line no-console
  console.log(
    [
      '',
      `  path      : ${derived.hostChain.join(' > ')} :: role=${derived.role} name="${derived.name}"`,
      `  churn     : class ${before.volatileClassNow} -> ${after.volatileClassNow}`,
      `              id    ${before.volatileIdNow} -> ${after.volatileIdNow}`,
      `  aria-live : "${after_live[0].announcement}" (assertive, depth 3)`,
      '',
    ].join('\n')
  );
});
