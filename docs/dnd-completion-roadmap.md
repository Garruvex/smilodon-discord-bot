# D&D campaign: what is left to finish the game

Companion to `dnd-mechanics-status.md` (what exists) and `dnd-race-mechanics-status.md`. This page is the plan for what does not:
gaps grouped by the engine primitive they need, with size (S: a day or less, M: a few days, L: a week or more) and what each unlocks.

## 1. Engine primitives (build once, unlock many features)

| Primitive | Size | Unlocks |
|---|---|---|
| **Reaction windows**: "you were hit", "a foe is casting" and "a foe hurt you" are done; "an ally was hit" and "a save is about to be rolled" are not | L | Counterspell, Absorb Elements, Hellish Rebuke, Cutting Words (Lore), Protection fighting style, Sentinel-style feats, Deflect Missiles (Monk 3), Uncanny Dodge already works |
| **Reroll and change a roll after it is made**: attack rolls and saving throws in a fight are done (Halfling Lucky, Indomitable); ability checks, rider saves and concentration saves are not | M | Halfling Lucky, Indomitable (Fighter 9), Portent (Divination), Silvery Barbs-style effects, Bardic Inspiration spent after the roll instead of before it |
| ~~Temporary hit points~~ **done** (combat only; False Life uses it) | S | Still needs Dark One's Blessing (a kill trigger), Heroism's per-turn refresh, Armor of Agathys, Inspiring Leader |
| ~~Creature types~~ **done** (a `creatureType` trait on every SRD monster) | S | Turn Undead and Divine Smite's extra die are built; Holy Avenger, Dragon Slayer, Giant Slayer, Favored Enemy and Protection from Evil and Good can now read it |
| **Lighting and vision**: dark zones and darkvision are done; dim light, Sunlight Sensitivity, Light/Darkness spells and hiding are not | M | Drow Sunlight Sensitivity, Light and Darkness spells, stealth |
| **Positions inside a zone** (range bands, cover, area shapes) | L | Cones, lines, spheres that pick their targets, Sculpt Spells, Fireball versus allies, opportunity-attack reach, cover bonuses |
| **Summons and companions**: the summon effect is done (Conjure Animals); summons end with the fight, not the spell, and the player does not steer them | M | Find Familiar, the other conjure spells, Animate Dead, Spiritual Weapon, Flaming Sphere (these need their own stat blocks or a way to choose what is summoned) |
| ~~Sorcery points and spell modification~~ **done in part** (Font of Magic points, Quickened and Twinned Spell) | S | Other Metamagic options, converting slots and points |
| ~~Warlock invocations~~ **done in part** (Agonizing Blast, Armor of Shadows, Fiendish Vigor, all granted at level 2) | S | Choosing invocations, Pact of the Blade, Hex tie-ins |
| ~~Grapple and shove~~ **done** for the martial classes (a Strength save stands in for the contest) | S | Escaping a grapple, Open Hand riders, Grappler feats, monster swallows |
| **Forms other than Wild Shape** (Polymorph, Shapechange, Wild Shape variants) | M | Polymorph, True Polymorph, Circle of the Moon |
| **Charges and active magic items**: wands, spell scrolls and effect potions are done | M | Staffs (several spells sharing one pool), rods, bags, boots, cursed items |
| **Movement effects**: push is done (Thunderwave); teleport, fly and difficult terrain are not | M | Misty Step, Dimension Door, Fly, Levitate, Step of the Wind's Dash |
| **Hide, search and stealth in combat** | M | Cunning Action's Hide, Skulker, surprise |

## 2. Class features by level (levels 6 to 20, and the parts of 1 to 5 still missing)

Levels 1 to 5 are done for the class core. What each class still needs:

- **Barbarian:** Brutal Critical (6, 9, 13, 17), Mindless Rage, Relentless Rage (11), Persistent Rage (15), Indomitable Might (18), Primal Champion (20), Feral Instinct (7), Path features 6/10/14. Rage's early-end rule. Size: M.
- **Bard:** Bardic Inspiration die scaling with the short-rest recharge at 5, Countercharm (6), Song of Rest (2), Expertise (3, 10), Magical Secrets (10, 14, 18), Superior Inspiration (20), Lore: Cutting Words (needs reactions), Additional Magical Secrets. Size: M.
- **Cleric:** Channel Divinity uses and Turn Undead (needs creature types), Destroy Undead (5), Divine Intervention (10), Domain features at 1/2/6/8/17 (Life domain: Preserve Life pool). Size: M.
- **Druid:** Wild Shape variants (Circle of the Moon), Timeless Body, Beast Spells, Archdruid, Circle of the Land bonus spells. Size: M.
- **Fighter:** Fighting Style choice (Archery, Defense, Great Weapon Fighting, Protection, Two-Weapon Fighting), Indomitable (needs rerolls), Second Wind and Action Surge second uses (17), Champion 7/10/15/18. Size: M.
- **Monk:** Martial Arts dice and unarmed strikes, Flurry of Blows as unarmed strikes, Deflect Missiles, Slow Fall, Stunning Strike (5), Ki-Empowered Strikes, Evasion, Stillness of Mind, Purity of Body, Tongue of the Sun and Moon, Diamond Soul, Timeless Body, Empty Body, Perfect Self, Open Hand riders. Size: L.
- **Paladin:** Aura of Protection (6), Aura of Courage (10), Improved Divine Smite (11), Cleansing Touch (14), Divine Health (3), Oath features (Devotion 7/15/20), Channel Divinity Turn the Unholy. Size: M.
- **Ranger:** Favored Enemy and Natural Explorer (bonuses for their terrain and enemy type), Primeval Awareness, Land's Stride, Hide in Plain Sight, Vanish, Feral Senses, Foe Slayer, Hunter 7/11/15, Beast Master companion (needs summons). Size: L.
- **Rogue:** Expertise, Evasion (7), Reliable Talent (11), Blindsense (14), Slippery Mind (15), Elusive (18), Stroke of Luck (20), Thief 9/13/17, Fast Hands, Second-Story Work. Size: M.
- **Sorcerer:** Font of Magic, Metamagic, Sorcerous Restoration, Draconic Bloodline 6/14/18 (elemental affinity, dragon wings, draconic presence), Sorcerous Origin. Size: L.
- **Warlock:** Pact boons, Eldritch Invocations, Mystic Arcanum (11+), Eldritch Master, The Fiend: Dark One's Blessing, Dark One's Own Luck, Fiendish Resilience, Hurl Through Hell. Size: L.
- **Wizard:** Arcane Tradition features (Evocation: Sculpt Spells, Potent Cantrip, Empowered Evocation, Overchannel), Spell Mastery, Signature Spells. Size: M.
- **All classes:** Ability Score Improvement or feat at 4, 8, 12, 16, 19 (the builder needs a level-up choice for it), multiclass proficiencies and spell slot merging checks. Size: M.

## 3. Spells

- 294 of 319 are mechanical; the other 25 are named only and need the primitives above (terrain, teleport, summons, polymorph forms).
- Reaction spells (Counterspell, Absorb Elements, Hellish Rebuke, Feather Fall, Shield is done).
- Concentration edge cases: Wild Shape and concentration, upcasting on the reaction path.
- Ritual casting and out-of-combat use of utility spells beyond the current set.

## 4. Monsters

- Legendary actions other than weapon attacks (Wing Attack, Detect, Tail Swipe variants), lair actions and regional effects.
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
