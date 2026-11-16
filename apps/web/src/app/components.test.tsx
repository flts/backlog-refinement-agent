import React, { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expectNoAxeViolations } from '../test/axe';
import { Composer } from './Composer';
import { ItemMenu } from './ItemMenu';
import { SettingsModal } from './SettingsModal';
import { TestAuth, testAuth } from '../test/auth';
import type { UserSettings } from '../infrastructure/storage/SettingsRepository';

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
  const settings: UserSettings = {
    instructions: '', principles: 'P',
    templates: { capability: '# C', feature: '# F', 'user-story': '# S', enabler: '# E' },
    typeInstructions: { capability: 'ci', feature: 'fi', 'user-story': 'si', enabler: 'ei' },
  };

  it('exports saved configuration and confirms imports from the Backup tab', async () => {
    const user = userEvent.setup();
    const onExport = vi.fn();
    const onImport = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { container } = renderSettings(<SettingsModal settings={settings} onSave={vi.fn()} onRestore={vi.fn()} onClose={vi.fn()} onImport={onImport} onExport={onExport} />);
    await user.click(screen.getByRole('tab', { name: 'Backup' }));
    await user.click(screen.getByRole('button', { name: 'Export configuration' }));
    expect(onExport).toHaveBeenCalledOnce();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(['{}'], 'backup.json', { type: 'application/json' });
    await user.upload(input, file);
    expect(onImport).not.toHaveBeenCalled();
    await user.upload(input, file);
    expect(onImport).toHaveBeenCalledWith(file);
    expect(confirm).toHaveBeenCalledTimes(2);
    confirm.mockRestore();
  });

  it('switches the appearance immediately without touching saved settings', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const { container } = renderSettings(<SettingsModal settings={settings} onSave={onSave} onRestore={vi.fn()} onClose={vi.fn()} onImport={vi.fn()} onExport={vi.fn()} />);
    expect(screen.getByRole('radio', { name: 'System' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('theme-preference')).toBe('dark');
    await user.click(screen.getByRole('radio', { name: 'System' }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(localStorage.getItem('theme-preference')).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
    await expectNoAxeViolations(container);
  });

  it('shows one tab at a time and saves the values of all tabs', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderSettings(<SettingsModal settings={settings} onSave={onSave} onRestore={vi.fn()} onClose={vi.fn()} onImport={vi.fn()} onExport={vi.fn()} />);
    expect(screen.getByLabelText('Base refinement principles')).toBeVisible();
    expect(screen.getByLabelText('Feature template')).not.toBeVisible();
    await user.click(screen.getByRole('tab', { name: 'Feature' }));
    expect(screen.getByLabelText('Feature template')).toBeVisible();
    await user.clear(screen.getByLabelText('Feature template'));
    await user.type(screen.getByLabelText('Feature template'), '# Changed');
    await user.click(screen.getByRole('button', { name: 'Save customization' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      principles: 'P',
      templates: expect.objectContaining({ feature: '# Changed', capability: '# C' }),
    }));
  });

  it('has no axe violations', async () => {
    const { container } = renderSettings(<SettingsModal settings={settings} onSave={vi.fn()} onRestore={vi.fn()} onClose={vi.fn()} onImport={vi.fn()} onExport={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Instructions & templates' })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('moves between tabs with Home and End', async () => {
    const user = userEvent.setup();
    renderSettings(<SettingsModal settings={settings} onSave={vi.fn()} onRestore={vi.fn()} onClose={vi.fn()} onImport={vi.fn()} onExport={vi.fn()} />);
    screen.getByRole('tab', { name: 'General' }).focus();
    await user.keyboard('{End}');
    const tabs = screen.getAllByRole('tab');
    expect(tabs[tabs.length - 1]).toHaveFocus();
    expect(tabs[tabs.length - 1]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Home}');
    expect(tabs[0]).toHaveFocus();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderSettings(<SettingsModal settings={settings} onSave={vi.fn()} onRestore={vi.fn()} onClose={onClose} onImport={vi.fn()} onExport={vi.fn()} />);
    await user.click(screen.getByRole('tab', { name: 'General' }));
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the account and signs out through the auth provider', async () => {
    const user = userEvent.setup();
    const auth = testAuth();
    const { container } = renderSettings(<SettingsModal settings={settings} onSave={vi.fn()} onRestore={vi.fn()} onClose={vi.fn()} onImport={vi.fn()} onExport={vi.fn()} />, auth);
    const account = screen.getByRole('group', { name: 'Account' });
    expect(account).toHaveTextContent('Alice Owner');
    expect(account).toHaveTextContent('alice@example.test');
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(auth.signOut).toHaveBeenCalledOnce();
  });

  it('explains that the platform manages the session instead of offering sign out', () => {
    renderSettings(<SettingsModal settings={settings} onSave={vi.fn()} onRestore={vi.fn()} onClose={vi.fn()} onImport={vi.fn()} onExport={vi.fn()} />, testAuth({ mode: 'platform', canSignOut: false }));
    expect(screen.getByRole('group', { name: 'Account' })).toHaveTextContent('alice@example.test');
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });
});
