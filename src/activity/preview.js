import { showRolls } from "./dice.js";

// The design preview has no table to roll for: the result "arrives" a moment after the press. ?natural=20 or ?natural=1 picks the roll.
export function previewRoll(pending) {
  const natural = Number(new URLSearchParams(window.location.search).get("natural")) || 14;
  const total = natural + 3;
  setTimeout(() => showRolls([{ id: pending.checkId, test: pending.test, natural, total, dc: 15, success: total >= 15, moment: natural === 20 ? "natural20" : natural === 1 ? "natural1" : null }]), 1600);
  return {};
}

// Made-up story entries for the preview: a telling, a few actions, a fight line and a call-out, then more that arrive over time with &story-live.
const zhPreview = () => new URLSearchParams(window.location.search).get("language") === "zh-TW";
export function previewStory() {
  const zh = zhPreview();
  return zh ? [
    { id: "e1", kind: "narration", text: "月光穿過坍塌的穹頂，照在灰塵瀰漫的聖堂裡。空氣中有一股潮濕的鐵鏽味。" },
    { id: "e2", kind: "action", mine: true, who: "艾莉亞・維爾", text: "舉起提燈，慢慢走向祭壇。" },
    { id: "e3", kind: "speech", who: "索恩・橡盾", text: "小心腳下。" },
    { id: "e3r", kind: "roll", who: "艾莉亞・維爾", test: { kind: "skill", skill: "arcana" }, total: 17, dc: 15, success: true },
    { id: "e3t", kind: "talk", who: "艾莉亞・維爾", npc: "老雷妮", question: "這間聖堂是誰蓋的？", roll: null, text: "雷妮瞇起眼：「很久以前的僧侶，他們再也沒回來。」" },
    { id: "e3c", kind: "cast", who: "艾莉亞・維爾", spell: "偵測魔法", text: "一聲輕輕的鈴響，符文回應了她，祭壇隨之發亮。" },
    { id: "e4", kind: "narration", text: "符文在燈光下微微發亮。艾莉亞認出這是守衛咒文：祭壇後面有東西在醒來。" },
    { id: "e5", kind: "system", code: "combatBegins", text: null },
    { id: "c6", kind: "combat", who: "霍洛哨兵", using: "石拳", source: "weapon", opportunity: false, targets: [{ name: "艾莉亞・維爾", check: "hit", damage: 8, heal: 0, prone: false }] },
    { id: "c7", kind: "combat", who: "艾莉亞・維爾", using: "魔法飛彈", source: "spell", opportunity: false, targets: [{ name: "霍洛哨兵", check: null, damage: 11, heal: 0, prone: false }] },
    { id: "e8", kind: "narration", text: "哨兵發出低沉的轟鳴，石頭的裂縫中透出藍光。" },
  ] : [
    { id: "e1", kind: "narration", text: "Moonlight falls through the broken dome onto a chapel thick with dust. The air smells of wet iron." },
    { id: "e2", kind: "action", mine: true, who: "Aria Vell", text: "raises the lantern and walks slowly toward the altar." },
    { id: "e3", kind: "speech", who: "Thorne Oakshield", text: "Watch your step." },
    { id: "e3r", kind: "roll", who: "Aria Vell", test: { kind: "skill", skill: "arcana" }, total: 17, dc: 15, success: true },
    { id: "e3t", kind: "talk", who: "Aria Vell", npc: "Old Reni", question: "Who built this chapel?", roll: null, text: "Reni squints. \"Monks, long ago. They never came back.\"" },
    { id: "e3c", kind: "cast", who: "Aria Vell", spell: "Detect Magic", text: "A faint chime rings as the runes answer her, and the altar gleams." },
    { id: "e4", kind: "narration", text: "The runes glow faintly in the lamplight. Aria knows a warding spell when she sees one: something behind the altar is waking." },
    { id: "e5", kind: "system", code: "combatBegins", text: null },
    { id: "c6", kind: "combat", who: "Hollow Sentinel", using: "Stone Fist", source: "weapon", opportunity: false, targets: [{ name: "Aria Vell", check: "hit", damage: 8, heal: 0, prone: false }] },
    { id: "c7", kind: "combat", who: "Aria Vell", using: "Magic Missile", source: "spell", opportunity: false, targets: [{ name: "Hollow Sentinel", check: null, damage: 11, heal: 0, prone: false }] },
    { id: "e8", kind: "narration", text: "The sentinel gives a low rumble, and blue light seeps through the cracks in its stone." },
  ];
}

// What &story-live adds, one after another, so the strip, the badge and the feed can be watched at work.
export function previewStoryNext(n) {
  const zh = zhPreview();
  const steps = zh ? [
    { kind: "combat", who: "霍洛哨兵", using: "石拳", source: "weapon", opportunity: false, targets: [{ name: "索恩・橡盾", check: "miss", damage: 0, heal: 0, prone: false }] },
    { kind: "narration", text: "皮普靠著石柱慢慢站起來，手還在發抖，卻握緊了短弓。長廊盡頭傳來另一種更輕的腳步聲。" },
    { kind: "alert", tone: "down", name: "皮普・林下" },
    { kind: "alert", tone: "slain", name: "霍洛哨兵" },
    { kind: "narration", text: "石像轟然倒下，揚起一片灰塵。聖堂又恢復了寂靜。" },
  ] : [
    { kind: "combat", who: "Hollow Sentinel", using: "Stone Fist", source: "weapon", opportunity: false, targets: [{ name: "Thorne Oakshield", check: "miss", damage: 0, heal: 0, prone: false }] },
    { kind: "narration", text: "Pip pushes up from the pillar, hands still shaking, and tightens a grip on the shortbow. Down the gallery comes another sound, lighter than stone." },
    { kind: "alert", tone: "down", name: "Pip Underbough" },
    { kind: "alert", tone: "slain", name: "Hollow Sentinel" },
    { kind: "narration", text: "The statue topples with a roar and a cloud of dust. The chapel is quiet again." },
  ];
  return { id: `p${n}`, ...steps[n % steps.length] };
}

export function designPreviewSnapshot() {
  const hero = (characterId, name, className, raceName, hp, maxHp, isYou = false) => ({
    characterId, name, className, raceName, level: 5, hp, maxHp, armorClass: 15, presence: "present",
    down: false, fallen: false, conditions: [], isYou, zone: "Shattered dais",
  });
  return {
    classNames: new URLSearchParams(window.location.search).get("language") === "zh-TW" ? { wizard: "法師", paladin: "聖騎士", ranger: "遊俠", rogue: "盜賊", cleric: "牧師", bard: "吟遊詩人" } : {},
    kind: "table", campaignId: "local-preview", campaignName: "The Lantern Company", adventureTitle: "Moonlit Ruins",
    mode: "combat", roundNumber: 4, ownPresence: new URLSearchParams(window.location.search).has("away") ? "away" : "present", canTogglePresence: true, canVoteMove: true,
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
    story: previewStory(),
    yourTurn: true, canBegin: false, activeName: "Aria Vell", upcomingNames: ["Hollow Sentinel", "Thorne Oakshield", "Mira Fen"], partySeats: 6,
    party: [
      { ...hero("aria", "Aria Vell", "Wizard", "High Elf", 27, 34, true), tableStatus: "acting" },
      { ...hero("thorne", "Thorne Oakshield", "Paladin", "Hill Dwarf", 38, 42), tableStatus: "submitted" },
      { ...hero("mira", "Mira Fen", "Ranger", "Wood Elf", 22, 31), tableStatus: "submitted" },
      { ...hero("pip", "Pip Underbough", "Rogue", "Lightfoot Halfling", 19, 28), tableStatus: "waiting" },
      { ...hero("sable", "Sable Dusk", "Cleric", "Tiefling", 29, 33), tableStatus: "waiting" },
      { ...hero("kestrel", "Kestrel Vale", "Bard", "Human", 25, 30), tableStatus: "waiting" },
    ].slice(0, Number(new URLSearchParams(window.location.search).get("party")) || 6),
    foes: [{ name: "Hollow Sentinel", rank: "boss", hp: 18, maxHp: 36, band: "bloodied", zone: "Flooded floor", active: false }, { name: "Drowned Husk A", rank: "minion", hp: 9, maxHp: 22, band: "bloodied", zone: "Flooded floor", active: false }],
    spellFacts: {
      "Fire Bolt": { name: "Fire Bolt", level: 0, school: "evocation", castingTime: "action", range: { kind: "feet", feet: 120 }, concentration: false, ritual: false, relation: "creature", targets: 1, area: false, destination: false, check: "attack", effects: [{ kind: "damage", dice: "1d10", damageType: "fire", half: false }], scales: true, addsModifier: false },
      "Ray of Frost": { name: "Ray of Frost", level: 0, school: "evocation", castingTime: "action", range: { kind: "feet", feet: 60 }, concentration: false, ritual: false, relation: "creature", targets: 1, area: false, destination: false, check: "attack", effects: [{ kind: "damage", dice: "1d8", damageType: "cold", half: false }], scales: true, addsModifier: false },
      "Magic Missile": { name: "Magic Missile", level: 1, school: "evocation", castingTime: "action", range: { kind: "feet", feet: 120 }, concentration: false, ritual: false, relation: "creature", targets: 3, area: false, destination: false, check: "none", effects: [{ kind: "damage", dice: "1d4 + 1", damageType: "force", half: false }], scales: true, addsModifier: false },
      "Shield": { name: "Shield", level: 1, school: "abjuration", castingTime: "reaction", range: { kind: "self" }, concentration: false, ritual: false, relation: "self", targets: 1, area: false, destination: false, check: "none", effects: [{ kind: "other", what: "applyModifiers" }], scales: false, addsModifier: false },
      "Fireball": { name: "Fireball", level: 3, school: "evocation", castingTime: "action", range: { kind: "feet", feet: 150 }, concentration: false, ritual: false, relation: "creature", targets: 1, area: true, destination: false, check: "dex", effects: [{ kind: "damage", dice: "8d6", damageType: "fire", half: true }], scales: true, addsModifier: false },
    },
    allies: [{ name: "Giant Badger", hp: 14, maxHp: 22, condition: "active", zone: "Shattered dais", active: false, ownerName: "Mira Fen" }, { name: "Spiritual Weapon", hp: 1, maxHp: 1, condition: "active", zone: "Flooded floor", active: false, ownerName: "Sable Dusk" }],
    myHero: { ...hero("aria", "Aria Vell", "Wizard", "High Elf", 27, 34, true), imageUrl: null, gold: 18, partyGold: 42, weapons: ["Quarterstaff"], worn: ["Traveler's robe"], pack: [], stash: [], inventoryChoices: [], usablePotions: [], cantrips: ["Fire Bolt", "Ray of Frost"], prepared: ["Shield", "Magic Missile"], slots: [{ level: 1, left: 2, max: 4 }, { level: 2, left: 1, max: 3 }, { level: 3, left: 2, max: 2 }], pactSlots: [], uses: [{ id: "feature:arcane-recovery", name: "Arcane Recovery", left: 1, max: 1 }, { id: "feature:sculpt-spells", name: "Portent", left: 0, max: 2 }] },
    turn: { busy: false, attacks: [{ weapon: "item:quarterstaff", weaponName: "Quarterstaff", targets: [{ id: "sentinel", name: "Hollow Sentinel" }] }], spells: [1, 2, 3].map((slotLevel) => ({ spellId: "spell:magic-missile", spellName: "Magic Missile", slotLevel, slotsLeft: 4 - slotLevel, bonusAction: false, maxTargets: slotLevel + 2, targets: [{ id: "sentinel", name: "Hollow Sentinel" }, { id: "imp", name: "Cinder Imp" }] })), features: [], potions: [], shields: [], moves: [], engage: [], teleports: [], wildShapes: [], wildShapeChoices: [], canRevertShape: false, canWithdraw: false, canDashOrDisengage: true, canDodge: true },
    explore: null, pendingRoll: null, pendingRollCount: 0, submittedCount: 2, participantCount: 6, submission: null, canAcceptInvite: false, joinChoices: [], joinRequestStatus: null, queuedJoin: null,
    savedHeroChoices: [], reaction: null, reactionIsYours: false, smite: null, smiteIsYours: false, opportunityAttack: null, opportunityAttackIsYours: false,
  };
}

