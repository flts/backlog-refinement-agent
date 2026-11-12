import axe from 'axe-core';
import { expect } from 'vitest';

/**
 * Runs axe-core against a rendered container. Colour contrast is disabled because
 * jsdom does not compute styles; contrast is covered by styles.contrast.test.ts.
 * A clean run is not a WCAG compliance claim, see docs/accessibility.md.
 */
export async function expectNoAxeViolations(container: Element) {
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    rules: { 'color-contrast': { enabled: false } },
  });
  const report = results.violations
    .map((violation) => `${violation.id}: ${violation.help}\n${violation.nodes.map((node) => `  - ${node.html}`).join('\n')}`)
    .join('\n\n');
  expect(report).toBe('');
}
