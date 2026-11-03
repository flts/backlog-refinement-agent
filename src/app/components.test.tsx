import React, { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Composer } from './Composer';
import { ItemMenu } from './ItemMenu';
import { SettingsModal } from './SettingsModal';
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

describe('SettingsModal', () => {
  const settings: UserSettings = {
    instructions: '', principles: 'P',
    templates: { capability: '# C', feature: '# F', 'user-story': '# S', enabler: '# E' },
    typeInstructions: { capability: 'ci', feature: 'fi', 'user-story': 'si', enabler: 'ei' },
  };

  it('shows one tab at a time and saves the values of all tabs', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<SettingsModal settings={settings} llmReady onSave={onSave} onRestore={vi.fn()} onClose={vi.fn()} />);
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

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<SettingsModal settings={settings} llmReady onSave={vi.fn()} onRestore={vi.fn()} onClose={onClose} />);
    await user.click(screen.getByRole('tab', { name: 'General' }));
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});
