import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Projects } from '../app/Projects';
import { createFakeBacklogApi, makeItem, makeMember, makeProject } from '../test/fakeBacklogApi';
import { TestAuth, testAuth } from '../test/auth';
import { renderWithApi } from '../test/render';
import { expectNoAxeViolations } from '../test/axe';
import type { RunPhase } from '../run';
import { AgentStatusPill } from './AgentStatusPill';
import { AccountMenu } from './AccountMenu';
import { Topbar, openPaletteEvent, overflowQuery } from './Topbar';
import { WorkspaceLayout } from './WorkspaceLayout';
import { layoutStorageKey } from './layout';
import { useWorkspaceLayout } from './useWorkspaceLayout';

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.documentElement.removeAttribute('data-theme'); });

function stubMatchMedia(matching: (query: string) => boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: matching(query), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
}

describe('agent status pill', () => {
  it.each<[RunPhase, string]>([
    ['idle', 'Idle'], ['hydrating', 'Idle'], ['running', 'Working…'], ['awaitingInput', 'Needs your input'], ['awaitingReview', 'Review changes'], ['cancelled', 'Idle'], ['error', 'Run failed'],
  ])('shows %s as "%s"', (phase, text) => {
    render(<AgentStatusPill phase={phase} />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('is not a live region (the chat announcer reads phase changes) and updates with the phase', () => {
    const { rerender, container } = render(<AgentStatusPill phase="idle" />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(container.querySelector('[aria-live]')).toBeNull();
    rerender(<AgentStatusPill phase="awaitingReview" />);
    expect(screen.getByText('Review changes')).toBeInTheDocument();
  });
});

describe('account menu', () => {
  it('shows name and email and signs out', async () => {
    const user = userEvent.setup();
    const auth = testAuth();
    render(<TestAuth value={auth}><AccountMenu /></TestAuth>);
    const button = screen.getByRole('button', { name: 'Account: Alice Owner' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    await user.click(button);
    const panel = screen.getByRole('dialog', { name: 'Account' });
    expect(within(panel).getByText('Alice Owner')).toBeInTheDocument();
    expect(within(panel).getByText('alice@example.test')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Sign out' }));
    expect(auth.signOut).toHaveBeenCalledOnce();
  });

  it('explains managed sessions instead of offering sign out, and closes with Escape', async () => {
    const user = userEvent.setup();
    render(<TestAuth value={testAuth({ canSignOut: false })}><AccountMenu /></TestAuth>);
    await user.click(screen.getByRole('button', { name: /^Account/ }));
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    expect(screen.getByText(/managed by your organisation/)).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Account' })).toBeNull();
    expect(screen.getByRole('button', { name: /^Account/ })).toHaveFocus();
  });
});

describe('topbar in the app', () => {
  const setup = () => {
    const api = createFakeBacklogApi({ projects: [makeProject()], items: [makeItem()], members: [makeMember()] });
    return { api, ...renderWithApi(<Projects />, api) };
  };

  it('opens the Share dialog and the project settings from the topbar', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByRole('button', { name: 'Share' }));
    expect(await screen.findByRole('dialog', { name: 'Alpha' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close share dialog' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Alpha' })).toBeNull());
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('menuitem', { name: 'Project settings…' }));
    expect(await screen.findByRole('dialog', { name: /settings/i })).toBeInTheDocument();
  });

  it('opens the user settings from the settings menu', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('menuitem', { name: 'User settings…' }));
    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
  });

  it('shows the agent as idle and keeps item actions in the document menu', async () => {
    setup();
    expect(await screen.findByText('Idle')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More actions' })).toBeInTheDocument();
  });

  it('asks the palette to open through the shell:open-palette event', async () => {
    const user = userEvent.setup();
    setup();
    const listener = vi.fn();
    window.addEventListener(openPaletteEvent, listener);
    await user.click(await screen.findByRole('button', { name: /Search items/ }));
    window.removeEventListener(openPaletteEvent, listener);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('has no axe violations in the light and dark themes', async () => {
    const { container } = setup();
    await screen.findByRole('button', { name: 'Share' });
    await expectNoAxeViolations(container);
    document.documentElement.dataset.theme = 'dark';
    await expectNoAxeViolations(container);
  });

  it('collapses into an overflow menu at narrow widths', async () => {
    stubMatchMedia((query) => query === overflowQuery);
    const user = userEvent.setup();
    const { container } = setup();
    const more = await screen.findByRole('button', { name: 'More' });
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Sources/ })).toBeNull();
    await user.click(more);
    const menu = screen.getByRole('menu', { name: 'More' });
    expect(within(menu).getAllByRole('menuitem').map((entry) => entry.textContent)).toEqual(['Sources (0)', 'Share…', 'Focus mode', 'Settings…', 'Project settings…']);
    await expectNoAxeViolations(container);
    await user.click(within(menu).getByRole('menuitem', { name: 'Share…' }));
    expect(await screen.findByRole('dialog', { name: 'Alpha' })).toBeInTheDocument();
    // The search trigger, agent status and account menu stay visible.
    expect(screen.getByRole('button', { name: /Search items/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Account/ })).toBeInTheDocument();
  });

  it('opens Sources from the overflow menu', async () => {
    stubMatchMedia((query) => query === overflowQuery);
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByRole('button', { name: 'More' }));
    await user.click(screen.getByRole('menuitem', { name: /^Sources/ }));
    expect(await screen.findByRole('heading', { name: 'Sources' })).toBeInTheDocument();
  });

  it('supports keyboard navigation in the project menu', async () => {
    const user = userEvent.setup();
    setup();
    const trigger = await screen.findByRole('button', { name: 'Project: Alpha' });
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitemradio', { name: 'Alpha' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('menuitem', { name: 'Delete project' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });
});

describe('topbar (isolated)', () => {
  it('lists topbar controls and omits Share without a handler', async () => {
    const api = createFakeBacklogApi({ projects: [makeProject()] });
    renderWithApi(<Topbar project={makeProject()} controls={{ projects: [makeProject()], busy: false, onSelect: vi.fn(), onCreate: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onImport: vi.fn() }}
      people={[]} saveStatus="saved" onResolveConflict={vi.fn()} agentPhase="awaitingInput" focusMode={false} onToggleFocus={vi.fn()} onOpenSettings={vi.fn()} onOpenProjectSettings={vi.fn()} />, api);
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
    expect(screen.getByText('Needs your input')).toBeInTheDocument();
  });
});

function Harness() {
  const layout = useWorkspaceLayout();
  return <WorkspaceLayout layout={layout}
    tree={<aside className="sidebar"><button>tree</button></aside>}
    chat={<section className="refinement-column"><button>chat</button></section>}
    preview={<section className="preview-column"><button>doc</button></section>} />;
}

const splitter = (name: string) => screen.getByRole('separator', { name });

describe('resizable panels', () => {
  it('exposes the separators with their value and limits', async () => {
    const { container } = render(<Harness />);
    const tree = splitter('Resize backlog tree');
    expect(tree).toHaveAttribute('aria-valuenow', '260');
    expect(tree).toHaveAttribute('aria-valuemin', '200');
    expect(tree).toHaveAttribute('aria-valuemax', '480');
    expect(splitter('Resize document panel')).toHaveAttribute('aria-valuenow', '420');
    await expectNoAxeViolations(container);
  });

  it('resizes by 16 px with the arrow keys, in the direction of the arrow', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    splitter('Resize backlog tree').focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(splitter('Resize backlog tree')).toHaveAttribute('aria-valuenow', '292');
    await user.keyboard('{ArrowLeft}');
    expect(splitter('Resize backlog tree')).toHaveAttribute('aria-valuenow', '276');
    splitter('Resize document panel').focus();
    await user.keyboard('{ArrowLeft}');
    expect(splitter('Resize document panel')).toHaveAttribute('aria-valuenow', '436');
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(splitter('Resize document panel')).toHaveAttribute('aria-valuenow', '404');
  });

  it('jumps to the limits with Home/End, never goes beyond them, and resets with Enter or double-click', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const tree = splitter('Resize backlog tree');
    tree.focus();
    await user.keyboard('{Home}');
    expect(tree).toHaveAttribute('aria-valuenow', '200');
    await user.keyboard('{ArrowLeft}');
    expect(tree).toHaveAttribute('aria-valuenow', '200');
    await user.keyboard('{End}');
    expect(tree).toHaveAttribute('aria-valuenow', '480');
    await user.keyboard('{Enter}');
    expect(tree).toHaveAttribute('aria-valuenow', '260');
    await user.keyboard('{ArrowRight}');
    fireEvent.doubleClick(tree);
    expect(tree).toHaveAttribute('aria-valuenow', '260');
  });

  it('resizes by dragging', () => {
    render(<Harness />);
    const tree = splitter('Resize backlog tree');
    fireEvent.pointerDown(tree, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(tree, { clientX: 150, pointerId: 1 });
    fireEvent.pointerUp(tree, { pointerId: 1 });
    expect(tree).toHaveAttribute('aria-valuenow', '310');
    expect(document.body).not.toHaveClass('is-resizing');
  });

  it('persists widths in localStorage and restores them', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness />);
    splitter('Resize backlog tree').focus();
    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(JSON.parse(localStorage.getItem(layoutStorageKey)!)).toEqual({ tree: 276, doc: 420 }));
    unmount();
    render(<Harness />);
    expect(splitter('Resize backlog tree')).toHaveAttribute('aria-valuenow', '276');
  });

  it('ignores unusable stored widths', () => {
    localStorage.setItem(layoutStorageKey, '{"tree":"wide","doc":5}');
    render(<Harness />);
    expect(splitter('Resize backlog tree')).toHaveAttribute('aria-valuenow', '260');
    localStorage.setItem(layoutStorageKey, '{"tree":9999,"doc":1}');
  });
});

describe('focus mode', () => {
  const grid = () => document.querySelector('.workspace-grid')!;

  it('toggles with Ctrl+. and ⌘., showing only the chat first, and announces it', async () => {
    render(<Harness />);
    expect(grid()).not.toHaveClass('focus-chat');
    fireEvent.keyDown(window, { key: '.', ctrlKey: true });
    expect(grid()).toHaveClass('focus-chat');
    expect(screen.getByRole('status')).toHaveTextContent('only the refinement chat');
    fireEvent.keyDown(window, { key: '.', metaKey: true });
    expect(grid()).not.toHaveClass('focus-chat');
  });

  it('focuses the document when that was the panel the user last worked in', async () => {
    render(<Harness />);
    act(() => screen.getByRole('button', { name: 'doc' }).focus());
    fireEvent.keyDown(window, { key: '.', ctrlKey: true });
    expect(grid()).toHaveClass('focus-document');
  });

  it('is toggled by the topbar button in the app', async () => {
    const user = userEvent.setup();
    renderWithApi(<Projects />, createFakeBacklogApi({ projects: [makeProject()], items: [makeItem()] }));
    const button = await screen.findByRole('button', { name: 'Focus mode' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    await user.click(button);
    expect(screen.getByRole('button', { name: 'Exit focus mode' })).toHaveAttribute('aria-pressed', 'true');
    expect(document.querySelector('.workspace-grid')).toHaveClass('focus-chat');
    await user.click(screen.getByRole('button', { name: 'Exit focus mode' }));
    expect(document.querySelector('.workspace-grid')).not.toHaveClass('focus-chat');
  });
});
