import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { AskUserArgs, AskUserResult } from '../contracts';
import {
  buildResult, chooseOption, chooseOther, emptyDraft, isAnswered, orderedOptions, OTHER_KEY, typeOther, type QuestionDraft,
} from './askUserModel';

export interface AskUserCardProps {
  /** Validated `ask_user` arguments (1–3 questions). */
  args: AskUserArgs;
  /** The agent is busy: nothing can be sent. */
  disabled?: boolean;
  /** Receives a result that has already been validated against the shared contract. */
  onAnswer: (result: AskUserResult) => void;
  /** Focus the card when it appears, unless the user is typing somewhere else. Default true. */
  autoFocus?: boolean;
}

const isEditable = (element: Element | null): boolean =>
  element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && !['radio', 'checkbox', 'button'].includes(element.type));

export function AskUserCard({ args, disabled = false, onAnswer, autoFocus = true }: AskUserCardProps) {
  const { questions } = args;
  const total = questions.length;
  const uid = useId();
  const card = useRef<HTMLElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const otherBox = useRef<HTMLTextAreaElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [index, setIndex] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({});
  const [announcement, setAnnouncement] = useState('');
  const refocusPanel = useRef(false);

  const question = questions[index];
  const draft = drafts[question.id] ?? emptyDraft;
  const options = orderedOptions(question);
  const last = index === total - 1;
  const anyAnswered = questions.some((entry) => isAnswered(drafts[entry.id] ?? emptyDraft));

  useEffect(() => {
    setAnnouncement(`The agent has ${total} ${total === 1 ? 'question' : 'questions'}`);
    // Do not steal focus from a text field the user is typing in (the composer).
    if (autoFocus && !isEditable(document.activeElement)) card.current?.focus({ preventScroll: false });
  }, [total, autoFocus]);

  const announcedIndex = useRef(0);
  useEffect(() => {
    if (announcedIndex.current === index) return;
    announcedIndex.current = index;
    setAnnouncement(`Question ${index + 1} of ${total}: ${questions[index].question}`);
  }, [index, total, questions]);

  useEffect(() => {
    if (!refocusPanel.current) return;
    refocusPanel.current = false;
    const active = document.activeElement;
    if (!active || active === document.body || (panel.current?.contains(active) ?? false) || !card.current?.contains(active)) panel.current?.focus();
  }, [index]);

  const update = (change: (current: QuestionDraft) => QuestionDraft) => setDrafts((all) => ({ ...all, [question.id]: change(all[question.id] ?? emptyDraft) }));

  function goTo(next: number, focusTab = false) {
    const target = Math.min(Math.max(next, 0), total - 1);
    refocusPanel.current = !focusTab;
    setIndex(target);
    if (focusTab) tabRefs.current[target]?.focus();
  }

  function selectOption(optionIndex: number) {
    update((current) => chooseOption(question, current, optionIndex));
  }

  function selectOther() {
    update((current) => chooseOther(question, current));
    if (!question.multiSelect || !draft.other) otherBox.current?.focus();
  }

  function submit(current: Record<string, QuestionDraft> = drafts, skipAll = false) {
    if (disabled) return;
    onAnswer(buildResult(args, current, skipAll));
  }

  function skip() {
    if (disabled) return;
    const next = { ...drafts, [question.id]: { ...emptyDraft, skipped: true } };
    setDrafts(next);
    if (last) submit(next);
    else goTo(index + 1);
  }

  function advance() {
    if (disabled) return;
    if (!last) goTo(index + 1);
    else if (anyAnswered) submit();
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    const editing = isEditable(target);
    if (event.key === 'Escape') {
      event.preventDefault();
      skip();
    } else if (event.key === 'Enter') {
      if (target.closest('button') || event.nativeEvent.isComposing || (editing && event.shiftKey)) return;
      event.preventDefault();
      advance();
    } else if (/^[1-5]$/.test(event.key) && !editing) {
      const number = Number(event.key);
      if (number === OTHER_KEY) {
        event.preventDefault();
        selectOther();
      } else if (options[number - 1]) {
        event.preventDefault();
        selectOption(options[number - 1].index);
      }
    }
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const moves: Record<string, number> = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: total - 1 };
    if (!(event.key in moves) || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    goTo(moves[event.key], true);
  }

  const tabId = (i: number) => `${uid}-tab-${i}`;
  const panelId = `${uid}-panel`;
  const questionId = `${uid}-question`;
  const otherId = `${uid}-other`;
  const GroupRole = question.multiSelect ? 'group' : 'radiogroup';
  const inputType = question.multiSelect ? 'checkbox' : 'radio';

  return (
    <section ref={card} className="ask-card" tabIndex={-1} aria-label="The agent asks" onKeyDown={onKeyDown}>
      <p className="sr-only" role="status">{announcement}</p>
      <header className="ask-head">
        <span className="eyebrow">Agent asks</span>
        <span className="ask-step">Question {index + 1} of {total}</span>
      </header>
      <div className="ask-tabs" role="tablist" aria-label="Questions" onKeyDown={onTabKeyDown}>
        {questions.map((entry, i) => {
          const state = drafts[entry.id] ?? emptyDraft;
          const status = isAnswered(state) ? 'answered' : state.skipped ? 'skipped' : undefined;
          return (
            <button key={entry.id} ref={(element) => { tabRefs.current[i] = element; }} type="button" role="tab" id={tabId(i)} className="ask-tab" data-status={status}
              aria-selected={i === index} aria-controls={panelId} tabIndex={i === index ? 0 : -1} onClick={() => goTo(i, true)}>
              <span aria-hidden="true" className="ask-tab-mark">{status === 'answered' ? '✓' : status === 'skipped' ? '–' : i + 1}</span>
              <span>{entry.header}</span>
              {status && <span className="sr-only">, {status}</span>}
            </button>
          );
        })}
      </div>
      <div ref={panel} className="ask-panel" role="tabpanel" id={panelId} aria-labelledby={tabId(index)} tabIndex={-1} key={question.id}>
        <h3 className="ask-question" id={questionId}>{question.question}</h3>
        {question.rationale && <p className="ask-rationale">{question.rationale}</p>}
        {question.relatedSection && <p className="ask-section"><span className="ask-chip">Section: {question.relatedSection}</span></p>}
        <div role={GroupRole} aria-labelledby={questionId} className="ask-options">
          {options.map(({ index: optionIndex, option, recommended }, position) => (
            <label key={optionIndex} className="ask-option" data-selected={draft.selected.includes(optionIndex) || undefined}>
              <input type={inputType} name={`${uid}-${question.id}`} checked={draft.selected.includes(optionIndex)} disabled={disabled} onChange={() => selectOption(optionIndex)} />
              <span className="ask-option-body">
                <span className="ask-option-label">
                  {option.label}
                  {recommended && <span className="ask-badge">Recommended</span>}
                </span>
                {option.description && <span className="ask-option-desc">{option.description}</span>}
              </span>
              <kbd className="ask-key" aria-hidden="true">{position + 1}</kbd>
            </label>
          ))}
          <div className="ask-option ask-option-other" data-selected={draft.other || undefined}>
            <label className="ask-other-row">
              <input type={inputType} name={`${uid}-${question.id}`} checked={draft.other} disabled={disabled} onChange={selectOther} />
              <span className="ask-option-body"><span className="ask-option-label">Other</span></span>
              <kbd className="ask-key" aria-hidden="true">{OTHER_KEY}</kbd>
            </label>
            <textarea ref={otherBox} id={otherId} className="ask-other-text" rows={2} value={draft.text} disabled={disabled} aria-label="Other answer, in your own words"
              placeholder="Type your own answer…" onChange={(event) => update((current) => typeOther(question, current, event.target.value))} />
          </div>
        </div>
      </div>
      <footer className="ask-actions">
        <div className="ask-actions-start">
          <button type="button" className="button button-secondary button-small" disabled={disabled || index === 0} onClick={() => goTo(index - 1)}>Back</button>
          <button type="button" className="button button-secondary button-small" disabled={disabled} onClick={skip}>Skip</button>
          {total > 1 && <button type="button" className="button button-secondary button-small" disabled={disabled} onClick={() => submit(drafts, true)}>Skip all</button>}
        </div>
        {last
          ? <button type="button" className="button button-primary button-small" disabled={disabled || !anyAnswered} onClick={() => submit()}>Submit</button>
          : <button type="button" className="button button-primary button-small" disabled={disabled} onClick={advance}>Next</button>}
      </footer>
      <p className="ask-hint">Keys: <kbd>1</kbd>–<kbd>5</kbd> choose · <kbd>Enter</kbd> {last ? 'submit' : 'next'} · <kbd>Esc</kbd> skip · <kbd>←</kbd> <kbd>→</kbd> on the question tabs</p>
    </section>
  );
}
