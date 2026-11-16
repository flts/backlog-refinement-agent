import type { AgentIntent, ItemType } from '../contracts';

export type AgentCommandId = 'refine' | 'continue' | 'break-down' | 'assess' | 'new-session';

export interface AgentCommandDef {
  id: AgentCommandId;
  /** Palette label. */
  label: string;
  description: string;
  /** Composer slash command, without the slash; undefined = palette only. */
  slash?: string;
  intent?: AgentIntent;
}

export const AGENT_COMMANDS: readonly AgentCommandDef[] = [
  { id: 'refine', label: 'Refine this item', description: 'Ask the agent to refine the current item', intent: 'refine' },
  { id: 'continue', label: 'Continue with current information', description: 'Stop asking and capture what is still unknown', slash: 'continue', intent: 'continue' },
  { id: 'break-down', label: 'Break down', description: 'Propose child items for your review', slash: 'break-down', intent: 'breakdown' },
  { id: 'assess', label: 'Assess quality', description: 'Check the item against the quality criteria', slash: 'assess', intent: 'assess' },
  { id: 'new-session', label: 'New session', description: 'Start a fresh conversation for this item', slash: 'new-session' },
];

const childTypeLabels: Record<string, string> = { feature: 'features', 'user-story': 'user stories', enabler: 'enablers' };
const childTypeSlugs: Record<string, string> = { feature: 'features', 'user-story': 'stories', enabler: 'enablers' };

/** Child item types an item can be broken down into (mirrors the Break this down buttons). */
export function childTypesFor(type: ItemType | undefined): ItemType[] {
  if (type === 'capability') return ['feature', 'enabler'];
  if (type === 'feature') return ['user-story', 'enabler'];
  return [];
}

/** A palette / slash entry; `childType` is set for the break-down variants. */
export interface AgentCommandEntry extends AgentCommandDef {
  key: string;
  childType?: ItemType;
}

/**
 * The commands that make sense for the item type. Break down is offered once per child type: the first is `/break-down`,
 * further ones are `/break-down-<kind>` (for example `/break-down-enablers`).
 */
export function agentCommandsFor(itemType: ItemType | undefined): AgentCommandEntry[] {
  const children = childTypesFor(itemType);
  return AGENT_COMMANDS.flatMap((command): AgentCommandEntry[] => {
    if (command.id !== 'break-down') return [{ ...command, key: command.id }];
    return children.map((childType, index) => ({
      ...command, key: `break-down:${childType}`, childType,
      label: `Break down into ${childTypeLabels[childType]}`, description: `Propose ${childTypeLabels[childType]} for your review`,
      slash: index === 0 ? 'break-down' : `break-down-${childTypeSlugs[childType]}`,
    }));
  });
}

export interface AgentCommandHandlers {
  onRunIntent: (intent: AgentIntent, childType?: ItemType) => void;
  onNewSession: () => void;
}

export function runAgentCommand(command: Pick<AgentCommandEntry, 'id' | 'intent' | 'childType'>, handlers: AgentCommandHandlers): void {
  if (command.id === 'new-session') handlers.onNewSession();
  else if (command.intent) handlers.onRunIntent(command.intent, command.childType);
}
