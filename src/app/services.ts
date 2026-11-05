import { WorkspaceApplicationService } from '../application/workspace-service';
import { RefinementApplicationService } from '../application/refinement-service';
import { IndexedDbRefinementStore } from '../infrastructure/storage/IndexedDbRefinementStore';
import { SettingsRepository } from '../infrastructure/storage/SettingsRepository';
import type { UserSettings } from '../infrastructure/storage/SettingsRepository';
import { ProxyLlmProvider } from '../infrastructure/llm/ProxyLlmProvider';
import { ProxyRefinementProvider } from '../infrastructure/llm/ProxyRefinementProvider';
import { defaultBacklogTemplates } from '../defaults/templates';
import { getLlmConfiguration, type LlmOverrides } from '../infrastructure/llm/llmConfig';

const refinementStore = new IndexedDbRefinementStore();
export const workspace = new WorkspaceApplicationService(refinementStore);
export const settingsRepository = new SettingsRepository();

export function makeRefinementService(settings: UserSettings, llm: LlmOverrides): RefinementApplicationService {
  const templates = Object.fromEntries(
    (Object.keys(defaultBacklogTemplates) as (keyof typeof defaultBacklogTemplates)[])
      .map((type) => [type, settings.templates[type]?.trim() ? settings.templates[type] : defaultBacklogTemplates[type]]),
  ) as typeof defaultBacklogTemplates;
  return new RefinementApplicationService({
    store: refinementStore,
    provider: new ProxyRefinementProvider(
      new ProxyLlmProvider(getLlmConfiguration(llm)),
      settings.instructions,
      templates,
      { principles: settings.principles, typeInstructions: settings.typeInstructions },
    ),
    templates,
    ids: { nextId: () => crypto.randomUUID() },
  });
}
