import React, { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expectNoAxeViolations } from '../test/axe';
import { Composer } from '../chat';
import { ItemMenu } from './ItemMenu';
import { SettingsModal } from './SettingsModal';
import { TestAuth, testAuth } from '../test/auth';

function ComposerHarness({ onSubmit }: { onSubmit: (text: string) => void }) {
  const [value, setValue] = useState('');
  return <Composer value={value} busy={false} onChange={setValue} onSubmit={() => onSubmit(value)} />;
}

describe('Composer', () => {
  it('submits on Enter and inserts a newline on Shift+Enter', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ComposerHarness onSubmit={onSubmit} />);
    const box = screen.getByLabelText('Message the refinement agent');
    await user.type(box, 'line one{Shift>}{Enter}{/Shift}line two');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(box).toHaveValue('line one\nline two');
    await user.type(box, '{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('line one\nline two');
  });
});

describe('ItemMenu', () => {
  it('opens a menu, supports arrow keys and Escape, and runs the chosen action', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(<ItemMenu actions={[{ id: 'copy', label: 'Copy', onSelect: vi.fn() }, { id: 'delete', label: 'Delete', danger: true, onSelect: onDelete }]} />);
    const trigger = screen.getByRole('button', { name: 'More actions' });
    expect(screen.queryByRole('menu')).toBeNull();
    await user.click(trigger);
    expect(screen.getByRole('menuitem', { name: 'Copy' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

function renderSettings(ui: React.ReactElement, auth = testAuth()) {
  return render(<TestAuth value={auth}>{ui}</TestAuth>);
}

describe('SettingsModal', () => {
  it('switches the appearance immediately and stores it in this browser only', async () => {
    const user = userEvent.setup();
    const { container } = renderSettings(<SettingsModal onClose={vi.fn()} />);
    expect(screen.getByRole('radio', { name: 'System' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('theme-preference')).toBe('dark');
    await user.click(screen.getByRole('radio', { name: 'System' }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(localStorage.getItem('theme-preference')).toBeNull();
    await expectNoAxeViolations(container);
  });

  it('no longer edits instructions or templates locally', () => {
    renderSettings(<SettingsModal onClose={vi.fn()} />);
    expect(screen.queryByLabelText('Base refinement principles')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('is a labelled dialog without axe violations that closes on Escape and with Done', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { container } = renderSettings(<SettingsModal onClose={onClose} />);
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    await expectNoAxeViolations(container);
    screen.getByRole('button', { name: 'Done' }).focus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('shows the account and signs out through the auth provider', async () => {
    const user = userEvent.setup();
    const auth = testAuth();
    const { container } = renderSettings(<SettingsModal onClose={vi.fn()} />, auth);
    const account = screen.getByRole('group', { name: 'Account' });
    expect(account).toHaveTextContent('Alice Owner');
    expect(account).toHaveTextContent('alice@example.test');
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(auth.signOut).toHaveBeenCalledOnce();
  });

  it('explains that the platform manages the session instead of offering sign out', () => {
    renderSettings(<SettingsModal onClose={vi.fn()} />, testAuth({ mode: 'platform', canSignOut: false }));
    expect(screen.getByRole('group', { name: 'Account' })).toHaveTextContent('alice@example.test');
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });
});
