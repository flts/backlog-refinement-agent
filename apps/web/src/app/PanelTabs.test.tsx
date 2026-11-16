import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { expectNoAxeViolations } from '../test/axe';
import { PanelTabs, tabButtonId, tabPanelId } from './PanelTabs';

const tabs = [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta', count: 3 }, { id: 'c', label: 'Gamma' }];

function Harness() {
  const [active, setActive] = useState('a');
  return <>
    <PanelTabs tabs={tabs} active={active} onChange={setActive} idPrefix="t" label="Views" />
    <div role="tabpanel" id={tabPanelId('t', active)} aria-labelledby={tabButtonId('t', active)}>Panel {active}</div>
  </>;
}

describe('PanelTabs', () => {
  it('follows the WAI-ARIA tabs pattern with arrow keys, Home and End', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    expect(screen.getByRole('tablist', { name: 'Views' })).toBeInTheDocument();
    const [alpha, beta, gamma] = screen.getAllByRole('tab');
    expect(alpha).toHaveAttribute('aria-selected', 'true');
    expect(beta).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Alpha');
    alpha.focus();
    await user.keyboard('{ArrowRight}');
    expect(beta).toHaveFocus();
    expect(beta).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Panel b')).toBeInTheDocument();
    await user.keyboard('{End}');
    expect(gamma).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(alpha).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(gamma).toHaveFocus();
    await user.keyboard('{Home}');
    expect(alpha).toHaveAttribute('aria-selected', 'true');
    await user.click(beta);
    expect(screen.getByText('Panel b')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});
