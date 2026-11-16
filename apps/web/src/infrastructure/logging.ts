export function logError(context: string, cause: unknown, details?: Record<string, unknown>): void {
  console.error(`[backlog-refinement] ${context}`, cause, ...(details ? [details] : []));
}
