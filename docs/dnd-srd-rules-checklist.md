# SRD 5.1 core rules: what the engine plays

A rule-by-rule check of the SRD 5.1 (2014) Combat and Adventuring chapters against the engine. **Done** is played by the engine; **Partial** says what is left out; **Narrative** is left to the Narrator and the table because the engine has no state for it; **No** is a gap. Checked against the code on 2026-09-30.

## Combat

| Rule | State |
|---|---|
| Initiative, turn order, rounds | Done |
| Surprise | Done: an encounter may name a side (`surprised`), which loses its first turn and cannot react until it has passed. The book's disadvantage on initiative is not applied |
| Movement, speed, difficult terrain, standing up from prone | Done (zones: the zone is the position) |
| Flying | Partial: Fly, Levitate and Dragon Wings lift a hero out of melee reach; monsters do not fly |
| Creature size and space | Narrative |
| Attack (melee, ranged), attack rolls, advantage and disadvantage | Done |
| Dash, Disengage, Dodge | Done |
| Help | Done: in a fight a foe in reach gives the next attack against it advantage; on a check the Planner grants advantage for the `help` reason |
| Hide | Done (no Stealth contest) |
| Ready | Partial: the trigger is fixed to "the first foe that attacks"; the hero then makes a weapon attack as a reaction. Readied spells and other triggers are not played |
| Search, Use an Object | Narrative (items and potions have their own actions) |
| Unseen attackers and targets, ranged attack in melee, long range | Done |
| Opportunity attacks | Done (prompted) |
| Two-weapon fighting | Done: a bonus-action attack with a different light melee weapon, no ability modifier on the damage unless the hero holds the Two-Weapon Fighting style |
| Grappling and shoving | Partial: the target saves instead of the contest, and escaping always works |
| Cover | Done (a zone may give half or three-quarters cover) |
| Damage rolls, critical hits, damage types, resistance, vulnerability, immunity | Done |
| Hit points, temporary hit points, healing | Done |
| Dropping to 0, instant death, death saves, stabilizing | Done |
| Knocking a creature out | Done: a melee blow may be nonlethal ("knock out" in the turn menu); the foe is left unconscious and alive, counts as beaten, and still gives XP. Nothing yet records or uses the captive |
| Monsters and death | Done |
| Mounted combat | No |
| Underwater combat | No |
| Flanking (optional rule) | No |

## Conditions

Blinded, charmed, deafened, exhaustion, frightened, grappled, incapacitated, invisible, paralyzed, petrified, poisoned, prone, restrained, stunned and unconscious are all defined. Deafened changes nothing by itself. Petrified does not grant the immunity to poison and disease. The charmer's advantage on social checks is narrative. Surprised (not an SRD condition) is how surprise is played.

## Spellcasting

| Rule | State |
|---|---|
| Spell slots, cantrips, upcasting, Pact Magic slots | Done |
| Concentration | Done |
| Bonus-action spell restriction | Done |
| Rituals | Done (from the Explore menu) |
| Reaction spells (Shield, Counterspell, Hellish Rebuke, Feather Fall, Absorb Elements) | Done |
| Components, casting time longer than an action | Partial: components are not tracked; long casting is only for rituals and companion summons |
| Areas, targets, ranges | Partial: the zone is the position; an area reaches the whole zone; cones and lines are not shaped |
| Spells with no rule (divination, travel, illusion, walls) | Narrative: the slot is spent and the Narrator describes it (142 spells) |

## Adventuring

| Rule | State |
|---|---|
| Short and long rests, hit dice | Done |
| Travel hazards, forced march, extreme weather, food and water | Partial: the organizer names an ability and a DC, and a failed save costs a level of exhaustion (`faceHazard`). Travel pace and daily food tracking are not kept |
| Falling | Done: the organizer's Hurt form rolls 1d6 for each 10 feet (up to 20d6); a hero at 0 lies unconscious, and one whose damage passes their maximum hit points dies |
| Suffocating and drowning | Partial: the organizer calls it when the air runs out (holding breath is not timed); a hero drops to 0, and one already at 0 dies |
| Vision and light, darkvision | Done in a fight; dim light has no effect (as in the book) |
| Movement types outside a fight (climbing, swimming, jumping) | Narrative |
| Carrying capacity and encumbrance | Partial: the hero sheet shows the load against 15 pounds per point of Strength and the variant band; the speed penalty is not applied in a fight, and coins are not counted |
| Ability checks, saving throws, proficiency, skills | Done (Halfling Lucky included) |
| Passive Perception | Partial: shown on the hero sheet; nothing rolls Stealth against it |
| Group checks, working together on a check | Done: the Planner may hang an effect on a group check (at least half of the round's checks succeed); helping is the `help` advantage reason |
| Contests | Partial (used by haggling and pressing in conversation) |
| Inspiration | Done |
| Downtime activities | No |
| Coins, equipment, armor and weapons, shops | Done |
| Magic items and attunement | Partial (see `dnd-completion-roadmap.md`) |
| Death and raising the dead | Done (between fights) |

## What to build next, if a table needs it

1. Holding a captive: what a knocked-out foe is worth in the story (ransom, questioning), and waking it.
2. Ready with other triggers and with spells.
3. The encumbrance speed penalty in a fight, and passive Perception against Stealth.
4. Downtime activities, mounted and underwater combat, only if an adventure is built around them.
