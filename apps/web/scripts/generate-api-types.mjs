// Generates src/api/backlog.schema.d.ts from contracts/openapi/backlog-api.json.
// Run: pnpm --filter @backlog/web api:types   (the stale-check test imports `generateApiTypes`).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const specPath = join(root, '../../contracts/openapi/backlog-api.json');
export const outputPath = join(root, 'src/api/backlog.schema.d.ts');

const banner = '/**\n * This file was generated from contracts/openapi/backlog-api.json by `pnpm api:types`. Do not edit.\n */\n\n';

/** The snapshot paths start with the service mount point; the client's `baseUrl` (api.backlog) already has it. */
export const pathPrefix = '/api/backlog';

function stripPathPrefix(spec) {
  spec.paths = Object.fromEntries(Object.entries(spec.paths).map(([path, item]) => [path.startsWith(pathPrefix) ? path.slice(pathPrefix.length) || '/' : path, item]));
  return spec;
}

export function readApiTypes() {
  return readFileSync(outputPath, 'utf8');
}

export async function generateApiTypes() {
  const spec = stripPathPrefix(JSON.parse(readFileSync(specPath, 'utf8')));
  return banner + astToString(await openapiTS(spec));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(outputPath, await generateApiTypes());
  console.log(`Wrote ${outputPath}`);
}
