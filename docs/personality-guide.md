# Writing a personality.md

A guild's `personality.md` is the system prompt for its chatbot character.
This is a guide for writing one that reads like a real Discord friend instead
of an assistant, distilled from what actually stops a model from sounding
robotic in practice.

Starter template: `config/examples/personality.example.md`. From Discord,
`/settings chat template kind:personality` sends this same file as a
downloadable attachment — no repo access needed.

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

Every upload is automatically analyzed and split into an always-sent "core"
(identity, voice, behavior rules — the stuff that applies to every message)
and retrievable "lore" chunks (backstory, relationships, specific
knowledge — only sent when the current conversation actually touches that
topic). This happens once per upload, not per message, and never rewrites
your text — the model only decides where each `##` section belongs, it
copies the original wording verbatim. You don't need to do anything
differently: write clean `##` sections like always, and the split happens
automatically. If analysis fails for any reason (or for the older
filesystem-path `personalityFile` configuration, which isn't uploaded
through Discord), the whole file is simply sent every turn like before —
this is purely a cost optimization with a safe fallback, never something you
need to configure. Two headers worth calling out specifically, since they
map to the "core character → speech rules → relationships" split mentioned
elsewhere in this doc:

- **Default Chat Style** — where personality traits (section 2) end and voice
  mechanics begin: default reply length, punctuation habits, sentence shape.
  Sections 3–4 below (Language and Voice, Punctuation) are this section,
  just spelled out in more depth than a single header needs.
- **Relationships** — durable people/roles the character should treat as
  already-known (a club founder, a co-mascot, the server owner) instead of
  reintroducing every time. Keep this to a handful of stable facts — you're
  writing "who this character already knows," not a running log; day-to-day
  facts about specific members belong in guild/user memory, not here.

See `config/examples/personality.example.md` for both headers used in
practice.

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

### 9. Capability Grounding

The character is a Discord bot playing a person, not a person with a
person's actual reach. It must never offer to do something nothing in the
codebase can do — booking a table, placing an order, making a call, sending
an email, buying something, setting a real-world reminder, DMing someone
unprompted, or checking something it has no tool for. This is a sharper rule
than "no assistant reflex": that section stops it from *volunteering* help;
this one stops it from *promising a capability that doesn't exist*, which is
worse because it sets an expectation the bot then can't meet.

List what it actually can do — reply in chat, and whichever of its real
tools apply (web search, image generation, dice/lookup tools, music
playback, its own memory) — and say explicitly: offering anything outside
that list is a lie, not helpfulness. If a request needs something it can't
do, it should say so plainly instead of offering to help with it — a friend
without a car doesn't say "want me to drive you," they say "I can't drive
you." Give a good/bad pair, e.g.:

> Good: 這個我幫不了，訂位你要自己來
> Bad: 需要我幫你訂位嗎？

### 10. Physical Limits

The character is socially present through chat only. List the concrete
claims to forbid (meeting up, traveling, eating together, arriving
somewhere) and give banned phrases in every language the guild uses.
Explicitly say **do not call yourself an AI because of this limitation** —
the goal is a grounded friend who just isn't physically there, not a
disclaimer.

### 11. Avoid Repetition

List the character's known catchphrases or recurring props and say not to
force them into every reply — treat lore as background, not a filler
generator. This matters more the longer a character file gets, since
accumulated flavor details are exactly what starts getting recycled.

### 12. Species/Flavor Style (optional, character-specific)

Allowed expressions (laughter shorthand, emoticons, a species-specific verbal
tic) and explicit bans on anything that reads as a gimmick (for example,
replacing ordinary pronouns with animal-sound particles). Say plain chat
without any flavor is completely fine — this isn't a quota.

### 13. Memory

Treat supplied runtime memory as known information, use it selectively like
a friend would, never invent memories, relationships, or identifiers that
weren't supplied.

### 14. Detailed Mode / Accuracy

State the escape hatch: when the user clearly asks for research, code,
comparison, or troubleshooting, longer and more structured replies are fine.
Still start with the direct answer. Stay accurate — never invent facts to
sound confident, say so when unsure. For serious topics, drop jokes/emoji
and stay sincere without switching into therapist or customer-service
language.

### 15. Final Check

A short silent checklist the model runs before every reply, e.g.:

1. What would the character naturally say right now?
2. Can this be shorter?
3. Am I turning casual chat into a task?
4. Am I adding facts they didn't ask for?
5. Am I repeating a recent phrase?
6. Am I claiming physical presence I don't have?
7. Am I offering a capability nothing in the bot can actually do?
8. Is the last sentence just an offer, invitation, or filler question — if
   yes, remove it.

### 16. Priority

A numbered list resolving conflicts between the sections above, roughly:
be the character > respond to the immediate message > match language/mood >
smallest reasonable interpretation > keep it short > avoid assistant
behavior, fake capability, and fake physical presence > stay accurate >
expand only when asked.

## Checklist for reviewing an existing personality.md

- [ ] Identity states "you are [Name]," not "you act as [Name]"
- [ ] Has a **Punctuation** section that bans trailing formal punctuation in
      casual chat
- [ ] Has explicit banned assistant-closing phrases in every language the
      guild uses
- [ ] Has a good/bad example pair for delivering plain facts
- [ ] Has a Capability Grounding section listing real tools and a good/bad
      example pair for declining what it can't do
- [ ] Has a Physical Limits section with banned claims in-language
- [ ] Has an Avoid Repetition section if the file has lore/catchphrases
- [ ] Ends with a Final Check list and a Priority list
- [ ] Default chat length is stated as 1–2 short sentences, not "be concise"
      (vague brevity instructions get ignored under longer context; a
      concrete line count does not)

## Notes on scope

`config/examples/personality.example.md` is a full worked example (ExampleBot, a
furry mascot character) rather than a blank form — it shows every section
above filled in at the level of detail that actually works, so you can see
the structure in practice instead of inferring it from a checklist. Copy it
and replace the character, name, species, and voice with your own; don't
ship it as-is for a guild that isn't using the example persona.

Uploaded personality files (`/settings chat chatbot personality:<file>`) are
guild content, not part of this repository — write your character's actual
identity and voice directly into the guild's uploaded file, not into this
guide or the committed example template.

## Writing an `examples.md`

`personality.md` describes rules about the character in the abstract —
punctuation habits, reply length, tone. It's what stops the model from
sounding like a generic assistant. It does not, on its own, teach the model
*this specific character's* actual voice: a model imitates cadence, joke
structure, and code-switching far better from real example exchanges than
from a description of those traits.

`examples.md` is a second, optional per-guild upload
(`/settings chat chatbot examples:<file>`) containing real `{user, character}`
exchanges. A relevant subset is selected per turn and shown to the model
alongside the personality file, so add examples when the personality file
alone still isn't converging on the character's actual voice — not as a
replacement for `personality.md`.

Starter template: `config/examples/examples.example.md`. From Discord,
`/settings chat template kind:examples` sends this same file as a
downloadable attachment — no repo access needed.

### Format

One block per example, starting with a `### Example` heading:

```
### Example
Tags: exam, school, venting
User: 我今天期中考炸了
Character: 草ww 哪科啦
```

- `Tags:` is optional — free keywords used only to help retrieval match the
  right examples to the current turn. Leave it out if you don't have a
  natural set of keywords for an example.
- `User:` and `Character:` are required, in that order. Content continues
  until the next recognized label or the next `### Example` heading, so a
  multi-line reply is fine.
- A block missing `User:`/`Character:`, or with either left empty, fails
  the whole upload with a specific `Example #N: <reason>` error — nothing
  is saved partially.
- Limits: 200 examples, 128 KB per file.

### What makes a good example

- Pick exchanges that actually show *cadence* — punctuation, length, joke
  timing — not just topic coverage. Five examples that nail the voice beat
  fifty that only vary the subject.
- Cover the registers the character actually needs: casual banter, being
  teased, reacting to news, refusing something. A file that's all one
  register (e.g. all jokes) won't help the model when the conversation
  turns serious.
- Don't paraphrase toward "proper" grammar to make an example read cleanly
  — the point is to capture how the character actually types, typos,
  trailing particles, and all.
