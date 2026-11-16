import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject, type SyntheticEvent } from 'react';
import { findMention, insertMention, matchMentions, type MentionCandidate } from '../context/mentions';
import type { AgentCommandEntry } from './commands';
import { matchSlash } from './slash';

export interface ComposerAssistOptions {
  value: string;
  onChange: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** The composer accepts input (not busy / running). */
  enabled: boolean;
  /** Slash commands available for the current item; omit to disable the `/` menu. */
  slashCommands?: readonly AgentCommandEntry[];
  onSlashCommand?: (command: AgentCommandEntry) => void;
  /** Items that can be mentioned with `@`; omit to disable the picker. */
  mentionItems?: readonly MentionCandidate[];
}

interface MenuOption { id: string; label: string; badge?: string; description?: string }

/**
 * Slash menu (`/` at the start) and item picker (`@`) for the composer. The textarea keeps focus and points to the open
 * listbox with `aria-controls` / `aria-activedescendant`; the returned `onKeyDown` must run before the composer's own
 * handling and returns true when it consumed the key.
 */
export function useComposerAssist({ value, onChange, textareaRef, enabled, slashCommands, onSlashCommand, mentionItems }: ComposerAssistOptions) {
  const menuId = useId();
  const [caret, setCaret] = useState(value.length);
  const [active, setActive] = useState(0);
  const [dismissedKey, setDismissedKey] = useState<string>();
  const pendingCaret = useRef<number | undefined>(undefined);

  const slashMatches = useMemo(() => (enabled && slashCommands ? matchSlash(value, slashCommands) : undefined), [enabled, slashCommands, value]);
  const mention = useMemo(() => (enabled && mentionItems && !slashMatches ? findMention(value, Math.min(caret, value.length)) : undefined), [enabled, mentionItems, slashMatches, value, caret]);
  const mentionMatches = useMemo(() => (mention && mentionItems ? matchMentions(mentionItems, mention.query) : []), [mention, mentionItems]);

  const kind: 'slash' | 'mention' | undefined = slashMatches && slashMatches.length > 0 ? 'slash' : mention && mentionMatches.length > 0 ? 'mention' : undefined;
  const triggerKey = kind === 'slash' ? `slash:${value}` : kind === 'mention' ? `mention:${mention?.start}:${mention?.query}` : undefined;
  const open = kind !== undefined && triggerKey !== dismissedKey;

  const options: MenuOption[] = !open ? [] : kind === 'slash'
    ? slashMatches!.map((command) => ({ id: `${menuId}-slash-${command.key}`, label: `/${command.slash}`, description: command.description }))
    : mentionMatches.map((item) => ({ id: `${menuId}-mention-${item.id}`, label: item.title || 'Untitled item', badge: item.typeLabel }));
  const activeIndex = options.length === 0 ? -1 : Math.min(active, options.length - 1);

  useEffect(() => { setActive(0); }, [triggerKey]);
  useLayoutEffect(() => {
    if (pendingCaret.current === undefined) return;
    const position = pendingCaret.current;
    pendingCaret.current = undefined;
    textareaRef.current?.setSelectionRange(position, position);
  }, [value, textareaRef]);

  const pick = useCallback((index: number) => {
    if (kind === 'slash') {
      const command = slashMatches?.[index];
      if (!command) return;
      onChange('');
      onSlashCommand?.(command);
    } else if (kind === 'mention' && mention) {
      const item = mentionMatches[index];
      if (!item) return;
      const result = insertMention(value, mention, item);
      pendingCaret.current = result.caret;
      onChange(result.value);
      setCaret(result.caret);
    }
    textareaRef.current?.focus();
  }, [kind, slashMatches, mention, mentionMatches, value, onChange, onSlashCommand, textareaRef]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || options.length === 0 || event.nativeEvent.isComposing) return false;
    switch (event.key) {
      case 'ArrowDown': setActive((activeIndex + 1) % options.length); break;
      case 'ArrowUp': setActive((activeIndex - 1 + options.length) % options.length); break;
      case 'Home': setActive(0); break;
      case 'End': setActive(options.length - 1); break;
      case 'Enter': case 'Tab':
        if (event.shiftKey) return false;
        pick(activeIndex);
        break;
      case 'Escape': setDismissedKey(triggerKey); break;
      default: return false;
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
  };

  const label = kind === 'slash' ? 'Slash commands' : 'Mention an item';
  const menu: ReactNode = open ? (
    <div className="composer-menu">
      <div id={menuId} role="listbox" aria-label={label}>
        {options.map((option, index) => (
          <div key={option.id} id={option.id} role="option" aria-selected={index === activeIndex} className="composer-menu-option"
            onMouseDown={(event) => event.preventDefault()} onClick={() => pick(index)}>
            <span className="composer-menu-label">{option.label}</span>
            {option.badge && <span className="composer-menu-badge">{option.badge}</span>}
            {option.description && <span className="composer-menu-desc">{option.description}</span>}
          </div>
        ))}
      </div>
      <p className="sr-only" role="status">{`${label}: ${options.length} ${options.length === 1 ? 'option' : 'options'}. Use the up and down arrows, then Enter or Tab to choose, Escape to close.`}</p>
    </div>
  ) : null;

  return {
    menu,
    onKeyDown,
    /** Spread onto the textarea. */
    textareaProps: {
      ...(open ? { 'aria-controls': menuId, 'aria-activedescendant': options[activeIndex]?.id, 'aria-autocomplete': 'list' as const } : {}),
      onSelect: (event: SyntheticEvent<HTMLTextAreaElement>) => setCaret(event.currentTarget.selectionStart),
    },
    /** Call from the textarea's onChange so the menu reacts to the character just typed. */
    noteCaret: (position: number) => setCaret(position),
  };
}
