/**
 * Q3 - Sealed Closed-Boundary Shadow DOM Pathfinding
 * =============================================================================
 * The problem, precisely
 * ----------------------------------------------------------------------------
 * `element.shadowRoot` returns null for a root opened with `{mode: 'closed'}`.
 * A recursive `.shadowRoot` walk therefore terminates at the first closed host
 * and can never reach anything below it. No selector, however clever, crosses
 * that boundary from outside - the reference simply is not exposed.
 *
 * The strategy: capture at construction, not at query time
 * ----------------------------------------------------------------------------
 * A closed root is unreachable *afterwards*, but it must be created by
 * `Element.prototype.attachShadow`. Wrapping that method before any component
 * code runs means every root - open or closed - is recorded in a registry as it
 * is constructed, keyed by its host. Traversal then walks the registry rather
 * than the `.shadowRoot` property, so closed boundaries stop mattering.
 *
 * Ordering is the whole trick: the patch must be installed before the first
 * `customElements.define` callback fires. In Playwright that is
 * `page.addInitScript`; in a real harness it is a document_start content script
 * or a bundled pre-init module.
 *
 * Locator resilience: what we key on, and what we refuse to key on
 * ----------------------------------------------------------------------------
 * The hosts in this boundary carry `class="obfuscated_v4_x89a"`-style strings
 * that regenerate on load, and their ids churn too. So a resilient path is
 * built from things the application cannot rewrite without changing its
 * semantics:
 *
 *   USED      custom element tag names (registered, cannot churn)
 *             shadow boundary depth
 *             computed ARIA role
 *             accessible name, aria-label first
 *             aria-live / role=status regions for outcome verification
 *
 *   REFUSED   class strings, ids, absolute XPath, nth-child position,
 *             visible text content as the primary key
 *
 * Text is used only as the last fallback in accessible-name computation, which
 * is what the ARIA accname algorithm itself specifies - and the testbed proves
 * why it cannot be the primary key: a decoy control carries identical visible
 * text but is `aria-hidden`, so a text-first match resolves the wrong element.
 */

/* eslint-disable no-undef */

/**
 * Init script. MUST run before the page's own scripts.
 * Exposes window.__SHADOW_PIERCER__.
 */
function installShadowPiercer() {
  const registry = [];
  const byHost = new WeakMap();

  const nativeAttachShadow = Element.prototype.attachShadow;

  Element.prototype.attachShadow = function patchedAttachShadow(init) {
    const root = nativeAttachShadow.call(this, init);
    const entry = { host: this, root, mode: (init && init.mode) || 'open', tag: this.tagName.toLowerCase() };
    registry.push(entry);
    byHost.set(this, entry);
    return root;
  };

  // -------------------------------------------------------------------------
  // Traversal
  // -------------------------------------------------------------------------

  /** Every root the page ever opened, in construction order. */
  function roots() {
    return registry.map((e, i) => ({
      index: i,
      hostTag: e.tag,
      mode: e.mode,
      // Proof that the capture was necessary: the host exposes nothing.
      shadowRootVisibleFromOutside: e.host.shadowRoot !== null,
    }));
  }

  /** Depth of a node in shadow-boundary terms (0 = document). */
  function boundaryDepth(node) {
    let depth = 0;
    let current = node;
    while (current) {
      const root = current.getRootNode();
      if (root === document) return depth;
      depth += 1;
      current = root.host;
      if (!current) return depth;
    }
    return depth;
  }

  /**
   * Breadth-first walk across the document and every captured root.
   * @param {(el: Element) => boolean} predicate
   */
  function queryDeep(predicate, { limit = Infinity } = {}) {
    const scopes = [document, ...registry.map((e) => e.root)];
    const found = [];

    for (const scope of scopes) {
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);
      let node = walker.currentNode.nodeType === 1 ? walker.currentNode : walker.nextNode();
      while (node) {
        try {
          if (predicate(node)) {
            found.push(node);
            if (found.length >= limit) return found;
          }
        } catch {
          /* predicate threw on an exotic node; keep walking */
        }
        node = walker.nextNode();
      }
    }
    return found;
  }

  // -------------------------------------------------------------------------
  // Accessibility-tree resolution
  // -------------------------------------------------------------------------

  const IMPLICIT_ROLES = {
    BUTTON: 'button',
    A: 'link',
    INPUT: 'textbox',
    SELECT: 'combobox',
    TEXTAREA: 'textbox',
    OUTPUT: 'status',
  };

  function computedRole(el) {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit.trim().toLowerCase();
    return IMPLICIT_ROLES[el.tagName] || null;
  }

  /**
   * Accessible name, in ARIA accname precedence order.
   * aria-label first: it is authored intent and survives markup churn, whereas
   * text content is cosmetic and - as the decoy demonstrates - ambiguous.
   */
  function accessibleName(el) {
    const label = el.getAttribute && el.getAttribute('aria-label');
    if (label && label.trim()) return { name: label.trim(), from: 'aria-label' };

    const labelledBy = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const scope = el.getRootNode();
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => scope.getElementById && scope.getElementById(id))
        .filter(Boolean)
        .map((n) => n.textContent.trim());
      if (parts.length) return { name: parts.join(' '), from: 'aria-labelledby' };
    }

    const title = el.getAttribute && el.getAttribute('title');
    if (title && title.trim()) return { name: title.trim(), from: 'title' };

    const text = (el.textContent || '').trim();
    if (text) return { name: text, from: 'content' };

    return { name: '', from: 'none' };
  }

  /** Is this node exposed to assistive technology at all? */
  function isInAccessibilityTree(el) {
    let node = el;
    while (node && node.nodeType === 1) {
      if (node.getAttribute('aria-hidden') === 'true') return false;
      if (node.hasAttribute('hidden')) return false;
      const style = node.ownerDocument.defaultView.getComputedStyle(node);
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
      const root = node.getRootNode();
      node = root === document ? node.parentElement : root.host;
      if (node === el) break;
    }
    return true;
  }

  /**
   * Resolve a target by role and accessible name across every shadow boundary,
   * excluding anything the accessibility tree does not expose.
   */
  function findByRole(role, name, { exact = true } = {}) {
    const wanted = String(role).toLowerCase();
    const candidates = queryDeep((el) => computedRole(el) === wanted);

    const described = candidates.map((el) => {
      const acc = accessibleName(el);
      return {
        el,
        role: wanted,
        name: acc.name,
        nameFrom: acc.from,
        exposed: isInAccessibilityTree(el),
        depth: boundaryDepth(el),
        hostTag: el.getRootNode().host ? el.getRootNode().host.tagName.toLowerCase() : null,
      };
    });

    const matches = described.filter((c) => {
      if (!c.exposed) return false;
      if (name === undefined) return true;
      return exact ? c.name === name : c.name.includes(name);
    });

    return { matches, rejected: described.filter((c) => !matches.includes(c)) };
  }

  // -------------------------------------------------------------------------
  // Resilient path: derive, then re-resolve
  // -------------------------------------------------------------------------

  /**
   * Describe how to reach an element using only churn-proof facts:
   * the chain of shadow host tag names, plus the target's role and accessible
   * name. No class, no id, no index, no XPath.
   */
  function derivePath(el) {
    const hostChain = [];
    let node = el;
    let root = node.getRootNode();
    while (root !== document && root.host) {
      hostChain.unshift(root.host.tagName.toLowerCase());
      node = root.host;
      root = node.getRootNode();
    }
    const acc = accessibleName(el);
    return {
      hostChain,
      role: computedRole(el),
      name: acc.name,
      nameFrom: acc.from,
      boundaryDepth: hostChain.length,
    };
  }

  /**
   * Re-resolve a derived path. Validates the host chain as well as the target,
   * so a path that still matches by role but has moved to a different boundary
   * is reported rather than silently accepted.
   */
  function resolvePath(pathSpec) {
    const { matches } = findByRole(pathSpec.role, pathSpec.name);
    const onExpectedChain = matches.filter((m) => {
      const chain = derivePath(m.el).hostChain;
      return chain.length === pathSpec.hostChain.length && chain.every((t, i) => t === pathSpec.hostChain[i]);
    });

    return {
      ok: onExpectedChain.length === 1,
      totalRoleNameMatches: matches.length,
      onExpectedChain: onExpectedChain.length,
      element: onExpectedChain[0] ? onExpectedChain[0].el : null,
      describe: onExpectedChain[0]
        ? {
            role: onExpectedChain[0].role,
            name: onExpectedChain[0].name,
            nameFrom: onExpectedChain[0].nameFrom,
            depth: onExpectedChain[0].depth,
            hostChain: pathSpec.hostChain,
            // Reported purely so a human can see the churn; never matched on.
            volatileClassNow: onExpectedChain[0].el.className || null,
            volatileIdNow: onExpectedChain[0].el.id || null,
          }
        : null,
    };
  }

  /** Read every aria-live / role=status region across all boundaries. */
  function liveRegions() {
    return queryDeep(
      (el) => el.hasAttribute && (el.hasAttribute('aria-live') || el.getAttribute('role') === 'status')
    ).map((el) => ({
      role: computedRole(el),
      politeness: el.getAttribute('aria-live') || 'off',
      atomic: el.getAttribute('aria-atomic') === 'true',
      announcement: (el.textContent || '').trim(),
      depth: boundaryDepth(el),
    }));
  }

  /**
   * The naive baseline, kept so the suite can demonstrate the failure rather
   * than assert it from memory: recursive `.shadowRoot` traversal only.
   */
  function naiveShadowWalk(selector) {
    const visited = [];
    const out = [];
    const walk = (scope, depth) => {
      visited.push({ depth, scope: scope === document ? 'document' : scope.host.tagName.toLowerCase() });
      out.push(...scope.querySelectorAll(selector));
      scope.querySelectorAll('*').forEach((el) => {
        if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
      });
    };
    walk(document, 0);
    return { found: out.length, deepestDepth: Math.max(...visited.map((v) => v.depth)), visited };
  }

  function activate(pathSpec) {
    const resolved = resolvePath(pathSpec);
    if (!resolved.ok || !resolved.element) return { ok: false, reason: 'path did not resolve to exactly one node' };
    resolved.element.click();
    return { ok: true, clicked: resolved.describe };
  }

  window.__SHADOW_PIERCER__ = {
    roots,
    // `source` is an arrow-function expression as text (predicates cannot be
    // serialised across the CDP boundary). Evaluate it to the function itself,
    // rather than wrapping it in a function that merely returns it - which
    // would be truthy for every node and match the entire tree.
    queryDeep: (source, opts) => {
      const predicate = new Function(`return (${source});`)();
      return queryDeep(predicate, opts).length;
    },
    computedRole,
    accessibleName,
    isInAccessibilityTree,
    findByRole: (role, name, opts) => {
      const { matches, rejected } = findByRole(role, name, opts);
      return {
        matches: matches.map((m) => ({
          role: m.role,
          name: m.name,
          nameFrom: m.nameFrom,
          depth: m.depth,
          hostTag: m.hostTag,
        })),
        rejected: rejected.map((m) => ({
          role: m.role,
          name: m.name,
          exposed: m.exposed,
          depth: m.depth,
          reason: m.exposed ? 'name mismatch' : 'not exposed to the accessibility tree',
        })),
      };
    },
    derivePathByRole: (role, name) => {
      const { matches } = findByRole(role, name);
      return matches.length === 1 ? derivePath(matches[0].el) : null;
    },
    resolvePath: (spec) => {
      const r = resolvePath(spec);
      return { ok: r.ok, totalRoleNameMatches: r.totalRoleNameMatches, onExpectedChain: r.onExpectedChain, describe: r.describe };
    },
    liveRegions,
    naiveShadowWalk,
    activate,
  };
}

module.exports = { installShadowPiercer };
