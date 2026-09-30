# D&D campaign: what is left to finish the game

Companion to `dnd-mechanics-status.md` (what exists) and `dnd-race-mechanics-status.md`. This page is the plan for what does not:
gaps grouped by the engine primitive they need, with size (S: a day or less, M: a few days, L: a week or more) and what each unlocks.

## 1. Engine primitives (build once, unlock many features)

| Primitive | State | What is left |
|---|---|---|
| **Reaction windows** | "you were hit", "a foe is casting" and "a foe hurt you" open a prompt (Shield, Counterspell, Hellish Rebuke). Deflect Missiles, Cutting Words, the Protection style and Uncanny Dodge are applied automatically, and a hero may switch them off ("Hold Reactions", free) to keep the reaction for something else | A prompt for "an ally was hit" and "a save is about to be rolled" (Cutting Words on saves and damage, Sentinel-style feats) |
| **Rerolls** | Halfling Lucky on attacks, saves and ability checks, Indomitable on saves; Stroke of Luck on a missed attack | Stroke of Luck and Lucky on hazard, haggle and press rolls, rider saves and concentration saves |
| ~~Temporary hit points~~ | done (Dark One's Blessing, False Life, Heroism potions; the hero card shows them) | Armor of Agathys, Inspiring Leader |
| ~~Creature types~~ | done | Holy Avenger, Dragon Slayer, Giant Slayer and Protection from Evil and Good can read them |
| **Lighting and vision** | darkvision, dark zones, Light, Daylight and Darkness (they change a zone's lighting for the rest of the fight), Sunlight Sensitivity where a zone is lit as bright | Dim light has no combat effect in the book either (only Perception); creatures do not carry their own light |
| **Positions inside a zone** | the zone is the position. Cover on a zone (half +2, three-quarters +5); a hostile area of ten feet or more is aimed at one creature and reaches everyone in its zone, friends and the caster included (Careful Spell and Sculpt Spells spare friends); monster casters aim only where foes outnumber friends | Range bands inside a zone, area shapes (a cone or line hits the whole zone), cover from creatures |
| ~~Summons and companions~~ | done: Conjure Animals, Spiritual Weapon, the other conjuring spells, summons end with concentration when the spell needs it, Flaming Sphere, and companions kept between fights (Find Familiar is an owl that stays until dismissed; Animate Dead and Create Undead can be cast beforehand and last through the next fight) | the player does not steer them or pick what is summoned; the familiar fights where the book only lets it help |
| ~~Sorcery points and spell modification~~ | done: Quickened, Twinned, Heightened, Empowered, Extended, Subtle, and Flexible Casting both ways (slots into points, points into slots) | the SRD's per-level Twinned cost. Distant and Careful Spell do nothing here: range is by zone and no spell hits an ally |
| ~~Warlock invocations~~ | done: ten invocations and the three pact boons are chosen in the level-up form (as many as the level allows); Mystic Arcanum uses a fixed spell for each level | The other SRD invocations, the Blade's weapon (narrative), choosing the Arcanum spell |
| ~~Grapple and shove~~ | done, including escaping (an action that always works) | The contest rolls |
| **Forms** | Wild Shape (Archdruid has no limit), Polymorph and True Polymorph (hostile use, into a frog), Shapechange and Animal Shapes (the caster takes a form from the wild-shape menu) | Animal Shapes for allies, the form's own mind, choosing the Polymorph form, Circle of the Moon |
| **Charges and active magic items** | wands, spell scrolls, effect potions, staffs (Fire, Frost, Healing, Power) sharing one pool | Rods, bags, boots, cursed items, the other staffs |
| **Movement effects** | push (Thunderwave), movement grants (Misty Step is thirty feet that provokes nothing), speed bonuses (Longstrider, Fly), difficult terrain (a zone may cost double to enter; Plant Growth, Spike Growth and Sleet Storm make it), Misty Step and Dimension Door teleport to a zone chosen from the turn menu, Fly and Levitate lift the caster out of melee reach | Flight for monsters, damage from moving through Spike Growth |
| **Hide and stealth** | Hide (in a zone with cover or darkness, out of foes' reach); the next attack or spell ends it | The Stealth contest, surprise, searching |

## 2. Class features by level

Every SRD class feature from level 1 to 20 is on the sheet from its level (`features/late-features.ts`). The mechanical ones are listed in `dnd-mechanics-status.md`. What has no rule yet:

- **Barbarian:** Retaliation (14), Persistent Rage (no early end to persist).
- **Bard:** Countercharm, Magical Secrets (no spells outside the class list), Expertise (3, 10).
- **Cleric:** Divine Intervention.
- **Druid:** Circle of the Land bonus spells, Nature's Ward and Sanctuary.
- **Fighter:** Additional Fighting Style (the builder holds one style).
- **Monk:** Tongue of the Sun and Moon, Timeless Body, Quivering Palm, Open Hand Technique, Tranquility, Slow Fall.
- **Paladin:** Cleansing Touch, Purity of Heart, Divine Health.
- **Ranger:** Favored Enemy and Natural Explorer (out of combat), Primeval Awareness, Defensive Tactics, Hunter's Multiattack, Superior Hunter's Defense, Feral Senses.
- **Rogue:** Blindsense, Thief's Reflexes, Supreme Sneak, Use Magic Device, Second-Story Work.
- **Sorcerer:** Dragon Wings, Draconic Presence. (Careful Spell is a Metamagic option here; Distant Spell does nothing when range is by zone.)
- **Warlock:** Dark One's Own Luck, Fiendish Resilience, Hurl Through Hell, Eldritch Master.
- **Wizard:** Spell Mastery, Signature Spells.
- **All classes:** the builder has no choices for feats, and the SRD has none beyond Grappler.

## 3. Spells

- All 319 SRD spells exist. 142 of them are narrative: casting spends the slot and the Narrator describes it, and the engine changes nothing. The rest have effects (damage, healing, conditions, buffs, summons, movement, lighting). The narrative ones mostly need what section 1 lists as missing: areas that pick targets, terrain, real teleport and flight, walls, divination and travel.
- Revivify, Raise Dead, Reincarnate, Resurrection and True Resurrection bring a fallen hero back between fights (from the Explore menu); Spare the Dying, Dispel Magic, Freedom of Movement, Levitate and the terrain and fog spells have effects. The diamonds, the time limits and the penalties are not modeled.
- Reaction spells (Counterspell, Absorb Elements, Hellish Rebuke, Feather Fall, Shield is done).
- Concentration edge cases: Wild Shape and concentration, upcasting on the reaction path.
- Ritual casting and out-of-combat use of utility spells beyond the current set.

## 4. Monsters

- Legendary actions: weapon attacks and the dragon Wing Attack are played; Detect, Move and Teleport are not. Lair actions and regional effects are not.
- Possession, charm gazes, engulf and swallow, life drain that lowers maximum HP, Aversion to fire/sunlight, shapechanging (Werewolf, Vampire), summon-on-death.
- Fear, aura and spell-like traits stated only in text; grapple and shove.
- Challenge-rating-aware encounter building (only hand-picked encounters exist).

## 5. Exploration and downtime

- Travel, light and food rules, resting rules variants, crafting, carrying capacity and encumbrance, mounts and vehicles in play.
- Shops and loot using the new item catalog (prices exist for gear only; magic items have no price).
- Skills and tools: tool proficiencies and languages have no effect yet.

## 6. Characters and building

- Builder: fighting style choice, subclass choice at the right level, level-up choices (ASI or feat, new spells known, invocation picks), feats.
- Races: Halfling Lucky, Elf Trance, gnome and elf subrace magic, Half-Elf skill choice already works, languages and tool proficiencies.
- Backgrounds (features, proficiencies, equipment) are not modeled.

## 7. Content quality

- The Traditional Chinese names for monsters, items, spells and magic items are machine-assisted; a human read is needed. `tools/srd/dnd5e-2-spell-audit.json` lists 162 spell names that differ from a reference site.
- Adventure content: only the bundled adventures exist.
- Live checks in Discord (button flows, paging menus, reaction prompts) can only be done by the table.

## Suggested order

1. ~~Cheap primitives first~~ (temporary hit points and creature types): done.
2. **Level-up and builder choices:** the ability score improvement is done; fighting style and subclass choice are not.
3. **Class features 6 to 11** for the classes people play (Fighter, Rogue, Barbarian, Paladin, Cleric, Wizard), using the primitives already built.
4. **Reaction windows** (L), which unlocks the most named features in one go.
5. **Rerolls** (M), then Lucky, Indomitable, Portent.
6. **Lighting and positions** (L each), only if the table wants darkvision and area shapes to matter.
7. **Summons** (L), **sorcery points** (M), **warlock invocations** (M).
8. **Active magic items and monster specials** as the adventures ask for them.
9. **Level 12 to 20** features.
