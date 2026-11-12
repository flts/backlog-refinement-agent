import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Projects } from './Projects';
import { backlogDatabase } from '../infrastructure/storage/database';
import { serializeProjectBackup } from '../application/project-backup';
import { defaultUserSettings } from '../infrastructure/storage/SettingsRepository';
import { serializeConfig } from './config-io';

beforeEach(async () => { await backlogDatabase.open(); });
afterEach(async () => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  backlogDatabase.close();
  await backlogDatabase.delete();
});

describe('project workspace', () => {
  it('imports saved configuration from Settings and does not leave stale edits in the modal', async () => {
    const time = '2026-01-01T00:00:00.000Z';
    await backlogDatabase.projects.add({ id: 'p', name: 'Project', createdAt: time, updatedAt: time });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    const { container } = render(<Projects />);
    await user.click(await screen.findByRole('button', { name: 'Open settings' }));
    expect(screen.queryByText('Agent & settings')).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText('Base refinement principles'));
    await user.type(screen.getByLabelText('Base refinement principles'), 'Unsaved');
    await user.click(screen.getByRole('tab', { name: 'Backup' }));
    const invalid = new File(['invalid'], 'invalid.json', { type: 'application/json' });
    Object.defineProperty(invalid, 'text', { value: async () => 'invalid' });
    const input = container.querySelector<HTMLInputElement>('.settings-modal input[type="file"]')!;
    fireEvent.change(input, { target: { files: [invalid] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not import configuration');
    expect(screen.getByRole('tab', { name: 'Backup' })).toBeVisible();
    expect(screen.getByLabelText('Base refinement principles')).toHaveValue('Unsaved');
    const json = serializeConfig({ ...defaultUserSettings, principles: 'Imported' });
    const file = new File([json], 'backup.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: async () => json });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'Backup' })).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(screen.getByLabelText('Base refinement principles')).toHaveValue('Imported');
    await user.click(screen.getByRole('button', { name: 'Save customization' }));
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'Backup' })).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(screen.getByLabelText('Base refinement principles')).toHaveValue('Imported');
  });

  it('restores the selected project and falls back when it has been deleted', async () => {
    const time = '2026-01-01T00:00:00.000Z';
    await backlogDatabase.projects.bulkAdd([
      { id: 'alpha', name: 'Alpha', createdAt: time, updatedAt: time },
      { id: 'beta', name: 'Beta', createdAt: time, updatedAt: time },
    ]);
    const user = userEvent.setup();
    const { unmount } = render(<Projects />);
    const selector = await screen.findByLabelText('Choose project');
    await user.selectOptions(selector, 'beta');
    await waitFor(() => expect(localStorage.getItem('selected-project-id')).toBe('beta'));
    unmount();
    const reopened = render(<Projects />);
    expect(await screen.findByLabelText('Choose project')).toHaveValue('beta');
    reopened.unmount();
    await backlogDatabase.projects.delete('beta');
    render(<Projects />);
    expect(await screen.findByLabelText('Choose project')).toHaveValue('alpha');
    await waitFor(() => expect(localStorage.getItem('selected-project-id')).toBe('alpha'));
  });

  it('reports when the project preference cannot be saved', async () => {
    const time = '2026-01-01T00:00:00.000Z';
    await backlogDatabase.projects.add({ id: 'p', name: 'Project', createdAt: time, updatedAt: time });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
    render(<Projects />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not remember the selected project: Storage unavailable');
    expect(await screen.findByLabelText('Choose project')).toHaveValue('p');
  });

  it('discloses the resolved runtime AI endpoint for selected project sources', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ endpoint: 'https://proxy.example', model: 'model', streaming: false }),
    }));
    await backlogDatabase.projects.add({ id: 'p', name: 'Project', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    render(<Projects />);
    expect(await screen.findByText(/0 selected sources sent to https:\/\/proxy\.example/)).toBeInTheDocument();
  });

  it('imports a project and imports an existing project as a separate copy', async () => {
    const time = '2026-01-01T00:00:00.000Z';
    const json = await serializeProjectBackup({
      project: { id: 'imported', name: 'Imported', createdAt: time, updatedAt: time },
      items: [], sources: [], relationships: [], sessions: [],
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(window, 'prompt').mockReturnValue('copy');
    const { container } = render(<Projects />);
    await screen.findByRole('button', { name: 'Import project' });
    const upload = () => {
      const input = container.querySelector<HTMLInputElement>('input[accept=".json,application/json"]')!;
      const file = new File([json], 'project.json', { type: 'application/json' });
      Object.defineProperty(file, 'text', { value: async () => json });
      fireEvent.change(input, { target: { files: [file] } });
    };
    upload();
    await screen.findByRole('button', { name: 'Export project' });
    expect(await backlogDatabase.projects.count()).toBe(1);
    upload();
    await waitFor(async () => expect(await backlogDatabase.projects.count()).toBe(2));
    expect((await backlogDatabase.projects.toArray()).map((entry) => entry.name).sort()).toEqual(['Imported', 'Imported (copy)']);
  });

  it('creates isolated projects and switches and deletes refinement sessions', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<Projects />);
    const name = await screen.findByLabelText('New project name');
    await user.type(name, 'Alpha');
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    await screen.findByRole('button', { name: 'Create first item' });
    await user.click(screen.getByText('Project sources (0)'));
    await user.type(screen.getByLabelText('Reference name'), 'Specification');
    await user.type(screen.getByLabelText('Reference URL'), 'https://example.com/spec');
    await user.type(screen.getByLabelText('Reference text'), 'Source content');
    await user.click(screen.getByRole('button', { name: 'Add reference' }));
    const source = await screen.findByRole('checkbox', { name: 'Specification' });
    expect(source).not.toBeChecked();
    await user.click(source);
    await waitFor(() => expect(source).toBeChecked());
    await user.click(screen.getByRole('button', { name: 'Create first item' }));
    await user.type(screen.getByLabelText(/Working title/), 'Alpha work');
    await user.click(screen.getByRole('button', { name: /Create and refine/ }));
    const sessionSelect = await screen.findByRole('combobox', { name: 'Choose refinement session' });
    await waitFor(() => expect(sessionSelect).toBeEnabled());
    const firstSessionId = (sessionSelect as HTMLSelectElement).value;
    await user.click(screen.getByRole('button', { name: 'Start a new refinement session' }));
    await waitFor(() => expect(sessionSelect.querySelectorAll('option')).toHaveLength(2));
    const secondSessionId = (sessionSelect as HTMLSelectElement).value;
    expect(secondSessionId).not.toBe(firstSessionId);
    await user.selectOptions(sessionSelect, firstSessionId);
    await waitFor(() => expect(sessionSelect).toHaveValue(firstSessionId));
    await user.click(screen.getByRole('button', { current: 'page' }));
    expect(sessionSelect).toHaveValue(firstSessionId);
    await user.selectOptions(sessionSelect, secondSessionId);
    await waitFor(() => expect(sessionSelect).toHaveValue(secondSessionId));
    const deleteSession = await screen.findByRole('button', { name: 'Delete refinement session' });
    await waitFor(() => expect(deleteSession).toBeEnabled());
    await user.click(deleteSession);
    await waitFor(async () => {
      const sessions = await backlogDatabase.sessions.toArray();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe(firstSessionId);
    });
    await user.click(deleteSession);
    await waitFor(async () => {
      const sessions = await backlogDatabase.sessions.toArray();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).not.toBe(firstSessionId);
    });
    await user.type(screen.getByLabelText('New project name'), 'Beta');
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(screen.queryByDisplayValue('Alpha work')).not.toBeInTheDocument());
    const select = await screen.findByLabelText('Choose project');
    const alpha = (await backlogDatabase.projects.toArray()).find((project) => project.name === 'Alpha')!;
    await user.selectOptions(select, alpha.id);
    await screen.findByDisplayValue('Alpha work');
    await user.click(screen.getByText('Project sources (1)'));
    expect(await screen.findByRole('checkbox', { name: 'Specification' })).toBeChecked();
  });
});
