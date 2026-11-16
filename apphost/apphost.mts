// Aspire TypeScript AppHost for the local dev loop (`pnpm dev` at the repo root runs `aspire run` here).
// Resource graph and env contracts are documented in apphost/README.md and docs/architecture.md.

import path from 'node:path';
import { createBuilder, refExpr, type UvicornAppResource } from './.aspire/modules/aspire.mjs';

const builder = await createBuilder();
const config = builder.getConfiguration();
const repoRoot = path.resolve(await builder.appHostDirectory(), '..');
const skillsDir = path.join(repoRoot, 'skills');

// `Parameters:<name>` from user secrets (`aspire secret set`), env (`Parameters__<name>`) or config.
// A parameter added with a literal value ignores configuration, so the override is resolved here.
async function configured(key: string): Promise<string | undefined> {
  const value =
    (await config.getConfigValue(key)) ??
    (await config.getConfigValue(key.replaceAll('-', '_'))) ??
    process.env[key.replaceAll(':', '__')] ??
    process.env[key.replaceAll(':', '__').replaceAll('-', '_')];
  return value === null || value === undefined || value === '' ? undefined : value;
}

async function parameter(name: string, defaultValue: string, description: string, secret = false) {
  const value = (await configured(`Parameters:${name}`)) ?? defaultValue;
  return builder.addParameter(name, { value, secret }).withDescription(description);
}

const FAKE_GATEWAY_URL = 'http://localhost:8090';
const llmBaseUrlOverride = await configured('Parameters:llm-base-url');
const useFakeGatewaySetting = (await configured('USE_FAKE_GATEWAY'))?.toLowerCase();
const useFakeGateway =
  useFakeGatewaySetting === undefined
    ? llmBaseUrlOverride === undefined
    : ['1', 'true', 'yes', 'on'].includes(useFakeGatewaySetting);

const llmBaseUrl = await parameter(
  'llm-base-url',
  FAKE_GATEWAY_URL,
  'Base URL of the OpenAI-compatible LLM gateway (defaults to the local fake-gateway).',
);
const llmApiKey = await parameter('llm-api-key', 'dev-fake-key', 'API key for the LLM gateway.', true);
const llmChatModel = await parameter('llm-chat-model', 'reasoning-large', 'Chat/reasoning model used by the agent.');
const embeddingModel = await parameter('embedding-model', 'text-embedding', 'Embedding model used for indexing.');
const embeddingDim = await parameter('embedding-dim', '1536', 'Embedding vector dimension (must match the model).');

// PostgreSQL with pgvector. Data persists in a named volume across runs.
const postgres = await builder
  .addPostgres('postgres')
  .withImage('pgvector/pgvector', { tag: 'pg17' })
  .withDataVolume();
const backlogDb = await postgres.addDatabase('backlogdb');
const agentDb = await postgres.addDatabase('agentdb');

// Keycloak on a fixed HTTP port so the issuer and the SPA redirect URIs are stable.
// No data volume: the `backlog` realm is re-imported from deploy/keycloak/realms on every run.
const keycloak = await builder
  .addKeycloak('keycloak', { port: 8080 })
  .withRealmImport('../deploy/keycloak/realms')
  .withoutHttpsCertificate();
const oidcIssuer = refExpr`${await keycloak.getEndpoint('http')}/realms/backlog`;

// Optional scripted OpenAI-compatible gateway (deploy/fake-gateway). Standalone uv project with its own .venv.
let fakeGateway: UvicornAppResource | undefined;
if (useFakeGateway) {
  fakeGateway = await builder
    .addUvicornApp('fake-gateway', '../deploy/fake-gateway', 'fake_gateway:app')
    .withVirtualEnvironment('.venv')
    .withUv()
    .withHttpEndpoint({ port: 8090 })
    .withoutHttpsCertificate()
    .withEnvironment('FAKE_EMBEDDING_DIM', embeddingDim)
    .withEnvironment('FAKE_GATEWAY_MODELS', refExpr`${llmChatModel},${embeddingModel}`)
    .withHttpHealthCheck({ path: '/healthz' });
  const script = await configured('FAKE_GATEWAY_SCRIPT');
  if (script) {
    await fakeGateway.withEnvironment('FAKE_GATEWAY_SCRIPT', path.resolve(repoRoot, script));
  }
}

// Python services share the uv workspace venv at the repo root. Every service syncs all workspace
// packages (non-exact) so parallel installers converge on the same environment instead of pruning
// each other's dependencies.
const uvWorkspaceSync = { args: ['sync', '--all-packages', '--inexact'] };
const workspaceVenv = '../../.venv';

const backlogApi = await builder
  .addUvicornApp('backlog-api', '../services/backlog-api', 'backlog_api.main:app')
  .withVirtualEnvironment(workspaceVenv)
  .withUv(uvWorkspaceSync)
  .withHttpEndpoint({ port: 8001 })
  .withoutHttpsCertificate()
  .withReference(backlogDb)
  .withReference(keycloak)
  .waitFor(backlogDb)
  .waitFor(keycloak)
  .withEnvironment('BACKLOG_ENV', 'development')
  .withEnvironment('BACKLOG_OIDC_ISSUER', oidcIssuer)
  .withEnvironment('BACKLOG_OIDC_AUDIENCE', 'backlog-api')
  .withEnvironment('BACKLOG_LLM_BASE_URL', llmBaseUrl)
  .withEnvironment('BACKLOG_LLM_API_KEY', llmApiKey)
  .withEnvironment('BACKLOG_EMBEDDING_MODEL', embeddingModel)
  .withEnvironment('BACKLOG_EMBEDDING_DIM', embeddingDim)
  .withEnvironment('BACKLOG_SKILLS_DIR', skillsDir)
  .withEnvironment('BACKLOG_AUTO_MIGRATE', 'true')
  .withHttpHealthCheck({ path: '/healthz' });

const agentService = await builder
  .addUvicornApp('agent-service', '../services/agent-service', 'agent_service.main:app')
  .withVirtualEnvironment(workspaceVenv)
  .withUv(uvWorkspaceSync)
  .withHttpEndpoint({ port: 8002 })
  .withoutHttpsCertificate()
  .withReference(agentDb)
  .withReference(keycloak)
  .withReference(backlogApi)
  .waitFor(agentDb)
  .waitFor(keycloak)
  .waitFor(backlogApi)
  .withEnvironment('AGENT_ENV', 'development')
  .withEnvironment('AGENT_OIDC_ISSUER', oidcIssuer)
  .withEnvironment('AGENT_OIDC_AUDIENCE', 'agent-service')
  .withEnvironment('AGENT_BACKLOG_API_URL', backlogApi.getEndpoint('http'))
  .withEnvironment('AGENT_LLM_BASE_URL', llmBaseUrl)
  .withEnvironment('AGENT_LLM_API_KEY', llmApiKey)
  .withEnvironment('AGENT_LLM_MODEL', llmChatModel)
  .withEnvironment('AGENT_SKILLS_DIR', skillsDir)
  .withEnvironment('AGENT_AUTO_MIGRATE', 'true')
  .withHttpHealthCheck({ path: '/healthz' });

if (fakeGateway) {
  await backlogApi.waitFor(fakeGateway);
  await agentService.waitFor(fakeGateway);
}

// The Vite dev server proxies /api/backlog and /api/agent to these URLs (see apps/web/vite.config.ts).
await builder
  .addViteApp('web', '../apps/web')
  .withPnpm()
  .withHttpEndpoint({ port: 5173 })
  .withReference(backlogApi)
  .withReference(agentService)
  .withEnvironment('BACKLOG_API_URL', backlogApi.getEndpoint('http'))
  .withEnvironment('AGENT_API_URL', agentService.getEndpoint('http'))
  .withEnvironment('AUTH_MODE', 'oidc')
  .withEnvironment('OIDC_AUTHORITY', oidcIssuer)
  .withEnvironment('OIDC_CLIENT_ID', 'backlog-web')
  .withExternalHttpEndpoints();

await builder.build().run();
