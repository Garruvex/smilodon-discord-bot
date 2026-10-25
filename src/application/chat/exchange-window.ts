// One idle window for "the bot is still in an exchange with this person": the
// scheduler's reply-count reset, the follow-up eligibility rule and the legacy
// addressing heuristic all read it. Elapsed time <= this is inside the window.
export const exchangeIdleMs = 120_000;
