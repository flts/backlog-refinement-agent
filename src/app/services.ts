import { WorkspaceApplicationService } from '../application/workspace-service';
import { RefinementApplicationService } from '../application/refinement-service';
import { IndexedDbRefinementStore } from '../infrastructure/storage/IndexedDbRefinementStore';
import { SettingsRepository } from '../infrastructure/storage/SettingsRepository';
import type { UserSettings } from '../infrastructure/storage/SettingsRepository';
import { ProxyLlmProvider } from '../infrastructure/llm/ProxyLlmProvider';
import { ProxyRefinementProvider } from '../infrastructure/llm/ProxyRefinementProvider';
import { getLlmConfiguration } from '../infrastructure/llm/llmConfig';

const refinementStore = new IndexedDbRefinementStore();
export const workspace = new WorkspaceApplicationService(refinementStore);
export const settingsRepository = new SettingsRepository();

export function makeRefinementService(settings: UserSettings): RefinementApplicationService {
  return new RefinementApplicationService({
    store: refinementStore,
    provider: new ProxyRefinementProvider(
      new ProxyLlmProvider(getLlmConfiguration()),
      settings.instructions,
      settings.templates,
      { principles: settings.principles, typeInstructions: settings.typeInstructions },
    ),
    templates: settings.templates,
    ids: { nextId: () => crypto.randomUUID() },
  });
}
