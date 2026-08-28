export {};

interface AncestorScopeCandidate {
  scopeSelector: string;
  targetSelector: string;
  targetConfidence: 'HIGH' | 'LOW';
}

function derive(element: Element): AncestorScopeCandidate | null {
  for (let ancestor = element.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
    const scopeSelector = selectorForAncestor(ancestor);
    if (!scopeSelector) continue;
    const generate = Reflect.get(window, '__DSH_PWGEN__');
    if (typeof generate !== 'function') throw new Error('Playwright locator generator 未注入');
    const target = generate(element, ancestor) as {
      selector: string;
      confidence: 'HIGH' | 'LOW';
    };
    return {
      scopeSelector,
      targetSelector: target.selector,
      targetConfidence: target.confidence,
    };
  }
  return null;
}

function selectorForAncestor(ancestor: Element): string | null {
  const role = ancestor.getAttribute('role');
  if (role && ['region', 'form', 'group'].includes(role)) {
    const name = accessibleName(ancestor);
    if (name) return `internal:role=${role}[name=${JSON.stringify(name)}i]`;
  }

  if (ancestor.matches('section, fieldset')) {
    const title = normalized(ancestor.querySelector('h1, h2, h3, h4, h5, h6, legend')?.textContent);
    if (title) return `${ancestor.tagName.toLowerCase()}:has-text(${JSON.stringify(title)})`;
  }

  return null;
}

function accessibleName(element: Element): string {
  const ariaLabel = normalized(element.getAttribute('aria-label'));
  if (ariaLabel) return ariaLabel;
  const labelledBy = element.getAttribute('aria-labelledby');
  if (!labelledBy) return '';
  return normalized(
    labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' '),
  );
}

function normalized(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

Object.assign(window, { __DSH_ANCESTOR_SCOPE__: derive });
