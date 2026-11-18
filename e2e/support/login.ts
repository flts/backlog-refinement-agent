import path from 'node:path';
import type { Page } from '@playwright/test';
import { PASSWORD, users, type UserKey } from './env';

export const authFile = (user: UserKey) => path.resolve(import.meta.dirname, '..', '.auth', `${user}.json`);

/** Fills the real Keycloak login form (the SPA redirects there with Authorization Code + PKCE). */
export async function loginWithForm(page: Page, user: UserKey): Promise<void> {
  await page.locator('#username').fill(users[user].email);
  await page.locator('#password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
}
