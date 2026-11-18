import { addMember, createItem, createProject, deleteProject, getItem, uniqueName, waitForVersion, withSection } from '../support/api';
import { users } from '../support/env';
import { documentBox, expect, selectItem, test } from '../support/fixtures';

test.describe('two people on one item', () => {
  test('presence avatar and live update with an "Updated by" notice', async ({ signIn }) => {
    const project = await createProject('alice', uniqueName('E2E live'));
    try {
      await addMember('alice', project.id, users.bob.email);
      const item = await createItem('alice', project.id, { type: 'feature', title: 'Live feature' });
      const alice = await signIn('alice', { projectId: project.id });
      const bob = await signIn('bob', { projectId: project.id });
      await selectItem(alice, item.title);
      await selectItem(bob, item.title);

      await expect(bob.getByRole('list', { name: 'People viewing this item' })).toContainText('Alice Owner');
      await expect(bob.getByText('Alice Owner is viewing')).toBeVisible();
      await expect(alice.getByRole('list', { name: 'People viewing this item' })).toContainText('Bob Contributor');

      const edited = withSection((await getItem('alice', project.id, item.id)).document, 'Summary', 'Written live by Alice.');
      await documentBox(alice).fill(edited);

      await expect(bob.getByRole('status').filter({ hasText: 'Updated by Alice Owner' })).toBeVisible();
      await expect(documentBox(bob)).toContainText('Written live by Alice.');
    } finally {
      await deleteProject('alice', project.id);
    }
  });

  test('concurrent edits of the same section open the conflict dialog; "Both" keeps both texts', async ({ signIn }) => {
    const project = await createProject('alice', uniqueName('E2E conflict'));
    try {
      await addMember('alice', project.id, users.bob.email);
      const item = await createItem('alice', project.id, { type: 'feature', title: 'Conflict feature' });
      const base = (await getItem('alice', project.id, item.id)).document;
      const alice = await signIn('alice', { projectId: project.id });
      const bob = await signIn('bob', { projectId: project.id });
      await selectItem(alice, item.title);
      await selectItem(bob, item.title);

      // Hold bob's autosave until alice's version is stored, so bob's edit is based on the old version.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      await bob.route('**/api/backlog/projects/*/items/*', async (route) => {
        if (route.request().method() === 'PATCH') await gate;
        await route.continue();
      });

      await documentBox(bob).fill(withSection(base, 'Summary', 'Bob summary.'));
      await documentBox(alice).fill(withSection(base, 'Summary', 'Alice summary.'));
      await waitForVersion('alice', project.id, item.id, item.version + 1);
      release();

      const dialog = bob.getByRole('dialog', { name: /changed this item too/ });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('heading', { name: 'Alice Owner changed this item too' })).toBeVisible();
      await dialog.getByRole('radiogroup', { name: 'Keep which version of Summary?' }).getByLabel('Both').check();
      await dialog.getByRole('button', { name: 'Save resolved version' }).click();
      await expect(dialog).toBeHidden();

      await expect(async () => {
        const saved = await getItem('bob', project.id, item.id);
        expect(saved.document).toContain('Bob summary.');
        expect(saved.document).toContain('Alice summary.');
      }).toPass();
      await expect(documentBox(alice)).toContainText('Bob summary.');
    } finally {
      await deleteProject('alice', project.id);
    }
  });
});
