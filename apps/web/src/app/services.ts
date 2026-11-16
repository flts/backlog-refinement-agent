import { WorkspaceApplicationService } from '../application/workspace-service';
import { IndexedDbRefinementStore } from '../infrastructure/storage/IndexedDbRefinementStore';
import { SettingsRepository } from '../infrastructure/storage/SettingsRepository';
import { ProjectRepository } from '../infrastructure/storage/ProjectRepository';

export const settingsRepository = new SettingsRepository();
export const projectRepository = new ProjectRepository();
export function makeWorkspace(projectId: string): WorkspaceApplicationService {
  return new WorkspaceApplicationService(projectId, new IndexedDbRefinementStore(projectId));
}
