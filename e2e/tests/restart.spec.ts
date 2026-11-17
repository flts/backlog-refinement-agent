import { createItem, createProject, deleteProject, getItem, uniqueName } from '../support/api';
import { newMarker, reviewCard, scriptedRun, sendToAgent, toolCall } from '../support/agent';
import { restartAgentService } from '../support/compose';
import { chat, documentBox, expect, selectItem, test } from '../support/fixtures';

const documentProposal = {
  summary: 'Sharpen the summary and add scope',
  baseVersion: 1,
  sections: [
    { id: 's1', heading: 'Summary', mode: 'replace', markdown: 'E2E accepted summary for customers.', rationale: 'Names the user' },
    { id: 's2', heading: 'Scope', mode: 'replace', markdown: 'E2E rejected scope text.', rationale: 'Adds boundaries' },
  ],
};

// Restarting agent-service would break runs of other specs, so playwright.config.ts runs this spec in its own project after the others.
test.describe('agent-service restart (scripted fake LLM, Docker Compose stack)', () => {
  // Approvals are durable once the server rehydrates them after a restart. Until then the SPA must show the recovery card and lose
  // nothing the user typed. Set E2E_DURABLE_APPROVALS=1 against a stack that has the durable approvals.
  test('agent-service restart during review: the decision survives or the recovery card keeps the edits', async ({ signIn }) => {
    test.setTimeout(240_000);
    const durable = process.env.E2E_DURABLE_APPROVALS === '1';
    const marker = newMarker();
    const project = await createProject('alice', uniqueName('E2E restart'));
    try {
      const item = await createItem('alice', project.id, { type: 'feature', title: 'Restart feature' });
      const editedSummary = 'E2E my own summary after the restart.';
      const reproposal = {
        summary: 'Second attempt after the restart',
        baseVersion: 1,
        sections: [{ id: 's1', heading: 'Summary', mode: 'replace', markdown: 'E2E re-proposed summary.', rationale: 'Second attempt' }],
      };
      await scriptedRun(marker, [
        toolCall('propose_document_changes', documentProposal, 'call_propose'),
        ...(durable ? [] : [toolCall('propose_document_changes', reproposal, 'call_reproposal')]),
        { content: 'Done after the restart.' },
      ]);
      const page = await signIn('alice', { projectId: project.id });
      await selectItem(page, item.title);
      await sendToAgent(page, `Please refine this feature. ${marker}`);

      const review = reviewCard(page);
      await expect(review.getByRole('heading', { name: documentProposal.summary })).toBeVisible();
      await review.getByRole('button', { name: 'Edit section Summary' }).click();
      await review.getByRole('textbox', { name: /Edit “Summary”/ }).fill(editedSummary);
      await review.getByRole('button', { name: 'Save and accept' }).click();
      await review.getByRole('button', { name: 'Reject section Scope' }).click();

      await restartAgentService();
      await review.getByRole('button', { name: 'Apply 1 section' }).click();

      if (durable) {
        await expect(page.getByRole('region', { name: 'Result of the proposal' })).toBeVisible();
        await expect(documentBox(page)).toContainText(editedSummary);
        expect((await getItem('alice', project.id, item.id)).document).toContain(editedSummary);
        return;
      }

      // The server lost the approval: nothing was applied, the edit is still on screen and can be re-proposed or abandoned.
      const recovery = chat(page).getByRole('region', { name: 'This proposal can no longer be applied' });
      await expect(recovery).toBeVisible();
      await expect(recovery.getByRole('heading', { name: 'This proposal can no longer be applied' })).toBeFocused();
      await expect(recovery.getByText('Changes you had accepted: 1 of 2')).toBeVisible();
      await recovery.locator('.review-expired-label', { hasText: 'Summary' }).click();
      await expect(recovery.getByText(editedSummary)).toBeVisible();
      await expect(recovery.getByRole('button', { name: 'Start over' })).toBeEnabled();
      expect((await getItem('alice', project.id, item.id)).document).not.toContain(editedSummary);

      await recovery.getByRole('button', { name: 'Ask the agent to re-propose with my edits' }).click();
      const sent = chat(page).getByText('Please re-propose these changes, keeping my edits:');
      await expect(sent).toBeVisible();
      await expect(chat(page)).toContainText(editedSummary);
      await expect(recovery).toHaveCount(0);

      const second = reviewCard(page);
      await expect(second.getByRole('heading', { name: reproposal.summary })).toBeVisible();
      await second.getByRole('button', { name: 'Accept section Summary' }).click();
      await second.getByRole('button', { name: 'Apply 1 section' }).click();
      await expect(page.getByRole('region', { name: 'Result of the proposal' })).toBeVisible();
      await expect(documentBox(page)).toContainText('E2E re-proposed summary.');
      await expect(chat(page)).toContainText('Done after the restart.');
    } finally {
      await deleteProject('alice', project.id);
    }
  });
});
