/** Shown instead of the card when the agent's `ask_user` arguments were invalid (the service already answered with an error). */
export function AskUserInvalidNotice() {
  return (
    <div className="ask-invalid" role="note">
      <strong>The agent’s question couldn’t be shown.</strong> It was malformed, so the agent was asked to try again. You can also just reply below.
    </div>
  );
}
