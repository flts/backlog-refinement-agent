import { test as base, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { WEB_URL, type UserKey } from './env';
import { authFile, loginWithForm } from './login';

export interface Session { page: Page; context: BrowserContext }

/**
 * A fresh browser context signed in as `user`. The context starts from the Keycloak SSO cookies saved by global setup, so the
 * SPA's OIDC redirect completes without the form (the form is used as a fallback). `projectId` preselects the project.
 */
export async function openAs(browser: Browser, user: UserKey, options: { projectId?: string } = {}): Promise<Session> {
  const context = await browser.newContext({ storageState: authFile(user), viewport: { width: 1600, height: 1000 } });
  if (options.projectId) {
    await context.addInitScript((id) => { try { localStorage.setItem('selected-project-id', id); } catch { /* ignore */ } }, options.projectId);
  }
  const page = await context.newPage();
  await page.goto(WEB_URL);
  if (await page.locator('#username').isVisible({ timeout: 3000 }).catch(() => false)) await loginWithForm(page, user);
  await expect(page.getByRole('button', { name: /^Account: / })).toBeVisible();
  return { page, context };
}

export const test = base.extend<{ signIn: (user: UserKey, options?: { projectId?: string }) => Promise<Page> }>({
  signIn: async ({ browser }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async (user, options) => {
      const session = await openAs(browser, user, options);
      contexts.push(session.context);
      return session.page;
    });
    await Promise.all(contexts.map((context) => context.close()));
  },
});

export { expect };

/** Opens an item from the backlog tree (the tree row's select button shows "<Type> <title>"). */
export async function selectItem(page: Page, title: string): Promise<void> {
  await page.getByRole('complementary', { name: 'Backlog' }).getByRole('button', { name: new RegExp(`^(Cap|Feat|Story|Enabler) ${escapeRegExp(title)}`) }).click();
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue(title);
}

export const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const documentBox = (page: Page) => page.getByRole('textbox', { name: 'Document (Markdown)' });
export const chat = (page: Page) => page.getByRole('region', { name: 'Refinement workspace' });
