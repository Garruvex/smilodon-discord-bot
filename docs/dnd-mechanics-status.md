# D&D mechanics: what is modeled and what is missing

SRD 5.1 only. "Modeled" means the engine decides it; "narrative" means the sheet names it but no rule reads it.
Race and subrace details are also in `dnd-race-mechanics-status.md`.

## Modeled

- Combat: initiative, actions, bonus actions, reactions (Shield), movement and zones, opportunity attacks, advantage and disadvantage, death saves, concentration.
- Monsters: Multiattack, breath weapons with recharge, Regeneration, Legendary Resistance, legendary actions (weapon attacks only), auras (Frightful Presence), spellcasting.
- Spells: all 319 SRD spells exist; 162 are narrative (casting spends the slot, the engine changes nothing), the rest have effects, and every caster has a spellbook.
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
- Done: a spell scroll for every castable SRD spell (cast once at the spell's own level, SRD scroll save DC; the use is counted per spell, so two scrolls of one spell share it, and a spent scroll stays in the pack).
- Done: sorcery points (Font of Magic) and two Metamagic options, Quickened and Twinned Spell (readied as a free action that spends 2 points, used up by the next casting). Other options, and converting slots and points, are not modeled.
- Done: warlock invocations Agonizing Blast, Armor of Shadows and Fiendish Vigor (all three granted at warlock level 2; there is no choosing of invocations).
- Done: Reliable Talent (rogue 11).
- Done: Grapple and Shove for the martial classes (the target's Strength save against 8 + proficiency + Strength; a grapple lasts up to ten rounds because escaping is not modeled).
- Done: summons (a `summon` effect: creatures join the party side after the caster, play their own turns like a foe, never count as heroes for victory, XP or loot). Conjure Animals summons two brown bears; they last until the fight ends, or until the caster's concentration ends when the spell needs it. Spiritual Weapon summons a spectral weapon (AC 18, 20 HP, +5, 1d8+3 force) that acts on its own turn; the book makes it untargetable.
- Done: darkvision and dark zones (a zone may be dark; a creature without darkvision, blindsight, tremorsense or truesight attacks in or into it at disadvantage; SRD races and monsters carry the trait). Dim light, hiding in the dark and light spells are not modeled.
- Done: Stunning Strike (monk 5: a free action that readies it for a ki point; the next melee hit calls for a Constitution save against 8 + proficiency + Wisdom, stunned for a round) and Relentless Rage (barbarian 11: once per long rest a raging barbarian dropped to 0 stays up at twice their level in hit points; the SRD save is played as a success).
- Done: a push effect (Thunderwave throws a creature that fails its save into the next zone within 10 feet and farther from the caster, or out of melee if there is none). Teleport (Misty Step) is not modeled.
- Done (levels 6 to 20): every SRD class feature is on the sheet from its level, and these act in the engine: Survivor, Elusive, Indomitable Might, Slippery Mind, Diamond Soul, Primal Champion, a second Action Surge, Divine Strike, Dark One's Blessing, Potent Cantrip, Deflect Missiles (at the die's average), Cutting Words (a Bardic Inspiration use and the reaction, at the die's average, only when it turns a hit into a miss), Aura of Courage and Aura of Devotion (allies in the zone), Empowered Evocation, Overchannel (once), Supreme Healing, Song of Rest, Sorcerous Restoration, Intimidating Presence, Wholeness of Body, Mindless Rage, Elemental Affinity (fire) and Draconic Resilience. Features that only matter outside a fight are named without a rule.
- Done: the Protection fighting style (a neighbor's reaction gives an attack on an ally disadvantage; the shield is not checked). Deflect Missiles, Cutting Words and Protection are applied automatically rather than offered as a prompt, like Uncanny Dodge.
- Done: spell schools (a table from the SRD), cover on a zone (half +2, three-quarters +5 to armor class and Dexterity saves against things from another zone) and Hide (out of every foe's reach, in a zone with cover or darkness; no Stealth roll; the next attack or spell ends it).
- Done: movement effects: `grantMovement` (Misty Step is thirty feet of movement that provokes nothing, in place of a teleport) and a `speedBonus` modifier (Longstrider, Expeditious Retreat, Fly). Difficult terrain and flight itself are not modeled.
- Done: Polymorph and True Polymorph (hostile use only: the target becomes a frog until its hit points run out or concentration ends), the other conjuring spells (Animate Objects, Giant Insect, Conjure Woodland Beings and more, as summons), Hunter's Mark, Web, Resistance, Magic Weapon, Stoneskin, Mirror Image, Enlarge, Lesser and Greater Restoration, Calm Emotions, and escaping a grapple (always works, costs the action).
- Done: Metamagic Heightened, Empowered, Extended and Subtle (granted at sorcerer 10 and 17), and Flexible Casting (sorcery points into a spell slot).
- Done: staffs (Fire, Frost, Healing, Power) draw several spells from one pool of charges; Magic Resistance, Blood Frenzy and Sunlight Sensitivity on the SRD monsters.
- Dragon Scale Mail, Armor of Resistance and Adamantine Armor are named but give nothing yet.

### Other
- Zh-TW names for monsters, items and spells are machine-assisted and need a human read.
- Live Discord checks only the user can do.
