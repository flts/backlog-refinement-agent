import { createItem, createProject, deleteProject, uniqueName } from '../support/api';
import { documentBox, expect, selectItem, test } from '../support/fixtures';

test('alice signs in through Keycloak and sees her project and item', async ({ signIn }) => {
  const project = await createProject('alice', uniqueName('E2E smoke'));
  try {
    const item = await createItem('alice', project.id, { type: 'feature', title: 'Smoke feature' });
    const page = await signIn('alice', { projectId: project.id });
    await expect(page.getByRole('button', { name: `Project: ${project.name}` })).toBeVisible();
    await selectItem(page, item.title);
    await expect(documentBox(page)).toContainText('## Summary');
  } finally {
    await deleteProject('alice', project.id);
  }
});
