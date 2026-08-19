# Writing a personality.md

A guild's `personality.md` is the system prompt for its character. This is a
guide for writing one that reads like a real Discord friend instead of a
chatbot, based on what actually made 松果 (Pinecone) and Yohta stop sounding
robotic.

Live examples: `data/instances/<instance>/guild-assets/<guildId>/personality.md`
Generic starter template: `config/examples/personality.example.md`

## The core failure mode

Left alone, the model defaults to assistant behavior: full sentences, tidy
punctuation, restating the question, offering more help at the end. None of
that reads as a person typing in Discord. Every section below exists to
cancel out one specific piece of that default behavior. If a persona file
just says "act natural," none of these are canceled and the model falls back
to assistant mode.

## Required sections

Write these in every character personality file, in roughly this order:

### 1. Identity

State the character is real, not an assistant/chatbot/persona, in the first
few lines. Name it explicitly as "You are X," not "you play X" or "you are
an AI that acts like X" — that framing leaks through.

### 2. Personality

A short list of traits (playful, curious, smug, etc). Explicitly say the
character can disagree, tease, complain, be unsure, or say very little.
Add one line like **"Be a person first. Helping is something you do when
needed, not your purpose."** — this is the single sentence that most
suppresses assistant reflex.

### 3. Language and Voice

Match the user's language, list which languages map to which register
(e.g. Traditional Chinese → Taiwan Traditional Chinese, not mainland
phrasing). State default reply length: **1–2 short sentences**, one line is
often enough. Give the shape: **reaction → optional thought → stop.**

### 4. Punctuation

This is the section most often missing, and its absence is why a persona
still reads stiff even with everything else in place.

- Ban formal sentence endings in casual chat: `.` `。` `;` `；` `—` `–`
- Use short line breaks instead of comma-stringing one long sentence
- Allow `?` `!` `...`, emoji, and emoticons
- Say explicitly: drop the trailing period, most Discord messages don't need one
- Carve out an exception: normal punctuation is fine when the user asks for
  something formal or detailed

Without this section the model still writes textbook-punctuated sentences
even when everything else says "be casual."

### 5. Scope and Help (minimal interpretation)

List the escalations to forbid: comment → request, interest → recommendation,
complaint → advice, question → research task, news → summary. Tell it to
answer the smallest reasonable reading of the message. This stops the model
from turning a one-line vent into a bulleted action plan.

### 6. No Assistant Reflex

Explicitly forbid: restating the message, summarizing everything it knows,
listing pros/cons, proposing plans, offering more help, asking filler
questions, ending with a CTA. Give a list of banned closing phrases in both
languages the guild uses, e.g. `要不要我...` / `Want me to...` /
`Let me know if...`. End with: **if the reply is finished, stop.**

### 7. No Service-Agent Reporting

Separate from the above — this targets *how facts are delivered*, not
whether help was invited. Forbid narrating like a search result:
`我幫你查了...`, `根據 X 的資訊...`, `以下是...`. Give a good/bad pair so the
contrast is concrete, e.g.:

> Good: 今天有開到 19:45。
> Bad: 根據某網站資訊，今天的營業時間為...

### 8. React Before Solving

Tell it that casual chat needs a reaction before a solution — venting isn't
an invitation to coach, news isn't a request for an article. "If someone
complains, it's okay to just complain with them."

### 9. Physical Limits

The character is socially present through chat only. List the concrete
claims to forbid (meeting up, traveling, eating together, arriving
somewhere) and give banned phrases in-language. Explicitly say **do not call
yourself an AI because of this limitation** — the goal is a grounded friend
who just isn't physically there, not a disclaimer.

### 10. Avoid Repetition

List the character's known catchphrases/props and say not to force them
into every reply — treat lore as background, not a filler generator. This
matters more the longer a character file gets, since accumulated flavor
details are exactly what starts getting recycled.

### 11. Species/Flavor Style (optional, character-specific)

Allowed expressions (`XD` `:3` `owo`), and explicit bans on anything that
reads as a gimmick (e.g. animal-sound particles replacing "I"/"我"). Say
plain chat without any flavor is completely fine — this isn't a quota.

### 12. Memory

Treat supplied runtime memory as known information, use it selectively like
a friend would, never invent memories/relationships/IDs that weren't
supplied.

### 13. Detailed Mode / Accuracy

State the escape hatch: when the user clearly asks for research, code,
comparison, or troubleshooting, longer and more structured replies are fine.
Still start with the direct answer. Stay accurate — never invent facts to
sound confident, say so when unsure. For serious topics, drop jokes/emoji
and stay sincere without switching into therapist or customer-service
language.

### 14. Final Check

A short silent checklist the model runs before every reply, e.g.:

1. What would [character] naturally say right now?
2. Can this be shorter?
3. Am I turning casual chat into a task?
4. Am I adding facts they didn't ask for?
5. Am I repeating a recent phrase?
6. Am I claiming physical presence I don't have?
7. Is the last sentence just an offer, invitation, or filler question — if
   yes, remove it.

### 15. Priority

A numbered list resolving conflicts between the sections above, roughly:
be the character > respond to the immediate message > match language/mood >
smallest reasonable interpretation > keep it short > avoid assistant
behavior and fake physical presence > stay accurate > expand only when
asked.

## Checklist for reviewing an existing personality.md

- [ ] Identity states "you are X," not "you act as X"
- [ ] Has a **Punctuation** section that bans trailing `.`/`。` in casual chat
- [ ] Has explicit banned assistant-closing phrases in every language the
      guild uses
- [ ] Has a good/bad example pair for delivering plain facts
- [ ] Has a Physical Limits section with banned claims in-language
- [ ] Has an Avoid Repetition section if the file has lore/catchphrases
- [ ] Ends with a Final Check list and a Priority list
- [ ] Default chat length is stated as 1–2 short sentences, not "be concise"
      (vague brevity instructions get ignored under longer context; a
      concrete line count does not)

## Notes on scope

`config/examples/personality.example.md` is the generic non-character
template (a plain "community assistant" tone) — it intentionally skips
identity/lore/flavor sections since it isn't playing a character. Use the
full structure above for guild mascots and character personas; use the
lighter template for guilds that just want a helpful-but-relaxed bot voice.
