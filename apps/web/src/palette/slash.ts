import type { AgentCommandEntry } from './commands';

/** The commands whose slash name starts with what is typed after the `/`, when the whole message is just `/word` (no space yet). */
export function matchSlash(value: string, commands: readonly AgentCommandEntry[]): AgentCommandEntry[] | undefined {
  const typed = /^\/([a-z-]*)$/i.exec(value);
  if (!typed) return undefined;
  const prefix = typed[1].toLowerCase();
  return commands.filter((command) => command.slash && command.slash.startsWith(prefix));
}
