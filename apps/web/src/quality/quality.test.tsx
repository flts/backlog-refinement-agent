import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Item, ItemSummary } from '../api';
import { PreviewPanel } from '../app/PreviewPanel';
import { SidebarPanel } from '../app/SidebarPanel';
import { makeItem } from '../test/fakeBacklogApi';
import { expectNoAxeViolations } from '../test/axe';
import { QualityBadge, QualityPanel, pickAssessment } from '.';

const assessedAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
const quality = (over: Partial<NonNullable<Item['quality']>> = {}, assessment: Record<string, unknown> = {}): NonNullable<Item['quality']> => ({
  assessment: {
    overall: 'needs-clarification', summary: 'Outcome is vague.',
    areas: [{ area: 'outcome', level: 'unclear', note: 'No measurable result' }, { area: 'scope', level: 'clear', note: null }, { area: 'dependencies', level: 'missing' }],
    excessiveTechnicalDetail: true, speculativeScope: null, suggestedItemType: 'enabler', suggestedSplit: ['Export CSV'], ...assessment,
  },
  assessedAt, documentHash: 'h1', stale: false, ...over,
});
const item = (q: Item['quality'] = quality()) => makeItem({ documentHash: 'h1', quality: q });

describe('QualityPanel', () => {
  it('shows verdict, areas with level text, flags, suggestions and the assessment time', async () => {
    const user = userEvent.setup();
    const onAssess = vi.fn();
    const { container } = render(<QualityPanel item={item()} busy={false} onAssess={onAssess} />);
    expect(screen.getByText('Needs clarification')).toBeInTheDocument();
    expect(screen.getByText('Outcome is vague.')).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(table).toHaveTextContent('outcome');
    expect(table).toHaveTextContent('Unclear');
    expect(table).toHaveTextContent('Missing');
    expect(table).toHaveTextContent('No measurable result');
    expect(screen.getByText('Contains excessive technical detail')).toBeInTheDocument();
    expect(screen.queryByText(/speculative scope/)).toBeNull();
    expect(screen.getByText('Better suited as: Enabler')).toBeInTheDocument();
    expect(screen.getByText('Suggested split: Export CSV')).toBeInTheDocument();
    expect(screen.getByText('2 hours ago')).toBeInTheDocument();
    expect(screen.queryByText(/Stale/)).toBeNull();
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('button', { name: 'Assess quality' }));
    expect(onAssess).toHaveBeenCalledOnce();
  });

  it('marks a stale assessment by flag or hash mismatch', () => {
    const { rerender } = render(<QualityPanel item={item(quality({ stale: true }))} busy={false} onAssess={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Stale — the document changed since this assessment.');
    rerender(<QualityPanel item={{ ...item(), documentHash: 'h2' }} busy={false} onAssess={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Stale');
  });

  it('disables assessing while the agent is busy and offers it for unassessed items', () => {
    const { rerender } = render(<QualityPanel item={item(null)} busy onAssess={vi.fn()} />);
    expect(screen.getByText(/has not been assessed yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Assess quality' })).toBeDisabled();
    rerender(<QualityPanel item={item(null)} busy={false} onAssess={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Assess quality' })).toBeEnabled();
  });

  it('prefers a newer live assessment from the agent state', () => {
    render(<QualityPanel item={item()} live={{ overall: 'ready', areas: [], summary: 'All good.', documentHash: 'h1', assessedAt: new Date().toISOString() }} busy={false} onAssess={vi.fn()} />);
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('All good.')).toBeInTheDocument();
  });

  it('keeps the stored assessment when the live one is older or invalid', () => {
    const stored = item();
    expect(pickAssessment(stored, { overall: 'ready', areas: [], assessedAt: '2000-01-01T00:00:00Z' })?.assessment.overall).toBe('needs-clarification');
    expect(pickAssessment(stored, { overall: 'nope' } as never)?.assessment.overall).toBe('needs-clarification');
  });
});

describe('Quality tab', () => {
  const render2 = (current: Item, extra: Partial<Parameters<typeof PreviewPanel>[0]> = {}) => render(
    <PreviewPanel className="preview" item={current} session={{ id: 's' }} busy={false} menuActions={[]} onSelectItem={vi.fn()} onUpdate={vi.fn()} onResolveChecklist={vi.fn()}
      onChangeStatus={vi.fn()} onAssessQuality={vi.fn()} onProposeChildren={vi.fn()} {...extra} />);

  it('moves the assessment out of the Document tab into its own tab', async () => {
    const user = userEvent.setup();
    const onAssessQuality = vi.fn();
    render2(item(), { onAssessQuality });
    expect(screen.queryByRole('table')).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Quality' }));
    expect(screen.getByRole('table')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Assess quality' }));
    expect(onAssessQuality).toHaveBeenCalledOnce();
  });

  it('shows the live assessment after an assess run', async () => {
    const user = userEvent.setup();
    render2(item(null), { liveQuality: { overall: 'ready-with-open-questions', areas: [{ area: 'scope', level: 'clear' }], assessedAt: new Date().toISOString() } });
    await user.click(screen.getByRole('tab', { name: 'Quality' }));
    expect(screen.getByText('Ready with open questions')).toBeInTheDocument();
  });
});

describe('QualityBadge in the tree', () => {
  const summary = (q: ItemSummary['quality']): ItemSummary => ({ id: 'i1', parentId: null, type: 'feature', title: 'Export', status: 'draft', version: 1, quality: q, updatedAt: '', updatedBy: '' });

  it.each([
    [{ overall: 'ready', assessedAt, stale: false }, 'Quality: ready'],
    [{ overall: 'needs-clarification', assessedAt, stale: false }, 'Needs clarification'],
    [{ overall: 'ready', assessedAt, stale: true }, 'Quality assessment is stale'],
  ] as const)('labels %j', (q, text) => {
    render(<QualityBadge quality={q} />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('renders nothing for unassessed items and appears in the tree row', async () => {
    const { container, rerender } = render(<QualityBadge quality={null} />);
    expect(container).toBeEmptyDOMElement();
    const sidebar = (q: ItemSummary['quality']) => <SidebarPanel className="sidebar" items={[summary(q)]} onSelect={vi.fn()} onCreate={vi.fn()} />;
    rerender(sidebar({ overall: 'ready', assessedAt, stale: false }));
    expect(screen.getByText('Quality: ready')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});
