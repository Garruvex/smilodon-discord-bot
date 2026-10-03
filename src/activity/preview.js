import { showRolls } from "./dice.js";

// The design preview has no table to roll for: the result "arrives" a moment after the press. ?natural=20 or ?natural=1 picks the roll.
export function previewRoll(pending) {
  const natural = Number(new URLSearchParams(window.location.search).get("natural")) || 14;
  const total = natural + 3;
  setTimeout(() => showRolls([{ id: pending.checkId, test: pending.test, natural, total, dc: 15, success: total >= 15, moment: natural === 20 ? "natural20" : natural === 1 ? "natural1" : null }]), 1600);
  return {};
}

export function designPreviewSnapshot() {
  const hero = (characterId, name, className, raceName, hp, maxHp, isYou = false) => ({
    characterId, name, className, raceName, level: 5, hp, maxHp, armorClass: 15, presence: "present",
    down: false, fallen: false, conditions: [], isYou,
  });
  return {
    classNames: new URLSearchParams(window.location.search).get("language") === "zh-TW" ? { wizard: "法師", paladin: "聖騎士", ranger: "遊俠", rogue: "盜賊", cleric: "牧師", bard: "吟遊詩人" } : {},
    kind: "table", campaignId: "local-preview", campaignName: "The Lantern Company", adventureTitle: "Moonlit Ruins",
    mode: "combat", roundNumber: 4, ownPresence: "present", canTogglePresence: true, canVoteMove: true,
    scene: { title: "The Drowned Observatory", description: "Cold moonlight spills through the broken dome. Something stirs beneath the flooded floor.", imageUrl: null },
    map: new URLSearchParams(window.location.search).has("journey") ? { kind: "journey", nodes: [
      { id: "entrance", title: "The Old Hall", column: 0, row: 1, status: "visited", canTravel: false, deadEnd: false },
      { id: "current", title: "The Drowned Observatory", column: 1, row: 1, status: "current", canTravel: false, deadEnd: false },
      { id: "gallery", title: "Broken Gallery", column: 2, row: 0, status: "reachable", canTravel: true, deadEnd: false },
      { id: "vault", title: "The Lower Vault", column: 2, row: 1, status: "known", canTravel: false, deadEnd: false },
      { id: "sanctum", title: "Moonlit Sanctum", column: 2, row: 2, status: "reachable", canTravel: true, deadEnd: true },
      { id: "unknown", title: "???", column: 3, row: 1, status: "locked", canTravel: false, deadEnd: false },
    ], routes: [{ from: "entrance", to: "current", oneWay: false }, { from: "current", to: "gallery", oneWay: false }, { from: "current", to: "vault", oneWay: false }, { from: "current", to: "sanctum", oneWay: true }, { from: "vault", to: "unknown", oneWay: false }] } : { kind: "battlefield", edges: [{ from: "shattered-dais", to: "flooded-floor", feet: 30 }, { from: "flooded-floor", to: "broken-gallery", feet: 25 }], zones: [
      { id: "shattered-dais", name: "Shattered dais", lighting: "Moonlit", cover: "half", difficult: false, canMove: true, occupants: [{ name: "Aria", side: "party", active: true, hp: 27, maxHp: 34 }] },
      { id: "flooded-floor", name: "Flooded floor", lighting: "Dim", cover: null, difficult: true, canMove: false, occupants: [{ name: "Hollow Sentinel", side: "foes", rank: "boss", active: true, hp: 18, maxHp: 36 }] },
      { id: "broken-gallery", name: "Broken gallery", lighting: "Dark", cover: "three-quarters", difficult: false, canMove: true, occupants: [{ name: "Thorne", side: "party", active: false, hp: 38, maxHp: 42 }] },
    ] },
    mapText: { journeyKind: "THE JOURNEY", journeyTitle: "Adventure map", tacticalKind: "TACTICAL VIEW", battlefield: "Battlefield", keyParty: "Party", keyFoes: "Foes", keyHere: "Here", keyOpen: "Open route", keyLocked: "Locked", empty: "No mapped routes are known yet.", routeLabel: "Route", here: "You are here", deadEnd: "Dead end", locked: "Locked", visited: "Visited", mapped: "Mapped", openRoute: "Open route", openGround: "Open ground", difficult: "Difficult terrain", coverHalf: "Half cover", coverThreeQuarters: "Three-quarters cover", lightBright: "Bright", lightDim: "Dim", lightDark: "Dark", moveHere: "Move here" },
    yourTurn: true, canBegin: false, activeName: "Aria Vell", upcomingNames: ["Hollow Sentinel", "Thorne Oakshield", "Mira Fen"],
    party: [
      { ...hero("aria", "Aria Vell", "Wizard", "High Elf", 27, 34, true), tableStatus: "acting" },
      { ...hero("thorne", "Thorne Oakshield", "Paladin", "Hill Dwarf", 38, 42), tableStatus: "submitted" },
      { ...hero("mira", "Mira Fen", "Ranger", "Wood Elf", 22, 31), tableStatus: "submitted" },
      { ...hero("pip", "Pip Underbough", "Rogue", "Lightfoot Halfling", 19, 28), tableStatus: "waiting" },
      { ...hero("sable", "Sable Dusk", "Cleric", "Tiefling", 29, 33), tableStatus: "waiting" },
      { ...hero("kestrel", "Kestrel Vale", "Bard", "Human", 25, 30), tableStatus: "waiting" },
    ],
    foes: [{ name: "Hollow Sentinel", rank: "boss", hp: 18, maxHp: 36, band: "bloodied", zone: "Flooded floor", active: false }],
    myHero: { ...hero("aria", "Aria Vell", "Wizard", "High Elf", 27, 34, true), imageUrl: null, gold: 18, partyGold: 42, weapons: ["Quarterstaff"], worn: ["Traveler's robe"], pack: [], stash: [], inventoryChoices: [], usablePotions: [], cantrips: ["Fire Bolt", "Ray of Frost"], prepared: ["Shield", "Magic Missile"], slots: [{ level: 1, left: 2, max: 4 }, { level: 2, left: 1, max: 3 }, { level: 3, left: 2, max: 2 }], pactSlots: [], uses: [{ id: "feature:arcane-recovery", name: "Arcane Recovery", left: 1, max: 1 }, { id: "feature:sculpt-spells", name: "Portent", left: 0, max: 2 }] },
    turn: { busy: false, attacks: [{ weapon: "item:quarterstaff", weaponName: "Quarterstaff", targets: [{ id: "sentinel", name: "Hollow Sentinel" }] }], spells: [1, 2, 3].map((slotLevel) => ({ spellId: "spell:magic-missile", spellName: "Magic Missile", slotLevel, slotsLeft: 4 - slotLevel, bonusAction: false, maxTargets: slotLevel + 2, targets: [{ id: "sentinel", name: "Hollow Sentinel" }, { id: "imp", name: "Cinder Imp" }] })), features: [], potions: [], shields: [], moves: [], engage: [], teleports: [], wildShapes: [], wildShapeChoices: [], canRevertShape: false, canWithdraw: false, canDashOrDisengage: true, canDodge: true },
    explore: null, pendingRoll: null, pendingRollCount: 0, submittedCount: 2, participantCount: 6, submission: null, canAcceptInvite: false, joinChoices: [], joinRequestStatus: null, queuedJoin: null,
    savedHeroChoices: [], reaction: null, reactionIsYours: false, smite: null, smiteIsYours: false, opportunityAttack: null, opportunityAttackIsYours: false,
  };
}

