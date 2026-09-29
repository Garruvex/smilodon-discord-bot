# D&D mechanics: what is modeled and what is missing

SRD 5.1 only. "Modeled" means the engine decides it; "narrative" means the sheet names it but no rule reads it.
Race and subrace details are also in `dnd-race-mechanics-status.md`.

## Modeled

- Combat: initiative, actions, bonus actions, reactions (Shield), movement and zones, opportunity attacks, advantage and disadvantage, death saves, concentration.
- Monsters: Multiattack, breath weapons with recharge, Regeneration, Legendary Resistance, legendary actions (weapon attacks only), auras (Frightful Presence), spellcasting.
- Spells: all 319 SRD spells exist; 294 are mechanical, and every caster has a spellbook.
- Gear: 187 pieces of equipment, tools, mounts and vehicles.
- Class features:
  - Fighter: Second Wind, Action Surge, Extra Attack (2 to 4), Champion (Improved Critical, Remarkable Athlete).
  - Rogue: Sneak Attack, Cunning Action, Uncanny Dodge.
  - Barbarian: Rage (uses and damage by level), Unarmored Defense, Reckless Attack, Danger Sense, Fast Movement, Berserker Frenzy.
  - Monk: Unarmored Defense, Unarmored Movement, Ki with Flurry of Blows, Patient Defense and Step of the Wind (Disengage only).
  - Paladin: Lay on Hands (on allies too), Divine Smite, Sacred Weapon.
  - Cleric: Preserve Life; Disciple of Life.
  - Bard: Bardic Inspiration (on allies, die grows with level), Jack of All Trades.
  - Druid: Wild Shape (limits by level), Natural Recovery.
  - Wizard: Arcane Recovery. Ranger: Hunter's Colossus Slayer. Sorcerer: Draconic Bloodline.
- Races: ability scores, resistances, save advantage (Fey Ancestry, Brave, Dwarven Resilience, Gnome Cunning), Relentless Endurance, Savage Attacks, Dragonborn Breath Weapon, Tiefling Thaumaturgy.
- Spell-shaped abilities (`featureSpell` trait): class and racial abilities that target creatures use the spell machinery, with uses per rest.

## Missing

### Spells and reactions
- Reaction spells other than Shield (Counterspell, Absorb Elements, Hellish Rebuke): each needs a new reaction window.
- Spells that need terrain, teleporting or summoned creatures.

### Monsters
- Legendary actions that are not attacks (Wing Attack, Detect...).
- Possession and charm gazes.
- Engulf and swallow.
- Creature types, so Turn Undead and Divine Smite's extra die on undead cannot apply.

### Class features
- Levels 6 to 20 for most classes (Indomitable, Evasion, Extra Attack scaling beyond fighter, Brutal Critical, and so on); the level tables stop at 5.
- Subclasses: Lore's Cutting Words, Open Hand riders, Thief, Evocation's Sculpt Spells, Fiend's Dark One's Blessing (no temporary hit points), Turn the Unholy.
- Metamagic and sorcery points, Warlock invocations and pact boons, Bardic Inspiration's rest recharge at level 5.
- Fighting styles other than Dueling (the builder has no choice for them).
- Rage: no early end when the barbarian neither attacks nor is hit; Reckless Attack applies to all attacks, not just Strength melee.
- Flurry of Blows uses the weapon in hand, not unarmed strikes; there are no Martial Arts dice.

### Races
- Halfling Lucky (a reroll needs a new roll request), Elf Trance, gnome and elf subrace magic, Darkvision (no lighting system), languages and tools.

### Items
- Magic items (needs the SRD magic items file; not downloaded).
- Attunement, charges, cursed items.

### Other
- Zh-TW names for monsters, items and spells are machine-assisted and need a human read.
- Live Discord checks only the user can do.
