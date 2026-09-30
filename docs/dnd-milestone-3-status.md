# Milestone 3 status: reliability hardening

What is built, what still needs a real server, and what was left out. The plan is [§12](dnd-dm-bot-plan.md#12-delivery-milestones-and-exit-criteria); the acceptance scenarios are in [§13](dnd-dm-bot-plan.md#13-acceptance-scenarios). Authorization, idempotency and saved state already existed in earlier milestones; this one is about Discord going wrong.

## Built

- **Deliveries retry with a wait.** A message that cannot be sent is tried again after 5 s, 15 s, 45 s, 2 min, then every 5 min, for ten attempts (about half an hour). While one delivery of a game waits, the game's later deliveries wait behind it, so the table never sees results out of order; other games are unaffected. The gameplay result was saved first, so a retry never rolls or spends again.
- **A repeat is dropped by Discord.** Every post of a delivery carries a nonce made from the queued item's ID, the same on each retry, with Discord's nonce enforcement on. A message that reached Discord before the failure is not posted twice when the retry runs. This covers the window where the send worked but the bot never heard back.
- **Given-up work is not lost.** After the last attempt the delivery is marked failed and an organizer issue is raised. **Repair** puts failed deliveries back in the queue with a fresh count.
- **Organizer issues.** A card that cannot be drawn, a delivery given up on, a missing permission, or a channel that keeps disappearing becomes one entry on the game's record (never a flood): the Manage screen lists it under "Needs attention", and the organizer is told once, by name, in the first channel the bot can still write to (Party, then Adventure, then Table Talk). If nowhere can be written to, the notice is tried again the next time the problem comes up. A game that has finished raises nothing. A card that failed to draw is left alone for 30 seconds so a missing permission does not become a failing call on every click.
- **One Repair.** `/dnd repair` and the Manage button do the same: make missing channels and the Table Talk thread again, send what had been given up on, redraw every card against what Discord really has, and clear the issues that are now fixed. A finished game is left alone.
- **Places taken away.** A deleted hub channel, game channel or Table Talk thread is made again and its cards drawn into it. A game's channel is made again at most three times an hour (someone may be deleting it on purpose); after that it is an issue for the organizer. A finished game's channel is never brought back. A missing permission is reported, not retried.
- **Reopen an ended game.** `/dnd reopen`, run in the finished game's channels by its organizer or a DnD Admin. The game returns paused exactly where it stopped, and the organizer presses Resume. A game cancelled in its lobby never began and cannot be reopened; neither can one whose name another unfinished game has taken since.
- **Players-only games.** Chosen in the Create game wizard (a toggle button next to Next) or with `/dnd new visibility`. The lobby stays open so anyone can press Join. When the game starts the bot makes one role ("🎲 Name"), gives it to the organizer and every player, and shows both channels to that role alone. A moderator can add a spectator by giving them the role; they can read but not act, because every control checks the game's members, not the role. Repair puts the role back on a player who lost it and re-applies the channel overwrites. A finished game keeps its role. Changing a running game between open and players-only is not built.
- **Halfway reminders.** For a wait of ten minutes or longer (a Play-by-post round, roll or turn) a timer at the halfway point nudges only the players still being waited for, with the time left shown in each reader's own clock. The engine checks the wait is still going on for the same deadline before it speaks, so a pause and resume, an early answer, or a closed round make it do nothing. Live pacing (minutes) has no reminder; the panel's countdown covers it.
- **Staged dice reveal.** A roll result is first posted as "🎲 Mira rolls Stealth (DEX)…", and after a short pause (1.2 s) the same message is rewritten with the result. The saved result never changes.

## Tested without Discord

Store contracts for both stores (retry time, requeue, and the upgrade of an older database), the delivery worker (backoff, order behind a failed delivery, given-up work, the same delivery ID on every retry), the presenter (nonces, the staged reveal, reminders), issues (once per kind, told again when nobody could be told, cleared, none for finished games), the card service (failures raise issues, cooldown, Repair ignores it), recovery (a channel or thread made again, limits, a finished game, permissions), players-only setup (role made once, granted, channels restricted, made again if deleted, permission failure), reopen, halfway reminders in the engine, and two acceptance scenarios that cut across layers (13: simultaneous actions are serialized and a repeat changes nothing; 34: an all-away party makes no rounds, and a restart never plays unattended).

Not tested against real Discord: nonce dedupe behavior, role and overwrite creation, the thread-delete event, message edits for the staged reveal.

## Playtest checklist

- [ ] Remove the bot's Send Messages permission in a game's Adventure channel, press a panel button: Manage shows "Needs attention", the organizer is told once in the Party channel, and nothing repeats. Give it back, press Repair: the issue is gone and the cards return.
- [ ] Delete a game's Table Talk thread: it is made again and the Party card links to the new one.
- [ ] Delete the Adventure channel four times in an hour: the fourth is not made again, and Manage says so; Repair makes it.
- [ ] End a game from Manage, then `/dnd reopen` in its channel: it is listed in the hub, paused; Resume continues where it stopped.
- [ ] Create a players-only game with two accounts; a third account can press Join in the lobby but cannot see the channels after Start; give it the role and it can read but every control refuses.
- [ ] A Play-by-post game: an hour before a round closes (or set a custom pace) the halfway note names only the players who have not acted.
- [ ] A roll: the "rolls…" line becomes the result in place.
- [ ] Repeat the above in Traditional Chinese.

## Left out

- Changing a running game between open and players-only.
- Binding an existing channel as a replacement; Repair always makes a new one.
- A hub card badge for games with open issues (Manage lists them).
- Rate limits on Discord itself (discord.js queues them).
