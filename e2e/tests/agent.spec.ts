import { addMember, createItem, createProject, deleteProject, getItem, listItems, listRevisions, uniqueName } from '../support/api';
import { askCard, newMarker, reviewCard, scriptedRun, sendToAgent, setSessionTitle, toolCall } from '../support/agent';
import { users } from '../support/env';
import { chat, documentBox, expect, selectItem, test } from '../support/fixtures';
import { askUser } from '../support/fake-gateway';

const questions = [
  {
    id: 'q1', header: 'Target users', question: 'Who is the primary user of this feature?',
    options: [{ label: 'Customers' }, { label: 'Support agents' }], recommended: 0,
  },
  {
    id: 'q2', header: 'Delivery', question: 'How should the result be delivered?',
    options: [{ label: 'In the web app' }, { label: 'By email' }],
  },
];

const documentProposal = {
  summary: 'Sharpen the summary and add scope',
  baseVersion: 1,
  sections: [
    { id: 's1', heading: 'Summary', mode: 'replace', markdown: 'E2E accepted summary for customers.', rationale: 'Names the user' },
    { id: 's2', heading: 'Scope', mode: 'replace', markdown: 'E2E rejected scope text.', rationale: 'Adds boundaries' },
  ],
};

test.describe('agent refinement (scripted fake LLM)', () => {
  test('ask_user → review → partial accept; history shows the revision via agent', async ({ signIn }) => {
    const marker = newMarker();
    const project = await createProject('alice', uniqueName('E2E agent'));
    try {
      const item = await createItem('alice', project.id, { type: 'feature', title: 'Agent feature' });
      await scriptedRun(marker, [
        setSessionTitle('Refining the agent feature'),
        askUser(questions),
        toolCall('propose_document_changes', documentProposal, 'call_propose'),
        { content: 'Applied the accepted section.' },
      ]);
      const page = await signIn('alice', { projectId: project.id });
      await selectItem(page, item.title);
      await sendToAgent(page, `Please refine this feature. ${marker}`);

      const ask = askCard(page);
      await expect(ask).toBeVisible();
      await expect(ask.getByRole('heading', { name: questions[0].question })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Sessions. Current: Refining the agent feature' })).toBeVisible();

      // Question 1 by keyboard (key 2 selects the second option), question 2 by mouse.
      await ask.getByRole('radio', { name: /Customers/ }).focus();
      await page.keyboard.press('2');
      await expect(ask.getByRole('radio', { name: /Support agents/ })).toBeChecked();
      await page.keyboard.press('Enter');
      await expect(ask.getByRole('heading', { name: questions[1].question })).toBeVisible();
      await ask.getByRole('radio', { name: /In the web app/ }).check();
      await ask.getByRole('button', { name: 'Submit' }).click();

      await expect(page.getByRole('region', { name: 'Your answers' })).toContainText('Support agents');
      const review = reviewCard(page);
      await expect(review.getByRole('heading', { name: documentProposal.summary })).toBeVisible();
      await review.getByRole('button', { name: 'Accept section Summary' }).click();
      await review.getByRole('button', { name: 'Reject section Scope' }).click();
      await review.getByRole('button', { name: 'Apply 1 section' }).click();

      await expect(page.getByRole('region', { name: 'Result of the proposal' })).toBeVisible();
      await expect(documentBox(page)).toContainText('E2E accepted summary for customers.');
      await expect(documentBox(page)).not.toContainText('E2E rejected scope text.');
      await expect(chat(page)).toContainText('Applied the accepted section.');

      await page.getByRole('tab', { name: 'History' }).click();
      await expect(page.getByRole('list', { name: /Versions/ })).toContainText(/v2\s*Alice Owner\s*Via agent/);

      const saved = await getItem('alice', project.id, item.id);
      expect(saved.document).toContain('E2E accepted summary for customers.');
      expect(saved.document).not.toContain('E2E rejected scope text.');
      const revisions = await listRevisions('alice', project.id, item.id);
      expect(revisions[0].origin).toBe('agent');
    } finally {
      await deleteProject('alice', project.id);
    }
  });

  test('breakdown: accepting one of two proposed children creates it under the parent', async ({ signIn }) => {
    const marker = newMarker();
    const project = await createProject('alice', uniqueName('E2E breakdown'));
    try {
      const parent = await createItem('alice', project.id, { type: 'feature', title: 'Parent feature' });
      await scriptedRun(marker, [
        toolCall('propose_child_items', {
          rationale: 'Split by user journey',
          childType: 'user-story',
          children: [
            { proposalId: 'c1', title: 'E2E accepted story', markdown: '## Story\nAs a customer I want to sign in.\n\n## Acceptance criteria\n- [ ] Sign in works' },
            { proposalId: 'c2', title: 'E2E rejected story', markdown: '## Story\nAs an admin I want reports.\n\n## Acceptance criteria\n- [ ] Reports load' },
          ],
        }, 'call_children'),
        { content: 'Created the accepted story.' },
      ]);
      const page = await signIn('alice', { projectId: project.id });
      await selectItem(page, parent.title);
      await sendToAgent(page, `Break this down into stories. ${marker}`);

      const review = reviewCard(page);
      await expect(review.getByRole('heading', { name: 'Split by user journey' })).toBeVisible();
      await review.getByRole('button', { name: 'Accept E2E accepted story' }).click();
      await review.getByRole('button', { name: 'Reject E2E rejected story' }).click();
      await review.getByRole('button', { name: 'Create 1 item' }).click();

      const sidebar = page.getByRole('complementary', { name: 'Backlog' });
      await expect(sidebar.getByRole('button', { name: /^Story E2E accepted story/ })).toBeVisible();
      await expect(sidebar.getByRole('button', { name: /E2E rejected story/ })).toHaveCount(0);
      // Nested under the parent: the parent row now has a collapse toggle.
      await expect(sidebar.getByRole('button', { name: 'Collapse Parent feature' })).toBeEnabled();

      const items = await listItems('alice', project.id);
      const child = items.find((entry) => entry.title === 'E2E accepted story');
      expect(child?.parentId).toBe(parent.id);
      expect(items.some((entry) => entry.title === 'E2E rejected story')).toBe(false);
    } finally {
      await deleteProject('alice', project.id);
    }
  });

  test('a pending ask_user card survives a page reload and can be answered afterwards', async ({ signIn }) => {
    const marker = newMarker();
    const project = await createProject('alice', uniqueName('E2E hydrate'));
    try {
      const item = await createItem('alice', project.id, { type: 'feature', title: 'Hydrate feature' });
      await scriptedRun(marker, [
        setSessionTitle('Hydration session'),
        askUser(questions.slice(0, 1)),
        { content: 'Thanks, noted.' },
      ]);
      const page = await signIn('alice', { projectId: project.id });
      await selectItem(page, item.title);
      await sendToAgent(page, `Ask me something. ${marker}`);
      await expect(askCard(page)).toBeVisible();

      await page.reload();
      await selectItem(page, item.title);
      const ask = askCard(page);
      await expect(ask).toBeVisible();
      await expect(ask.getByRole('heading', { name: questions[0].question })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Sessions. Current: Hydration session' })).toBeVisible();

      await ask.getByRole('radio', { name: /Customers/ }).check();
      await ask.getByRole('button', { name: 'Submit' }).click();
      await expect(page.getByRole('region', { name: 'Your answers' })).toContainText('Customers');
      await expect(chat(page)).toContainText('Thanks, noted.');
    } finally {
      await deleteProject('alice', project.id);
    }
  });

  test("bob cannot see alice's agent session for the same item", async ({ signIn }) => {
    const marker = newMarker();
    const project = await createProject('alice', uniqueName('E2E privacy'));
    try {
      await addMember('alice', project.id, users.bob.email);
      const item = await createItem('alice', project.id, { type: 'feature', title: 'Private feature' });
      await scriptedRun(marker, [setSessionTitle('Alice private session'), askUser(questions.slice(0, 1))]);
      const alice = await signIn('alice', { projectId: project.id });
      await selectItem(alice, item.title);
      await sendToAgent(alice, `My private conversation. ${marker}`);
      await expect(askCard(alice)).toBeVisible();
      await expect(alice.getByRole('button', { name: 'Sessions. Current: Alice private session' })).toBeVisible();

      await expect(alice.getByRole('complementary', { name: 'Backlog' }).getByText('Needs your input')).toBeVisible();

      const bob = await signIn('bob', { projectId: project.id });
      await selectItem(bob, item.title);
      await expect(askCard(bob)).toHaveCount(0);
      await expect(chat(bob)).not.toContainText('My private conversation');
      const picker = bob.getByRole('button', { name: /^Sessions\. Current:/ });
      await expect(picker).toHaveAccessibleName('Sessions. Current: New session');
      await picker.click();
      const list = bob.getByRole('group', { name: 'Your refinement sessions' });
      await expect(list).toContainText('No sessions yet');
      await expect(list).not.toContainText('Alice private session');
      await expect(bob.getByRole('complementary', { name: 'Backlog' }).getByText('Needs your input')).toHaveCount(0);
    } finally {
      await deleteProject('alice', project.id);
    }
  });
});
