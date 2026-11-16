import type { AskUserArgs, AskUserResult } from '../contracts';
import { summarize } from './askUserModel';

export type AskUserSummaryProps =
  | { args: AskUserArgs; result: AskUserResult; dismissed?: false }
  /** The user typed in the composer instead; there is no result. */
  | { args: AskUserArgs | null; result?: undefined; dismissed: true };

/** The collapsed card in the transcript: question header → chosen answer(s), free text or "Skipped". */
export function AskUserSummary(props: AskUserSummaryProps) {
  const { args, result, dismissed } = props;
  const items = args && result ? summarize(args, result) : [];
  return (
    <div className="message-row ask-summary-row">
      <div className="agent-icon" aria-hidden="true">✳</div>
      <div className="message-content">
        <section className="ask-summary" aria-label={dismissed ? 'Question dismissed' : 'Your answers'}>
          <span className="message-author">{dismissed ? 'Dismissed — answered in chat' : result?.status === 'skipped' ? 'Questions skipped' : 'Your answers'}</span>
          {dismissed
            ? args && (
              <ul className="ask-summary-list">
                {args.questions.map((question) => (
                  <li key={question.id}><span className="ask-summary-header">{question.header}</span><span className="ask-summary-question">{question.question}</span></li>
                ))}
              </ul>
            )
            : (
              <ul className="ask-summary-list">
                {items.map((item) => (
                  <li key={item.id}>
                    <span className="ask-summary-header">{item.header}</span>
                    {item.skipped
                      ? <span className="ask-summary-skipped">Skipped</span>
                      : <span className="ask-summary-values">{item.values.join(' · ')}</span>}
                  </li>
                ))}
              </ul>
            )}
        </section>
      </div>
    </div>
  );
}
