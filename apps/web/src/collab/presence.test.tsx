import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBacklogApi } from '../test/fakeBacklogApi';
import { expectNoAxeViolations } from '../test/axe';
import { renderWithApi, testQueryClient } from '../test/render';
import { TestAuth } from '../test/auth';
import { TestBacklogApiProvider } from '../api';
import { PresenceAvatars, PresenceDot, presenceSentence } from './PresenceAvatars';
import { presenceIntervalMs, usePresence, useProjectPresence, setPresence, type PresenceUser } from './presence';
import { useQueryClient } from '@tanstack/react-query';

function Heartbeat({ itemId, state = 'viewing' }: { itemId?: string; state?: 'viewing' | 'editing' }) {
  usePresence('p1', itemId, state);
  return null;
}

describe('usePresence', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('beats immediately, every 20 s and on item change, and leaves with DELETE on unmount', async () => {
    const api = createFakeBacklogApi();
    const queryClient = testQueryClient();
    const ui = (props: { itemId: string; state?: 'viewing' | 'editing' }) => <TestAuth><TestBacklogApiProvider client={api.client} queryClient={queryClient}><Heartbeat {...props} /></TestBacklogApiProvider></TestAuth>;
    const { rerender, unmount } = render(ui({ itemId: 'i1' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const posts = () => api.callsTo('POST', /presence$/);
    expect(posts().map((call) => call.body)).toEqual([{ itemId: 'i1', state: 'viewing' }]);

    await act(async () => { await vi.advanceTimersByTimeAsync(presenceIntervalMs - 1); });
    expect(posts()).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(posts()).toHaveLength(2);

    rerender(ui({ itemId: 'i2', state: 'editing' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(posts().at(-1)?.body).toEqual({ itemId: 'i2', state: 'editing' });

    expect(api.callsTo('DELETE', /presence$/)).toHaveLength(0);
    unmount();
    expect(api.callsTo('DELETE', /presence$/)).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(presenceIntervalMs * 2); });
    expect(posts()).toHaveLength(3);
  });
});

const anna: PresenceUser = { email: 'anna@example.test', name: 'Anna Jansen', itemId: 'i1', state: 'editing' };
const ben: PresenceUser = { email: 'ben@example.test', name: null, itemId: 'i1', state: 'viewing' };

describe('PresenceAvatars', () => {
  it('shows an accessible list with initials, tooltip and a +N overflow after four people', async () => {
    const people = [anna, ben, ...[3, 4, 5, 6].map((n): PresenceUser => ({ email: `p${n}@example.test`, name: `Person ${n}`, itemId: null, state: 'viewing' }))];
    const { container } = render(<PresenceAvatars people={people} />);
    const list = screen.getByRole('list', { name: 'People in this project' });
    expect(list.querySelectorAll('li')).toHaveLength(5);
    expect(screen.getByTitle('Anna Jansen (anna@example.test) – editing')).toHaveTextContent('AJ');
    expect(screen.getByText('B')).toBeInTheDocument();
    expect(screen.getByText('+2')).toBeInTheDocument();
    expect(screen.getByText(/and 2 more: Person 5, Person 6/)).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('describes who is doing what', async () => {
    expect(presenceSentence([anna])).toBe('Anna Jansen is editing');
    expect(presenceSentence([ben])).toBe('ben@example.test is viewing');
    expect(presenceSentence([{ ...ben, state: 'viewing' }, { ...anna, state: 'viewing' }])).toBe('ben@example.test and Anna Jansen are viewing');
    const { container } = render(<><PresenceAvatars people={[anna]} showLabel label="People viewing this item" /><PresenceDot people={[anna]} /></>);
    expect(screen.getByText('Anna Jansen is editing')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Anna Jansen is editing' })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('renders nothing when nobody else is there', () => {
    const { container } = render(<PresenceAvatars people={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('useProjectPresence', () => {
  function Probe() {
    const queryClient = useQueryClient();
    const { people, forItem } = useProjectPresence('p1');
    return <div>
      <button onClick={() => { setPresence(queryClient, 'p1', [
        { email: 'ALICE@example.test', name: 'Me', itemId: 'i1', state: 'viewing' },
        anna, { ...anna, itemId: null, state: 'viewing' }, ben,
      ]); }}>push</button>
      <p data-testid="people">{people.map((person) => `${person.email}:${person.state}`).join(',')}</p>
      <p data-testid="i1">{forItem('i1').map((person) => person.email).join(',')}</p>
    </div>;
  }

  it('excludes the signed-in user and groups by person and item', async () => {
    renderWithApi(<Probe />, createFakeBacklogApi());
    fireEvent.click(screen.getByText('push'));
    await waitFor(() => expect(screen.getByTestId('people')).toHaveTextContent('anna@example.test:editing,ben@example.test:viewing'));
    expect(screen.getByTestId('i1')).toHaveTextContent('anna@example.test,ben@example.test');
  });
});
