import type { Glossary } from "../../../../../domain/campaign/rules/content-registry.js";

// Terms follow the plan's terminology survey (docs/dnd-dm-bot-plan.md §7):
// the Traditional-script community term by default, with recorded product
// decisions (倒地 for Prone; 失能 for Incapacitated, pending the BG3 check).
// Spell names below are drafts until the glossary survey covers them.
export const zhTwSrd51Glossary: Glossary = {
  language: "zh-TW",
  names: {
    "condition:incapacitated": "失能",
    "condition:prone": "倒地",
    "condition:frightened": "恐懼",
    "condition:poisoned": "中毒",
    "condition:unconscious": "昏迷",
    "spell:sacred-flame": "聖火術",
    "spell:cure-wounds": "治療傷勢",
    "spell:healing-word": "治療真言",
    "spell:bless": "祝福術",
    // Weapon and monster names are drafts until the terminology survey covers them.
    "item:longsword": "長劍",
    "item:shortsword": "短劍",
    "item:scimitar": "彎刀",
    "item:mace": "硬頭錘",
    "item:morningstar": "釘頭錘",
    "item:shortbow": "短弓",
    "item:potion-of-healing": "治療藥水",
    "item:bite": "啃咬",
    "monster:goblin": "哥布林",
    "monster:wolf": "狼",
    "monster:giant-wolf-spider": "巨型狼蛛",
    "spell:thaumaturgy": "奇術",
    "monster:bugbear": "熊地精",
    "spell:guiding-bolt": "光導箭",
    "item:javelin": "標槍",
    "item:leather-armor": "皮甲",
    "item:chain-mail": "鏈甲",
    "item:shield": "盾牌",
    "feature:fighting-style-dueling": "戰鬥風格：對決",
    "feature:second-wind": "回氣",
    "feature:sneak-attack": "偷襲",
    "feature:thieves-cant": "盜賊黑話",
    "feature:disciple-of-life": "生命門徒",
  },
};
