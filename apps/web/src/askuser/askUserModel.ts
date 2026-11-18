import {
  AskUserArgsSchema, AskUserResultSchema,
  type AskUserAnswer, type AskUserArgs, type AskUserOption, type AskUserQuestion, type AskUserResult,
} from '../contracts';

/** Keyboard shortcut of the free-text "Other" option; options use `1`–`4`. */
export const OTHER_KEY = 5;

/** What the user has entered for one question. `selected` holds ORIGINAL option indices. */
export interface QuestionDraft {
  selected: number[];
  /** "Other" is chosen; `text` is its free-text answer. */
  other: boolean;
  text: string;
  skipped: boolean;
}

export const emptyDraft: QuestionDraft = { selected: [], other: false, text: '', skipped: false };

export interface OrderedOption {
  /** Index into `question.options` (what the drafts and the result refer to). */
  index: number;
  option: AskUserOption;
  recommended: boolean;
}

/** The recommended option comes first; the others keep their order. */
export function orderedOptions(question: AskUserQuestion): OrderedOption[] {
  const all = question.options.map((option, index): OrderedOption => ({ index, option, recommended: index === question.recommended }));
  const first = all.filter((entry) => entry.recommended);
  return [...first, ...all.filter((entry) => !entry.recommended)];
}

export const isAnswered = (draft: QuestionDraft): boolean => !draft.skipped && (draft.selected.length > 0 || (draft.other && draft.text.trim() !== ''));

export function chooseOption(question: AskUserQuestion, draft: QuestionDraft, index: number): QuestionDraft {
  if (question.multiSelect) {
    const selected = draft.selected.includes(index) ? draft.selected.filter((entry) => entry !== index) : [...draft.selected, index].sort((a, b) => a - b);
    return { ...draft, selected, skipped: false };
  }
  return { ...draft, selected: [index], other: false, skipped: false };
}

export function chooseOther(question: AskUserQuestion, draft: QuestionDraft): QuestionDraft {
  if (question.multiSelect) return { ...draft, other: !draft.other, skipped: false };
  return { ...draft, selected: [], other: true, skipped: false };
}

/** Typing selects "Other" (and deselects the options of a single-select question). */
export function typeOther(question: AskUserQuestion, draft: QuestionDraft, text: string): QuestionDraft {
  return { ...draft, text, other: true, selected: question.multiSelect ? draft.selected : [], skipped: false };
}

export function answerOf(question: AskUserQuestion, draft: QuestionDraft | undefined): AskUserAnswer {
  if (!draft || !isAnswered(draft)) return { questionId: question.id, selected: [], skipped: true };
  const freeform = draft.other ? draft.text.trim() : '';
  return {
    questionId: question.id,
    selected: draft.selected.flatMap((index) => (question.options[index] ? [question.options[index].label] : [])),
    ...(freeform ? { freeform } : {}),
    skipped: false,
  };
}

/** `status` is `skipped` when nothing was answered. Validated against the shared contract before it is sent. */
export function buildResult(args: AskUserArgs, drafts: Record<string, QuestionDraft>, skipAll = false): AskUserResult {
  const answers = args.questions.map((question) => answerOf(question, skipAll ? undefined : drafts[question.id]));
  return AskUserResultSchema.parse({ status: answers.every((answer) => answer.skipped) ? 'skipped' : 'answered', answers });
}

export interface SummaryItem {
  id: string;
  header: string;
  question: string;
  skipped: boolean;
  /** Chosen option labels, then the free-text answer. */
  values: string[];
  freeform?: string;
}

export function summarize(args: AskUserArgs, result: AskUserResult): SummaryItem[] {
  return args.questions.map((question): SummaryItem => {
    const answer = result.answers.find((entry) => entry.questionId === question.id);
    if (!answer || answer.skipped) return { id: question.id, header: question.header, question: question.question, skipped: true, values: [] };
    return {
      id: question.id, header: question.header, question: question.question, skipped: false,
      values: [...answer.selected, ...(answer.freeform ? [answer.freeform] : [])], freeform: answer.freeform,
    };
  });
}

export const parseArgs = (args: unknown): AskUserArgs | null => {
  const parsed = AskUserArgsSchema.safeParse(args);
  return parsed.success ? parsed.data : null;
};

/** The tool message content of an answered `ask_user` (JSON), or null when it is something else (server text, error). */
export function parseResult(content: string | undefined): AskUserResult | null {
  if (!content) return null;
  try {
    const parsed = AskUserResultSchema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
