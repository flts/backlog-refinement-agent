export function localDevelopmentKey(
  command: string,
  mode: string,
  environment: Record<string, string | undefined>,
): string {
  if (command !== 'serve' || mode !== 'development') return '';
  return environment.LOCAL_LLM_API_KEY ?? '';
}
