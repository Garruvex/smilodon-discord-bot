# D&D mechanics: what is modeled and what is missing

SRD 5.1 only. "Modeled" means the engine decides it; "narrative" means the sheet names it but no rule reads it.
Race and subrace details are also in `dnd-race-mechanics-status.md`.

## Modeled

- Combat: initiative, actions, bonus actions, reactions (Shield), movement and zones, opportunity attacks, advantage and disadvantage, death saves, concentration.
- Monsters: Multiattack, breath weapons with recharge, Regeneration, Legendary Resistance, legendary actions (weapon attacks only), auras (Frightful Presence), spellcasting.
- Spells: all 319 SRD spells exist; 294 are mechanical, and every caster has a spellbook.
- Gear: 187 pieces of equipment, tools, mounts and vehicles.
- Magic items: all 331 non-generic SRD magic items exist with names in both languages, plus +1 to +3 versions of every weapon, armor and shield. Modeled: those bonuses, named weapons (Flame Tongue, Frost Brand, Sun Blade...), Elven Chain, Dwarven Plate, Animated Shield, the healing potions above the basic one, Ring/Cloak of Protection, ability-setting items (Belt of Giant Strength, Amulet of Health, Gauntlets of Ogre Power, Headband of Intellect), resistance rings, Ring of Warmth, Brooch of Shielding, spell-resistance items and attunement (at most three). The rest are for the story.
- Class features:
  - Fighter: Second Wind, Action Surge, Extra Attack (2 to 4), Champion (Improved Critical, Remarkable Athlete).
  - Rogue: Sneak Attack, Cunning Action, Uncanny Dodge.
  - Barbarian: Rage (uses and damage by level), Unarmored Defense, Reckless Attack, Danger Sense, Fast Movement, Berserker Frenzy.
  - Monk: Unarmored Defense, Unarmored Movement, Ki with Flurry of Blows, Patient Defense and Step of the Wind (Disengage only).
  - Paladin: Lay on Hands (on allies too), Divine Smite, Sacred Weapon.
  - Cleric: Preserve Life and Turn Undead (one shared Channel Divinity use); Disciple of Life.
  - Bard: Bardic Inspiration (on allies, die grows with level), Jack of All Trades.
  - Druid: Wild Shape (limits by level), Natural Recovery.
  - Wizard: Arcane Recovery. Ranger: Hunter's Colossus Slayer. Sorcerer: Draconic Bloodline.
- Races: ability scores, resistances, save advantage (Fey Ancestry, Brave, Dwarven Resilience, Gnome Cunning), Relentless Endurance, Savage Attacks, Dragonborn Breath Weapon, Tiefling Thaumaturgy.
- Levels 6 to 18, the parts that need no new primitive: Evasion (rogue and monk 7), Brutal Critical (barbarian 9/13/17), Aura of Protection (paladin 6, for allies in the same zone), Aura of Courage (paladin 10, the paladin only), Improved Divine Smite (paladin 11), Purity of Body and the growing Unarmored Movement (monk), Superior Critical (fighter 15).
- Potions with effects: Resistance (each damage type), Heroism (10 temporary hit points), Speed (+2 armor class, Dexterity save advantage), Growth (+2 melee damage) and Invisibility, worked through the spell pipeline when drunk in a fight. Giant Strength, Flying and the rest are still for the story.
- Reaction spells: Shield (a hit), Counterspell (a spell a foe is casting; the slot must be at least the spell's level, so no ability check is rolled) and Hellish Rebuke (after a foe damages the hero, within 60 feet). Each opens a card the hero's player answers, or the timer declines.
- Rerolls: a Halfling rerolls a natural 1 on an attack or save, and a fighter's Indomitable (level 9, then 13 and 17) rerolls a failed save, both automatically. Fighting Style can be swapped in the level-up form (Dueling, Archery, Defense).
- Creature types on every SRD monster; Divine Smite rolls an extra die against undead and fiends. Temporary hit points exist in combat (False Life); they are taken before real hit points and are not shown on the party card yet.
- Spell-shaped abilities (`featureSpell` trait): class and racial abilities that target creatures use the spell machinery, with uses per rest.

## Missing

### Spells and reactions
- Reaction spells: Absorb Elements is not in the SRD; Feather Fall needs falling; Cutting Words and Deflect Missiles are not built.
- Spells that need terrain, teleporting or summoned creatures.

### Monsters
- Legendary actions that are not attacks (Wing Attack, Detect...).
- Possession and charm gazes.
- Engulf and swallow.

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
- Magic items with active powers: staffs, rods, bags, boots, spell scrolls, conditional weapon effects (Dragon Slayer, Holy Avenger), charges, cursed items.
- Done: effect potions and charged wands (Magic Missile, Fireball, Lightning Bolt, Fear, Hold Person at save DC 15, seven charges).
- Dragon Scale Mail, Armor of Resistance and Adamantine Armor are named but give nothing yet.

### Other
- Zh-TW names for monsters, items and spells are machine-assisted and need a human read.
- Live Discord checks only the user can do.
