import { createItem, createProject, deleteProject, uniqueName } from '../support/api';
import { users } from '../support/env';
import { expect, selectItem, test } from '../support/fixtures';

test('alice shares a project with bob; bob is a read-only contributor for settings; carol cannot see it', async ({ signIn }) => {
  const name = uniqueName('E2E share');
  const alice = await signIn('alice');

  await test.step('alice creates a project in the UI', async () => {
    await alice.getByRole('button', { name: /^(Project: |Choose a project)/ }).click();
    await alice.getByRole('menuitem', { name: 'New project…' }).click();
    await alice.getByLabel('Project name').fill(name);
    await alice.getByRole('button', { name: 'Create project' }).click();
    await expect(alice.getByRole('button', { name: `Project: ${name}` })).toBeVisible();
  });
  const projectId = await alice.evaluate(() => localStorage.getItem('selected-project-id'));
  expect(projectId).toBeTruthy();

  try {
    await createItem('alice', projectId!, { type: 'capability', title: 'Shared capability' });

    await test.step('alice adds bob as contributor in the Share dialog', async () => {
      await alice.getByRole('button', { name: 'Share', exact: true }).click();
      const dialog = alice.getByRole('dialog', { name });
      await dialog.getByLabel('Add by email address').fill(users.bob.email);
      await dialog.getByLabel('Role', { exact: true }).selectOption('contributor');
      await dialog.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(dialog.getByRole('list', { name: 'Project members' })).toContainText(users.bob.email);
      await expect(dialog.getByLabel(`Role of ${users.bob.email}`)).toHaveValue('contributor');
      await dialog.getByRole('button', { name: 'Done' }).click();
    });

    await test.step('bob sees the project and its item, and project settings are read-only', async () => {
      const bob = await signIn('bob', { projectId: projectId! });
      await expect(bob.getByRole('button', { name: `Project: ${name}` })).toBeVisible();
      await selectItem(bob, 'Shared capability');

      await bob.getByRole('button', { name: `Project: ${name}` }).click();
      await bob.getByRole('menuitem', { name: 'Project settings…' }).click();
      const settings = bob.getByRole('dialog', { name: 'Project settings' });
      await expect(settings.getByText('Only project owners can change project settings.')).toBeVisible();
      await settings.getByRole('tab', { name: 'Capability' }).click();
      const template = settings.getByRole('textbox', { name: 'Capability template' });
      await expect(template).toBeVisible();
      await expect(template).toHaveAttribute('readonly', '');
      await expect(settings.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
      await expect(settings.getByRole('button', { name: 'Reset to default' })).toHaveCount(0);
      await settings.getByRole('button', { name: 'Close project settings' }).click();

      // The owner can edit the same template (the control group for the read-only assertion).
      await alice.getByRole('button', { name: `Project: ${name}` }).click();
      await alice.getByRole('menuitem', { name: 'Project settings…' }).click();
      const ownerSettings = alice.getByRole('dialog', { name: 'Project settings' });
      await ownerSettings.getByRole('tab', { name: 'Capability' }).click();
      await expect(ownerSettings.getByRole('textbox', { name: 'Capability template' })).not.toHaveAttribute('readonly', '');
      await ownerSettings.getByRole('button', { name: 'Close project settings' }).click();
    });

    await test.step('carol (not a member) does not see the project', async () => {
      const carol = await signIn('carol');
      await expect(carol.getByText('Create or import a project to start a backlog.')).toBeVisible();
      await carol.getByRole('button', { name: 'Choose a project' }).click();
      await expect(carol.getByRole('menuitemradio', { name })).toHaveCount(0);
    });
  } finally {
    await deleteProject('alice', projectId!);
  }
});
