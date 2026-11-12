import { WorkspaceApplicationService } from '../application/workspace-service';
import { RefinementApplicationService } from '../application/refinement-service';
import { IndexedDbRefinementStore } from '../infrastructure/storage/IndexedDbRefinementStore';
import { SettingsRepository } from '../infrastructure/storage/SettingsRepository';
import { ProjectRepository } from '../infrastructure/storage/ProjectRepository';
import type { UserSettings } from '../infrastructure/storage/SettingsRepository';
import { ProxyLlmProvider } from '../infrastructure/llm/ProxyLlmProvider';
import { ProxyRefinementProvider } from '../infrastructure/llm/ProxyRefinementProvider';
import { defaultBacklogTemplates } from '../defaults/templates';
import { getLlmConfiguration, type LlmOverrides, type RuntimeLlmConfig } from '../infrastructure/llm/llmConfig';

export const settingsRepository = new SettingsRepository();
export const projectRepository = new ProjectRepository();
export function makeWorkspace(projectId: string): WorkspaceApplicationService {
  return new WorkspaceApplicationService(projectId, new IndexedDbRefinementStore(projectId));
}

export function makeRefinementService(settings: UserSettings, llm: LlmOverrides, runtime: RuntimeLlmConfig, projectId: string): RefinementApplicationService {
  const refinementStore = new IndexedDbRefinementStore(projectId);
  const templates = Object.fromEntries(
    (Object.keys(defaultBacklogTemplates) as (keyof typeof defaultBacklogTemplates)[])
      .map((type) => [type, settings.templates[type]?.trim() ? settings.templates[type] : defaultBacklogTemplates[type]]),
  ) as typeof defaultBacklogTemplates;
  return new RefinementApplicationService({
    store: refinementStore,
    provider: new ProxyRefinementProvider(
      new ProxyLlmProvider(getLlmConfiguration(llm, runtime)),
      settings.instructions,
      templates,
      { principles: settings.principles, typeInstructions: settings.typeInstructions },
    ),
    templates,
    loadProjectSources: (id) => {
      if (id !== projectId) throw new Error('Cannot load sources from another project.');
      return projectRepository.listSources(id);
    },
    ids: { nextId: () => crypto.randomUUID() },
  });
}
