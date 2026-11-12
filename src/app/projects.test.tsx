import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Projects } from './Projects';
import { backlogDatabase } from '../infrastructure/storage/database';
import { serializeProjectBackup } from '../application/project-backup';

beforeEach(async () => { await backlogDatabase.open(); });
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  backlogDatabase.close();
  await backlogDatabase.delete();
});

describe('project workspace', () => {
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

  it('creates isolated projects and deletes the final refinement session', async () => {
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
    const deleteSession = await screen.findByRole('button', { name: 'Delete refinement session' });
    await waitFor(() => expect(deleteSession).toBeEnabled());
    const oldSession = (await backlogDatabase.sessions.toArray())[0];
    await user.click(deleteSession);
    await waitFor(async () => {
      const sessions = await backlogDatabase.sessions.toArray();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).not.toBe(oldSession.id);
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
