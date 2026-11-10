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
    render(<SettingsModal settings={settings} llmReady llm={{ endpoint: '', model: '', apiKey: '' }} llmEnvironment={{ endpoint: '', model: '', apiKey: '' }} onClearLlm={vi.fn()} onSave={onSave} onRestore={vi.fn()} onClose={vi.fn()} />);
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
    }), { endpoint: '', model: '', apiKey: '' });
  });

  it('saves LLM connection values, masks the key and shows environment hints', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<SettingsModal settings={settings} llmReady llm={{ endpoint: '', model: '', apiKey: '' }} llmEnvironment={{ endpoint: 'https://env/v1', model: 'env-model', apiKey: 'k' }} onClearLlm={vi.fn()} onSave={onSave} onRestore={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByLabelText(/API key/)).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText(/Base URL/)).toHaveAttribute('placeholder', 'https://env/v1');
    await user.type(screen.getByLabelText(/Model/), 'mine');
    await user.click(screen.getByRole('button', { name: 'Save customization' }));
    expect(onSave).toHaveBeenCalledWith(expect.anything(), { endpoint: '', model: 'mine', apiKey: '' });
  });

  it('accepts a root-relative same-origin LLM endpoint', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<SettingsModal settings={settings} llmReady llm={{ endpoint: '', model: '', apiKey: '' }} llmEnvironment={{ endpoint: '', model: '', apiKey: '' }} onClearLlm={vi.fn()} onSave={onSave} onRestore={vi.fn()} onClose={vi.fn()} />);
    await user.type(screen.getByLabelText(/Base URL/), '/api');
    await user.click(screen.getByRole('button', { name: 'Save customization' }));
    expect(onSave).toHaveBeenCalledWith(expect.anything(), { endpoint: '/api', model: '', apiKey: '' });
  });

  it('rejects a non-root-relative endpoint path', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<SettingsModal settings={settings} llmReady llm={{ endpoint: '', model: '', apiKey: '' }} llmEnvironment={{ endpoint: '', model: '', apiKey: '' }} onClearLlm={vi.fn()} onSave={onSave} onRestore={vi.fn()} onClose={vi.fn()} />);
    await user.type(screen.getByLabelText(/Base URL/), 'api');
    await user.click(screen.getByRole('button', { name: 'Save customization' }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('clears the LLM fields when removing the saved connection', async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    const empty = { endpoint: '', model: '', apiKey: '' };
    function Harness() {
      const [llm, setLlm] = React.useState({ endpoint: 'https://x', model: 'm', apiKey: 'k' });
      return <SettingsModal settings={settings} llmReady llm={llm} llmEnvironment={empty} onClearLlm={() => { onClear(); setLlm(empty); }} onSave={vi.fn()} onRestore={vi.fn()} onClose={vi.fn()} />;
    }
    render(<Harness />);
    expect(screen.getByLabelText(/Model/)).toHaveValue('m');
    await user.click(screen.getByRole('button', { name: 'Remove saved connection' }));
    expect(onClear).toHaveBeenCalled();
    expect(screen.getByLabelText(/Base URL/)).toHaveValue('');
    expect(screen.getByLabelText(/Model/)).toHaveValue('');
    expect(screen.getByLabelText(/API key/)).toHaveValue('');
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<SettingsModal settings={settings} llmReady llm={{ endpoint: '', model: '', apiKey: '' }} llmEnvironment={{ endpoint: '', model: '', apiKey: '' }} onClearLlm={vi.fn()} onSave={vi.fn()} onRestore={vi.fn()} onClose={onClose} />);
    await user.click(screen.getByRole('tab', { name: 'General' }));
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});
