import { app } from "./state.js";
import { t } from "./i18n.js";

// A small rulebook for people new to the game, after SRD 5.1 (2014) as written. The words are the table's reference, not rules the screen decides:
// the engine decides every outcome. Each entry: [id, section, English title, English text, Chinese title, Chinese text].
const sections = ["actions", "turn", "rolls", "hurt", "conditions"];
const entries = [
  ["attack", "actions", "Attack", "Make one melee or ranged attack. Roll a d20 and add your bonus; if the total meets or beats the target's Armor Class (AC), it hits and deals damage. A natural 20 on an attack roll is a critical hit (the damage dice are rolled twice); a natural 1 always misses.", "攻擊", "進行一次近戰或遠程攻擊。擲 d20 加上攻擊加值，總和達到或超過目標的護甲等級（AC）就命中並造成傷害。攻擊骰擲出自然 20 為重擊（傷害骰擲兩次），自然 1 一定未命中。"],
  ["cast", "actions", "Cast a spell", "Spend the spell's casting time (usually one action) and, for a leveled spell, a spell slot. Cantrips cost no slot. Some spells need a roll to hit; others make the target roll a saving throw.", "施展法術", "花費法術的施法時間（通常是一個動作），有環級的法術還要消耗一個法術位；戲法不消耗法術位。有些法術要擲攻擊骰，有些則讓目標進行豁免。"],
  ["dash", "actions", "Dash", "Gain extra movement for this turn, equal to your speed.", "疾走", "本回合額外獲得等同你速度的移動距離。"],
  ["disengage", "actions", "Disengage", "Your movement for the rest of this turn does not provoke opportunity attacks.", "撤離", "本回合其餘的移動不會引發藉機攻擊。"],
  ["dodge", "actions", "Dodge", "Until the start of your next turn, attack rolls against you have disadvantage if you can see the attacker, and you make Dexterity saving throws with advantage. You lose this if you are incapacitated or your speed is 0.", "閃避", "直到你下個回合開始前，只要你看得見攻擊者，對你的攻擊骰有劣勢，你的敏捷豁免有優勢。若你失能或速度為 0 就失去此效果。"],
  ["help", "actions", "Help", "Aid another creature. Their next ability check for that task has advantage; or, if you help an ally attack a creature within 5 feet of you, their next attack roll against it has advantage before your next turn.", "協助", "幫助另一個生物。他下一次進行該任務的屬性檢定有優勢；若協助盟友攻擊你 5 呎內的生物，他在你下個回合前對該生物的下一次攻擊骰有優勢。"],
  ["hide", "actions", "Hide", "Make a Dexterity (Stealth) check to slip out of sight. It only works if nothing can see you.", "躲藏", "進行敏捷（隱匿）檢定來藏起身形；只有在沒有任何東西看得見你時才有用。"],
  ["ready", "actions", "Ready", "Pick a trigger and an action. When the trigger happens before your next turn, you can spend your reaction to take that action.", "預備", "選一個觸發條件和一個動作；在你下個回合前觸發時，可以用反應執行該動作。"],
  ["search", "actions", "Search", "Look for something with a Wisdom (Perception) or Intelligence (Investigation) check.", "搜尋", "用感知（察覺）或智力（調查）檢定尋找東西。"],

  ["turn", "turn", "Your turn", "On your turn you can move up to your speed and take one action. You may split the move before and after the action.", "你的回合", "輪到你時，可以移動至多等同速度的距離，並進行一個動作；移動可以拆在動作前後。"],
  ["bonus", "turn", "Bonus action", "Only if a feature or spell gives you one. You get at most one bonus action per turn.", "附贈動作", "只有特性或法術賦予時才能用；每回合最多一個附贈動作。"],
  ["reaction", "turn", "Reaction", "A quick response to a trigger, on or off your turn. You get one reaction per round; it comes back at the start of your turn.", "反應", "對某個觸發做出的即時回應，不論是否在你的回合；每輪只有一次反應，在你的回合開始時恢復。"],
  ["opportunity", "turn", "Opportunity attack", "When a creature you can see moves out of your reach, you can use your reaction to make one melee attack against it. Disengage avoids this.", "藉機攻擊", "你看得見的生物離開你的觸及範圍時，你可以用反應對他進行一次近戰攻擊；撤離可以避免。"],
  ["cover", "turn", "Cover", "Half cover gives +2 to AC and Dexterity saves; three-quarters cover gives +5. A target with total cover cannot be targeted directly.", "掩蔽", "半掩蔽使 AC 與敏捷豁免 +2；四分之三掩蔽 +5；完全掩蔽的目標不能被直接選為目標。"],
  ["concentration", "turn", "Concentration", "Some spells last only while you concentrate. You can concentrate on one at a time. Taking damage forces a Constitution save (DC 10 or half the damage, whichever is higher) or the spell ends.", "專注", "有些法術只在你專注時持續，一次只能專注於一個。受到傷害時要做體質豁免（DC 取 10 或傷害的一半，較高者），失敗則法術結束。"],

  ["check", "rolls", "Ability check", "Roll a d20, add the ability modifier, and add your proficiency bonus if you are proficient in the skill. Meet or beat the DC to succeed. A natural 20 or 1 on a check has no special effect.", "屬性檢定", "擲 d20，加上屬性調整值；若你熟練該技能再加熟練加值。達到或超過 DC 就成功。檢定擲出自然 20 或 1 沒有特殊效果。"],
  ["save", "rolls", "Saving throw", "A roll to resist something, made with the matching ability (a Dexterity save to dodge a fireball, a Constitution save to resist poison). Same math as a check, against the effect's DC.", "豁免", "用來抵抗某件事的擲骰，使用對應的屬性（敏捷豁免躲火球、體質豁免抵抗毒）。算法與檢定相同，對抗效果的 DC。"],
  ["dc", "rolls", "Difficulty class (DC)", "The number to beat: very easy 5, easy 10, medium 15, hard 20, very hard 25, nearly impossible 30.", "難度等級（DC）", "要達到的數字：非常容易 5、容易 10、中等 15、困難 20、非常困難 25、幾乎不可能 30。"],
  ["advantage", "rolls", "Advantage and disadvantage", "Advantage: roll two d20 and take the higher. Disadvantage: take the lower. They do not stack, and if you have both they cancel out.", "優勢與劣勢", "優勢：擲兩顆 d20 取較高者；劣勢：取較低者。不會疊加，兩者同時存在則互相抵消。"],

  ["hp", "hurt", "Hit points", "How much damage you can take. At 0 you fall unconscious (or die outright from massive damage). Healing never goes above your maximum.", "生命值", "你能承受的傷害。降到 0 就會失去意識（若是巨量傷害則直接死亡）；治療不會超過最大生命值。"],
  ["temp", "hurt", "Temporary hit points", "A buffer that takes damage first. It does not add up with other temporary hit points (keep the larger) and cannot be healed.", "臨時生命值", "會先承受傷害的緩衝；不同來源不疊加（取較大者），也不能被治療補回。"],
  ["death", "hurt", "Death saving throws", "At 0 HP you roll a d20 at the start of each of your turns: 10 or more is a success, 9 or less a failure. A natural 20 brings you back with 1 HP; a natural 1 counts as two failures. Three successes make you stable, three failures kill you. Damage at 0 HP is a failure.", "死亡豁免", "降到 0 生命值時，每個你的回合開始擲 d20：10 以上成功，9 以下失敗。自然 20 以 1 點生命值醒來；自然 1 算兩次失敗。三次成功穩定下來，三次失敗死亡；在 0 生命值時受傷算一次失敗。"],
  ["shortrest", "hurt", "Short rest", "At least one hour of light activity. You can spend Hit Dice to heal, and some abilities come back.", "短休", "至少一小時的輕度活動。可以花費生命骰恢復生命值，部分能力也會恢復。"],
  ["longrest", "hurt", "Long rest", "At least eight hours (up to two hours of light activity). You regain all hit points and half your total Hit Dice, and most abilities and spell slots return.", "長休", "至少八小時（其中最多兩小時輕度活動）。恢復所有生命值與一半的生命骰，大部分能力與法術位也會恢復。"],

  ["prone", "conditions", "Prone", "You crawl. Attacks against you have advantage from within 5 feet and disadvantage from farther away; your own attacks have disadvantage. Standing up costs half your movement.", "倒地", "你只能爬行。5 呎內對你的攻擊有優勢，更遠則有劣勢；你自己的攻擊有劣勢。站起來要花一半的移動力。"],
  ["poisoned", "conditions", "Poisoned", "Disadvantage on attack rolls and ability checks.", "中毒", "攻擊骰與屬性檢定有劣勢。"],
  ["frightened", "conditions", "Frightened", "Disadvantage on ability checks and attacks while the source of fear is in sight, and you cannot willingly move closer to it.", "恐慌", "只要看得見恐懼的來源，屬性檢定與攻擊骰有劣勢，且不能自願靠近它。"],
  ["grappled", "conditions", "Grappled", "Your speed becomes 0. It ends if the grappler is incapacitated or you are moved out of its reach.", "受到擒抱", "你的速度變為 0。擒抱者失能，或你被移出他的觸及範圍時結束。"],
  ["restrained", "conditions", "Restrained", "Speed 0. Attacks against you have advantage, your attacks have disadvantage, and you have disadvantage on Dexterity saves.", "束縛", "速度為 0。對你的攻擊有優勢，你的攻擊有劣勢，敏捷豁免有劣勢。"],
  ["blinded", "conditions", "Blinded", "You cannot see and fail checks that need sight. Attacks against you have advantage; your attacks have disadvantage.", "目盲", "你看不見，需要視覺的檢定自動失敗。對你的攻擊有優勢，你的攻擊有劣勢。"],
  ["charmed", "conditions", "Charmed", "You cannot attack the charmer or target them with harmful effects, and the charmer has advantage on social checks against you.", "魅惑", "你不能攻擊魅惑你的人，也不能對他使用有害效果；他對你的社交檢定有優勢。"],
  ["incapacitated", "conditions", "Incapacitated", "You cannot take actions or reactions.", "失能", "你不能進行動作或反應。"],
  ["stunned", "conditions", "Stunned", "Incapacitated, cannot move, and you can barely speak. You automatically fail Strength and Dexterity saves, and attacks against you have advantage.", "震懾", "失能、不能移動，只能勉強說話。力量與敏捷豁免自動失敗，對你的攻擊有優勢。"],
  ["paralyzed", "conditions", "Paralyzed", "Incapacitated and cannot move or speak. Strength and Dexterity saves fail automatically; attacks against you have advantage, and a hit from within 5 feet is a critical hit.", "麻痺", "失能，不能移動或說話。力量與敏捷豁免自動失敗；對你的攻擊有優勢，5 呎內命中就是重擊。"],
  ["unconscious", "conditions", "Unconscious", "Incapacitated, prone, unaware. Attacks against you have advantage, and a hit from within 5 feet is a critical hit.", "昏迷", "失能、倒地、毫無知覺。對你的攻擊有優勢，5 呎內命中就是重擊。"],
  ["exhaustion", "conditions", "Exhaustion", "Six levels, each worse than the last: disadvantage on checks, speed halved, disadvantage on attacks and saves, hit point maximum halved, speed 0, death. A long rest removes one level.", "力竭", "共六級，逐級加重：檢定劣勢、速度減半、攻擊與豁免劣勢、生命值上限減半、速度為 0、死亡。每次長休降低一級。"],
];

const zh = () => app.uiLanguage === "zh-TW";
const dialog = () => document.querySelector("#rules-book");

function card(entry) {
  const [id, , enTitle, enText, zhTitle, zhText] = entry;
  const item = document.createElement("details");
  item.className = "rules-entry";
  item.id = `rules-${id}`;
  const head = document.createElement("summary");
  head.textContent = zh() ? zhTitle : enTitle;
  const body = document.createElement("p");
  body.textContent = zh() ? zhText : enText;
  item.append(head, body);
  item.dataset.search = `${enTitle} ${enText} ${zhTitle} ${zhText}`.toLocaleLowerCase();
  return item;
}

function paint() {
  const list = document.querySelector("#rules-list");
  list.replaceChildren(...sections.flatMap((section) => {
    const group = entries.filter((entry) => entry[1] === section);
    const heading = document.createElement("h3");
    heading.textContent = t(`activity.rules.section.${section}`);
    heading.dataset.section = section;
    return [heading, ...group.map(card)];
  }));
  filter(document.querySelector("#rules-search").value);
}

// Typing narrows the list; a heading stays only while something under it matches.
function filter(query) {
  const needle = query.trim().toLocaleLowerCase();
  const list = document.querySelector("#rules-list");
  let matches = 0;
  for (const item of list.querySelectorAll(".rules-entry")) {
    const show = needle === "" || item.dataset.search.includes(needle);
    item.hidden = !show;
    if (show) matches += 1;
    if (needle !== "") item.open = show;
  }
  for (const heading of list.querySelectorAll("h3")) {
    let next = heading.nextElementSibling;
    let any = false;
    while (next !== null && next.tagName !== "H3") { if (!next.hidden) any = true; next = next.nextElementSibling; }
    heading.hidden = !any;
  }
  document.querySelector("#rules-empty").hidden = matches !== 0;
}

// Opens the book, on an entry when one is named.
export function openRules(entryId) {
  const box = dialog();
  if (box === null) return;
  document.querySelector("#rules-search").value = "";
  paint();
  if (!box.open) box.showModal();
  const target = entryId === undefined ? null : box.querySelector(`#rules-${entryId}`);
  if (target !== null) { target.open = true; target.scrollIntoView({ block: "start" }); }
}

export function wireRulesBook() {
  const box = dialog();
  if (box === null) return;
  document.querySelector("#rules-open").addEventListener("click", () => openRules());
  document.querySelector("#rules-close").addEventListener("click", () => box.close());
  box.addEventListener("click", (event) => { if (event.target === box) box.close(); });
  document.querySelector("#rules-search").addEventListener("input", (event) => filter(event.target.value));
}
