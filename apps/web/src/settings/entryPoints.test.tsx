import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsModal } from '../app/SettingsModal';
import { TestAuth } from '../test/auth';
import { collapseUnchanged, diffLines } from './lineDiff';

describe('settings entry points', () => {
  it('offers the project settings from the user settings and not without a project', async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    const { unmount } = render(<TestAuth><SettingsModal projectName="Alpha" onClose={vi.fn()} onOpenProjectSettings={open} /></TestAuth>);
    expect(screen.getByRole('group', { name: 'Account' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open project settings…' }));
    expect(open).toHaveBeenCalledOnce();
    unmount();
    render(<TestAuth><SettingsModal onClose={vi.fn()} /></TestAuth>);
    expect(screen.queryByRole('button', { name: 'Open project settings…' })).toBeNull();
  });
});

describe('line diff', () => {
  it('marks added and removed lines in order and collapses long unchanged runs', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n');
    const after = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'H', 'i'].join('\n');
    const lines = diffLines(before, after);
    expect(lines.filter((line) => line.kind !== 'same')).toEqual([{ kind: 'remove', text: 'h' }, { kind: 'add', text: 'H' }, { kind: 'add', text: 'i' }]);
    const rows = collapseUnchanged(lines);
    expect(rows[0]).toEqual({ kind: 'skip', count: 5 });
  });
});
