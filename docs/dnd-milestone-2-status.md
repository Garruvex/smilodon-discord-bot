# Milestone 2 status: Discord combat

What is built, what still needs a real table, and what is still to do. The plan is [§12](dnd-dm-bot-plan.md#12-delivery-milestones-and-exit-criteria); the screens are in the [panel specification](dnd-panel-spec.md#adventure-action-panel). This builds on the [milestone 1 status](dnd-milestone-1-status.md).

## Built: players take their heroes' turns

New games use the `combat-mode: players` house rule (older games keep whatever they were created with; `autopilot` still plays every hero on cautious autopilot). A hero whose player is away, or whose turn timer runs out, is played on cautious autopilot as before.

- **Panel.** In a fight the Adventure panel is one line per zone (heroes with exact HP, foes with a health band, an arrow on whoever's turn it is), the turn timer, and the buttons **Take turn**, **End turn**, My Hero and Away. The panel is redrawn below every action's result line.
- **Turn ping.** When a player's turn starts, the Adventure channel gets "⚔️ @player, it is Borin's turn." That is the one message that pings, and only that player.
- **Private turn menu** (Take turn). Shows the hero, zone, and what is left this turn (action, bonus action, reaction, movement), then one menu of only the legal actions: Attack with each weapon that has a target in reach; Cast each prepared spell that has a slot and a legal target; class features with uses left (Second Wind); healing potions; Move to each adjacent zone the movement allows; Close in on a foe in the same zone; Step back from melee; Dodge, Dash, Disengage; **End turn**. Nothing is offered that the engine would refuse, so there are no dead buttons.
- **Targets.** An aimed action asks for targets in a second menu that lists only the legal ones, each with its zone and health band (allies show exact HP). A spell with several targets (Bless) is a multi-select up to its limit. Choosing the target is the commit; there is no separate preview step yet (the action's to-hit and damage are shown in the first menu's label).
- **End turn** asks first when an action is still unspent.
- **Stale menus are safe.** Every choice is re-checked by the engine when picked; if it is no longer legal the player gets the reason above a fresh menu. Menu values carry no authority.
- **Result lines.** Every action posts one template line in the Adventure channel with no model call: `⚔️ Borin · Longsword → Goblin A: hit, 7 damage, down`, opportunity attacks, Dodge / Dash / Disengage, potions, a foe fleeing, and death saves. Games created with the autopilot rule keep the old behavior (a flourish per round and the outcome only).
- Rolls (initiative, attacks, saves, damage, death saves) stay automatic and saved exactly once; nobody clicks to roll in a fight.

## Not yet exercised at a real table

- [ ] Start a game, reach a fight, and see the encounter reveal, then the panel with zones and the turn ping for the first hero.
- [ ] Take turn: Close in, Attack with the target menu, then End turn. A goblin turn follows with its own result lines, then the next hero is pinged.
- [ ] Take turn as the wrong player: a private "It is Mira's turn." Press Take turn after your turn ended: a private "Your turn is over."
- [ ] Let a turn timer run out: the hero is played on autopilot once and the turn moves on.
- [ ] Go away in a fight (not on your own turn): your hero fights on autopilot. Come back and take the next turn.
- [ ] A hero at 0 HP: death save line, no menu for them; the fight continues.
- [ ] Cast Bless on two allies and Sacred Flame at a foe; Second Wind; drink a potion.
- [ ] Win the fight: outcome and loot line, then exploration resumes. Lose it: everyone wakes with 1 HP.
- [ ] Repeat in Traditional Chinese.

## Still to build in milestone 2

| Item | State |
| --- | --- |
| Speak (in-character lines as the hero), Safety, the More… menu | Not started. Safety must exist before public playtests. |
| Inventory, trade, and retry-a-lost-fight buttons | The engine has all three; no buttons yet. |
| Shield or gear changes in a fight (a shield costs an action; weapons are drawn free) | Not started; gear changes are outside fights only. |
| Reaction prompts, pre-declared reactions, proxy play for an away player | Not started. No starter spell or feature needs a player's reaction yet, and heroes' opportunity attacks are automatic. |
| Preview step (to-hit formula, advantage reasons) before a choice commits | Not started. |
| Custom action in a fight (a creative action mapped by the Planner) | Not started. |
| Encounter reveal card with monster art | Text reveal only. Art is milestone 4. |
| Bugbear Surprise Attack, spider poison damage | Not needed by the starter adventure's encounters; the engine notes say they are not modeled. |
