import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useBacklogClient } from '../BacklogApiProvider';
import { ifMatch, unwrap } from '../client';
import type { EffectiveGuidance, GuidanceEntry, GuidanceExport, ItemType, TypedGuidanceKind } from '../types';
import { backlogKeys } from './keys';

/** Effective guidance: project override ?? skill default, with `differsFromDefault`, `outdated` and the override `version`. */
export function useGuidance(projectId: string | undefined) {
  const client = useBacklogClient();
  return useQuery({
    queryKey: backlogKeys.guidance(projectId ?? ''),
    enabled: Boolean(projectId),
    queryFn: () => unwrap(client.http.GET('/projects/{project_id}/guidance', { params: { path: { project_id: projectId! } } })),
  });
}

/** The skill defaults, for compare/reset in the project settings. */
export function useGuidanceDefaults(projectId: string | undefined) {
  const client = useBacklogClient();
  return useQuery({
    queryKey: backlogKeys.guidanceDefaults(projectId ?? ''),
    enabled: Boolean(projectId),
    staleTime: 5 * 60_000,
    queryFn: () => unwrap(client.http.GET('/projects/{project_id}/guidance/defaults', { params: { path: { project_id: projectId! } } })),
  });
}

export type GuidanceTarget = { kind: 'principles' } | { kind: TypedGuidanceKind; itemType: ItemType };

/** Owners only. `entry.version` is `If-Match` (0 while the default applies); a stale version rejects with `ConflictError`. */
export function useSaveGuidance(projectId: string) {
  const client = useBacklogClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ target, entry, content, baseSkillVersion }: { target: GuidanceTarget; entry: Pick<GuidanceEntry, 'version'>; content: string; baseSkillVersion?: string | null }): Promise<GuidanceEntry> => {
      const params = { header: { 'If-Match': ifMatch(entry.version) } };
      const body = { content, baseSkillVersion };
      return target.kind === 'principles'
        ? unwrap(client.http.PUT('/projects/{project_id}/guidance/principles', { params: { ...params, path: { project_id: projectId } }, body }))
        : unwrap(client.http.PUT('/projects/{project_id}/guidance/{kind}/{item_type}', { params: { ...params, path: { project_id: projectId, kind: target.kind, item_type: target.itemType } }, body }));
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: backlogKeys.guidance(projectId) }),
  });
}

/** Owners only: drops the override so the skill default applies again. */
export function useResetGuidance(projectId: string) {
  const client = useBacklogClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ target, entry }: { target: GuidanceTarget; entry: Pick<GuidanceEntry, 'version'> }): Promise<GuidanceEntry | undefined> => {
      const params = { header: { 'If-Match': ifMatch(entry.version) } };
      return target.kind === 'principles'
        ? unwrap(client.http.DELETE('/projects/{project_id}/guidance/principles', { params: { ...params, path: { project_id: projectId } } }))
        : unwrap(client.http.DELETE('/projects/{project_id}/guidance/{kind}/{item_type}', { params: { ...params, path: { project_id: projectId, kind: target.kind, item_type: target.itemType } } }));
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: backlogKeys.guidance(projectId) }),
  });
}

/** Members: the guidance export (format v5) of the project; `includeDefaults` adds the effective text of entries without an override. */
export function useExportGuidance(projectId: string) {
  const client = useBacklogClient();
  return useMutation({
    mutationFn: ({ includeDefaults = false }: { includeDefaults?: boolean } = {}): Promise<GuidanceExport> =>
      unwrap(client.http.GET('/projects/{project_id}/guidance/export', { params: { path: { project_id: projectId }, query: { includeDefaults } } })),
  });
}

/** Owners only: replaces all overrides from a v5 export (or a v4 SPA configuration export). Invalid documents reject with a 422 `issues` list. */
export function useImportGuidance(projectId: string) {
  const client = useBacklogClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (document: Record<string, unknown>): Promise<EffectiveGuidance> =>
      unwrap(client.http.POST('/projects/{project_id}/guidance/import', { params: { path: { project_id: projectId } }, body: document })),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: backlogKeys.guidance(projectId) }),
  });
}
