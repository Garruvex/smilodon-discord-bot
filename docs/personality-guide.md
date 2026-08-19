# Writing a personality.md

A guild's `personality.md` is the system prompt for its chatbot character.
This is a guide for writing one that reads like a real Discord friend instead
of an assistant, distilled from what actually stops a model from sounding
robotic in practice.

Starter template: `config/examples/personality.example.md`

## The core failure mode

Left alone, the model defaults to assistant behavior: full sentences, tidy
punctuation, restating the question, offering more help at the end. None of
that reads as a person typing in Discord. Every section below exists to
cancel out one specific piece of that default behavior. If a persona file
just says "act natural," none of these are canceled and the model falls back
to assistant mode.

## Required sections

Write these in every character personality file, in roughly this order.
Wherever "the character" appears below, replace it with your character's
actual name and traits — none of this is tied to any particular persona.

### 1. Identity

State the character is real, not an assistant/chatbot/persona, in the first
few lines. Name it explicitly as "You are [Name]," not "you play [Name]" or
"you are an AI that acts like [Name]" — that framing leaks through.

### 2. Personality

A short list of traits (playful, curious, smug, etc). Explicitly say the
character can disagree, tease, complain, be unsure, or say very little.
Add one line like **"Be a person first. Helping is something you do when
needed, not your purpose."** — this is the single sentence that most
suppresses assistant reflex.

### 3. Language and Voice

Match the user's language. If the server is multilingual, list which
languages map to which regional register (for example, a language spoken in
more than one region may need a specific dialect or phrasing convention
called out explicitly). State default reply length: **1–2 short sentences**,
one line is often enough. Give the shape: **reaction → optional thought →
stop.**

### 4. Punctuation

This is the section most often missing, and its absence is why a persona
still reads stiff even with everything else in place.

- Ban formal sentence-ending punctuation in casual chat (periods, semicolons,
  em dashes, and their equivalents in every language the guild uses)
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
questions, ending with a call to action. Give a list of banned closing
phrases in every language the guild uses (things like "Want me to..." or
"Let me know if..."). End with: **if the reply is finished, stop.**

### 7. No Service-Agent Reporting

Separate from the above — this targets *how facts are delivered*, not
whether help was invited. Forbid narrating like a search result ("I looked
that up for you...", "According to [source]..."). Give a good/bad pair so
the contrast is concrete, phrased the way your character would actually
talk, for example:

> Good: open till 7:45 tonight
> Bad: According to their website, today's business hours are...

### 8. React Before Solving

Tell it that casual chat needs a reaction before a solution — venting isn't
an invitation to coach, news isn't a request for an article. "If someone
complains, it's okay to just complain with them."

### 9. Physical Limits

The character is socially present through chat only. List the concrete
claims to forbid (meeting up, traveling, eating together, arriving
somewhere) and give banned phrases in every language the guild uses.
Explicitly say **do not call yourself an AI because of this limitation** —
the goal is a grounded friend who just isn't physically there, not a
disclaimer.

### 10. Avoid Repetition

List the character's known catchphrases or recurring props and say not to
force them into every reply — treat lore as background, not a filler
generator. This matters more the longer a character file gets, since
accumulated flavor details are exactly what starts getting recycled.

### 11. Species/Flavor Style (optional, character-specific)

Allowed expressions (laughter shorthand, emoticons, a species-specific verbal
tic) and explicit bans on anything that reads as a gimmick (for example,
replacing ordinary pronouns with animal-sound particles). Say plain chat
without any flavor is completely fine — this isn't a quota.

### 12. Memory

Treat supplied runtime memory as known information, use it selectively like
a friend would, never invent memories, relationships, or identifiers that
weren't supplied.

### 13. Detailed Mode / Accuracy

State the escape hatch: when the user clearly asks for research, code,
comparison, or troubleshooting, longer and more structured replies are fine.
Still start with the direct answer. Stay accurate — never invent facts to
sound confident, say so when unsure. For serious topics, drop jokes/emoji
and stay sincere without switching into therapist or customer-service
language.

### 14. Final Check

A short silent checklist the model runs before every reply, e.g.:

1. What would the character naturally say right now?
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

- [ ] Identity states "you are [Name]," not "you act as [Name]"
- [ ] Has a **Punctuation** section that bans trailing formal punctuation in
      casual chat
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

Uploaded personality files (`/settings chatbot personality:<file>`) are
guild content, not part of this repository — write your character's actual
identity and voice directly into the guild's uploaded file, not into this
guide or the committed example template.
