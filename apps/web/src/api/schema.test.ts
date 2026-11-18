import { describe, expect, it } from 'vitest';
import { generateApiTypes, readApiTypes } from '../../scripts/generate-api-types.mjs';

describe('generated API types', () => {
  it('are up to date with contracts/openapi/backlog-api.json (run `pnpm --filter @backlog/web api:types`)', async () => {
    const fresh: string = await generateApiTypes();
    expect(readApiTypes() === fresh, 'src/api/backlog.schema.d.ts is stale; run `pnpm --filter @backlog/web api:types`').toBe(true);
  }, 60_000);

  it('use the client base URL (api.backlog) as the root of every path', async () => {
    const fresh: string = await generateApiTypes();
    expect(fresh).toContain('"/projects/{project_id}/items/{item_id}"');
    expect(fresh).not.toContain('"/api/backlog/');
  }, 60_000);
});
